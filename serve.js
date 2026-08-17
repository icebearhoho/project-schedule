// Static files + the shared plan API, for running as a normal long-lived server
// (locally, on a LAN box, Render, Railway, a VPS). No dependencies: node serve.js
//
// Storage lives in storage.js: a local JSON file by default, or a GitHub repo when
// GITHUB_TOKEN + GITHUB_REPO are set (needed on hosts without a persistent disk).
//
//   PORT           listen port (default 5173)
//   PLANNER_TOKEN  if set, clients must send it as ?key= or X-Key (shared team password)
//   DATA_FILE / GITHUB_* see storage.js
const http = require('http'), fs = require('fs'), path = require('path');
const storage = require('./storage');

const PORT = process.env.PORT || 5173;
const TOKEN = process.env.PLANNER_TOKEN || '';

let state = { rev: 0, data: null, sha: null }; // data = { projects: [...], nextPid }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const publicPart = s => ({ rev: s.rev, data: s.data, at: s.at });
const readBody = req => new Promise(ok => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => ok(b));
});

// Publishes run one at a time. Between checking the revision and finishing the write
// there is an await (a GitHub round trip, in the deployed setup), and without this a
// second publish could pass the same check and both users would be told they succeeded.
let chain = Promise.resolve();
const exclusive = fn => { const p = chain.then(fn, fn); chain = p.catch(() => { }); return p; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/data' || url.pathname === '/api/project') {
    if (TOKEN && (req.headers['x-key'] || url.searchParams.get('key')) !== TOKEN) return json(res, 401, { error: 'bad key' });
    if (req.method === 'GET') return json(res, 200, publicPart(state));
    if (req.method !== 'PUT') return json(res, 405, { error: 'method' });

    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    if (!b || typeof b.data !== 'object' || !b.data || !Array.isArray(b.data.projects)) return json(res, 400, { error: 'no projects' });
    return exclusive(async () => {
      // Stale write: someone else saved since this client loaded. Hand back the current copy.
      if (state.rev !== 0 && b.rev !== state.rev) return json(res, 409, publicPart(state));

      const next = { rev: state.rev + 1, data: b.data, at: new Date().toISOString() };
      try {
        next.sha = await storage.save(next, state.sha);
      } catch (e) {
        if (e.conflict) { state = await storage.load(); return json(res, 409, publicPart(state)); }
        return json(res, 503, { error: String(e.message || e) }); // never report a save that didn't happen
      }
      state = next;
      return json(res, 200, { rev: state.rev });
    });
  }

  const file = path.join(__dirname, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
  fs.readFile(file, (e, b) => e ? res.writeHead(404).end('not found')
    : res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' }).end(b));
});

// Load storage BEFORE accepting requests: serving an empty plan while the real one is
// still loading would let the first publish overwrite it.
storage.load().then(s => {
  state = s;
  server.listen(PORT, () => console.log('http://localhost:' + PORT + '  (storing in ' + storage.describe() + ')' +
    (TOKEN ? ', token required' : '')));
}, e => {
  console.error('Storage unreachable, refusing to start with an empty plan:', e.message);
  process.exit(1);
});
