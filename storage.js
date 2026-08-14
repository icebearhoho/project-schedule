// Where the shared plan lives. One implementation, two callers: serve.js (a long-running
// node server) and api/data.js (a serverless function).
//
// With GITHUB_TOKEN + GITHUB_REPO set, the plan is a file in a GitHub repo, which is what
// lets it live on free hosting that has no persistent disk. Otherwise it's a local file.
const fs = require('fs'), path = require('path');

const env = () => ({
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || 'icebearhoho/project-schedule', // so only GITHUB_TOKEN has to be set

  branch: process.env.GITHUB_BRANCH || 'plan-data',
  path: process.env.GITHUB_PATH || 'plan.json',
  api: process.env.GITHUB_API || 'https://api.github.com',
  file: process.env.DATA_FILE || path.join(__dirname, 'project.json'),
});
const useGh = e => !!(e.token && e.repo);

function migrate(s) { // file written by the single-project version of this app
  if (s && s.project && !s.data) { s.data = { projects: [s.project], nextPid: 2 }; delete s.project; }
  return s;
}

async function gh(e, p, opts) {
  const r = await fetch(e.api + p, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + e.token, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'project-planner',
    },
  });
  return { code: r.status, body: await r.json().catch(() => null) };
}

async function ensureBranch(e) {
  if ((await gh(e, `/repos/${e.repo}/git/ref/heads/${e.branch}`)).code === 200) return;
  const heads = await gh(e, `/repos/${e.repo}/git/refs/heads`);
  const first = Array.isArray(heads.body) && heads.body[0];
  if (!first) return; // empty repo: the first save creates the branch itself
  await gh(e, `/repos/${e.repo}/git/refs`, {
    method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + e.branch, sha: first.object.sha }),
  });
}

// -> { rev, data, sha }. sha is GitHub's version marker, needed to write safely.
async function load() {
  const e = env();
  if (!useGh(e)) {
    try { return { ...migrate(JSON.parse(fs.readFileSync(e.file, 'utf8'))), sha: null }; }
    catch (_) { return { rev: 0, data: null, sha: null }; }
  }
  const r = await gh(e, `/repos/${e.repo}/contents/${e.path}?ref=${e.branch}`);
  if (r.code === 200) {
    return { ...migrate(JSON.parse(Buffer.from(r.body.content, 'base64').toString('utf8'))), sha: r.body.sha };
  }
  if (r.code === 404) { await ensureBranch(e); return { rev: 0, data: null, sha: null }; }
  throw new Error('GitHub read failed: ' + r.code + ' ' + (r.body && r.body.message));
}

// Writes, refusing to clobber a newer version. Throws err.conflict on a stale sha.
async function save(state, sha) {
  const e = env();
  if (!useGh(e)) {
    fs.writeFileSync(e.file + '.tmp', JSON.stringify(state)); // atomic: survives a crash mid-write
    fs.renameSync(e.file + '.tmp', e.file);
    return null;
  }
  const body = {
    message: 'Plan rev ' + state.rev, branch: e.branch,
    content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const r = await gh(e, `/repos/${e.repo}/contents/${e.path}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.code === 200 || r.code === 201) return r.body.content.sha;
  if (r.code === 409 || r.code === 422) {
    const err = new Error('someone else published first');
    err.conflict = true;
    throw err;
  }
  throw new Error('GitHub write failed: ' + r.code + ' ' + (r.body && r.body.message));
}

const describe = () => { const e = env(); return useGh(e) ? e.repo + '@' + e.branch + '/' + e.path : e.file; };

module.exports = { load, save, describe, migrate };
