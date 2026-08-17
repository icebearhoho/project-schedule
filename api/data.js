// Serverless version of the /api/data endpoint (Vercel, Netlify Functions, etc).
// Same contract as serve.js: GET returns { rev, data }, PUT { rev, data } saves and
// answers 409 with the current copy if someone published first.
const { load, save } = require('../storage');
const { mergeWorkspaces } = require('../merge');

let cache = null; // warm instances reuse this so 3s polling doesn't hammer the GitHub API
const TTL = 4000;

const send = (res, code, body) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const publicPart = s => ({ rev: s.rev, data: s.data, at: s.at });

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // already parsed by the platform
  let b = '';
  for await (const c of req) { b += c; if (b.length > 5e6) throw new Error('too big'); }
  return b ? JSON.parse(b) : null;
}

module.exports = async (req, res) => {
  const TOKEN = process.env.PLANNER_TOKEN || '';
  const url = new URL(req.url, 'http://x');
  if (TOKEN && (req.headers['x-key'] || url.searchParams.get('key')) !== TOKEN) return send(res, 401, { error: 'bad key' });

  try {
    if (req.method === 'GET') {
      if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), state: await load() };
      return send(res, 200, publicPart(cache.state));
    }
    if (req.method !== 'PUT') return send(res, 405, { error: 'method' });

    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (!b || typeof b.data !== 'object' || !b.data || !Array.isArray(b.data.projects)) return send(res, 400, { error: 'no projects' });

    const cur = await load(); // writes always read fresh, never from cache
    let data = b.data, conflicts = null;
    if (cur.rev !== 0 && b.rev !== cur.rev) {
      // Someone published while this client was drafting: combine both sets of edits.
      if (!b.base) { cache = { at: Date.now(), state: cur }; return send(res, 409, publicPart(cur)); }
      const m = mergeWorkspaces(b.base, b.data, cur.data);
      data = m.data; conflicts = m.conflicts;
    }
    const next = { rev: cur.rev + 1, data, at: new Date().toISOString() };
    const sha = await save(next, cur.sha);
    cache = { at: Date.now(), state: { ...next, sha } };
    return send(res, 200, conflicts ? { rev: next.rev, data: next.data, merged: true, conflicts } : { rev: next.rev });
  } catch (e) {
    cache = null;
    if (e.conflict) { // lost a race between the read and the write
      const cur = await load();
      return send(res, 409, publicPart(cur));
    }
    return send(res, 503, { error: String(e.message || e) });
  }
};
