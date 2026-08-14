// Static files + shared project storage. No dependencies: node serve.js
//   PORT           listen port (default 5173)
//   DATA_FILE      where the shared project is stored (default ./project.json)
//   PLANNER_TOKEN  if set, clients must send it as ?key= or X-Key (shared team password)
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = process.env.PORT || 5173;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'project.json');
const TOKEN = process.env.PLANNER_TOKEN || '';

let state = { rev: 0, project: null };
try { state = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { /* first run */ }

function persist() { // atomic: survives a crash mid-write
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(state));
  fs.renameSync(DATA + '.tmp', DATA);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/project') {
    if (TOKEN && (req.headers['x-key'] || url.searchParams.get('key')) !== TOKEN) return json(res, 401, { error: 'bad key' });
    if (req.method === 'GET') return json(res, 200, state);
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on('end', () => {
        let b; try { b = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        if (!b || typeof b.project !== 'object' || !b.project) return json(res, 400, { error: 'no project' });
        // Stale write: someone else saved since this client loaded. Hand back the current copy.
        if (state.rev !== 0 && b.rev !== state.rev) return json(res, 409, state);
        state = { rev: state.rev + 1, project: b.project, at: new Date().toISOString() };
        persist();
        json(res, 200, { rev: state.rev });
      });
      return;
    }
    return json(res, 405, { error: 'method' });
  }

  const file = path.join(__dirname, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
  fs.readFile(file, (e, b) => e ? res.writeHead(404).end('not found')
    : res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' }).end(b));
}).listen(PORT, () => console.log('http://localhost:' + PORT + (TOKEN ? '  (token required)' : '')));
