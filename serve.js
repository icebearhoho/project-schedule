// Static files + shared project storage. No dependencies: node serve.js
//
// Storage is a local JSON file by default. Set GITHUB_TOKEN + GITHUB_REPO and the plan
// is kept in a GitHub repo instead, which is what makes free hosting work: hosts like
// Render's free plan wipe their filesystem on every restart, GitHub doesn't.
//
//   PORT           listen port (default 5173)
//   DATA_FILE      local storage path (default ./project.json)
//   PLANNER_TOKEN  if set, clients must send it as ?key= or X-Key (shared team password)
//   GITHUB_TOKEN   fine-grained token with Contents: read+write on the repo
//   GITHUB_REPO    owner/name, e.g. icebearhoho/project-schedule
//   GITHUB_BRANCH  branch the plan is committed to (default plan-data, kept off main so
//                  publishing doesn't trigger a redeploy)
//   GITHUB_PATH    file in that branch (default plan.json)
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = process.env.PORT || 5173;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'project.json');
const TOKEN = process.env.PLANNER_TOKEN || '';
const GH = {
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
  branch: process.env.GITHUB_BRANCH || 'plan-data',
  path: process.env.GITHUB_PATH || 'plan.json',
  api: process.env.GITHUB_API || 'https://api.github.com',
};
const useGh = !!(GH.token && GH.repo);

let state = { rev: 0, data: null }; // data = { projects: [...], nextPid }
let ghSha = null;                   // GitHub's version marker for our file

function migrate(s) {
  if (s && s.project && !s.data) { s.data = { projects: [s.project], nextPid: 2 }; delete s.project; }
  return s;
}

/* ---- GitHub storage ---- */
async function gh(p, opts) {
  const r = await fetch(GH.api + p, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + GH.token, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'project-planner',
    },
  });
  return { code: r.status, body: await r.json().catch(() => null) };
}

async function ghEnsureBranch() {
  if ((await gh(`/repos/${GH.repo}/git/ref/heads/${GH.branch}`)).code === 200) return;
  const head = await gh(`/repos/${GH.repo}/git/refs/heads`);
  const first = Array.isArray(head.body) && head.body[0];
  if (!first) return; // empty repo: the first save creates the branch itself
  await gh(`/repos/${GH.repo}/git/refs`, {
    method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + GH.branch, sha: first.object.sha }),
  });
}

async function ghLoad() {
  const r = await gh(`/repos/${GH.repo}/contents/${GH.path}?ref=${GH.branch}`);
  if (r.code === 200) {
    ghSha = r.body.sha;
    return migrate(JSON.parse(Buffer.from(r.body.content, 'base64').toString('utf8')));
  }
  if (r.code === 404) { await ghEnsureBranch(); return null; }
  throw new Error('GitHub read failed: ' + r.code + ' ' + (r.body && r.body.message));
}

async function ghSave(s) {
  const body = {
    message: 'Plan rev ' + s.rev, branch: GH.branch,
    content: Buffer.from(JSON.stringify(s, null, 2)).toString('base64'),
  };
  if (ghSha) body.sha = ghSha;
  const r = await gh(`/repos/${GH.repo}/contents/${GH.path}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.code === 200 || r.code === 201) { ghSha = r.body.content.sha; return; }
  if (r.code === 409 || r.code === 422) { // another instance wrote first: take theirs
    const fresh = await ghLoad();
    if (fresh) state = fresh;
    throw new Error('another instance published first - reload and redo your change');
  }
  throw new Error('GitHub write failed: ' + r.code + ' ' + (r.body && r.body.message));
}

/* ---- local file storage ---- */
function fileSave() { // atomic: survives a crash mid-write
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(state));
  fs.renameSync(DATA + '.tmp', DATA);
}

const persist = () => useGh ? ghSave(state) : Promise.resolve(fileSave());

async function boot() {
  if (useGh) {
    const loaded = await ghLoad();
    if (loaded) state = loaded;
  } else {
    try { state = migrate(JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) { /* first run */ }
  }
}

/* ---- http ---- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const readBody = req => new Promise(ok => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => ok(b));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/data' || url.pathname === '/api/project') {
    if (TOKEN && (req.headers['x-key'] || url.searchParams.get('key')) !== TOKEN) return json(res, 401, { error: 'bad key' });
    if (req.method === 'GET') return json(res, 200, state);
    if (req.method !== 'PUT') return json(res, 405, { error: 'method' });

    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    if (!b || typeof b.data !== 'object' || !b.data || !Array.isArray(b.data.projects)) return json(res, 400, { error: 'no projects' });
    // Stale write: someone else saved since this client loaded. Hand back the current copy.
    if (state.rev !== 0 && b.rev !== state.rev) return json(res, 409, state);

    const before = state;
    state = { rev: state.rev + 1, data: b.data, at: new Date().toISOString() };
    try { await persist(); } catch (e) {
      if (state.rev === before.rev + 1) state = before; // storage refused: don't pretend it saved
      return json(res, 503, { error: String(e.message || e) });
    }
    return json(res, 200, { rev: state.rev });
  }

  const file = path.join(__dirname, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
  fs.readFile(file, (e, b) => e ? res.writeHead(404).end('not found')
    : res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' }).end(b));
});

// Load storage BEFORE accepting requests: serving an empty plan while the real one is
// still loading would let the first publish overwrite it.
boot().then(() => {
  server.listen(PORT, () => console.log('http://localhost:' + PORT +
    '  (storing in ' + (useGh ? GH.repo + '@' + GH.branch + '/' + GH.path : DATA) + ')' +
    (TOKEN ? ', token required' : '')));
}, e => {
  console.error('Storage unreachable, refusing to start with an empty plan:', e.message);
  process.exit(1);
});
