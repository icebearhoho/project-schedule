const assert = require('assert');
const { schedule, fmtDate, parsePred, fmtPred } = require('./schedule');

// Fri start, 2d task -> Fri + Mon; successor starts Tue (weekend skipped).
let t = [
  { id: 1, name: 'A', duration: 2, preds: [] },
  { id: 2, name: 'B', duration: 1, preds: [1] },
  { id: 3, name: 'M', duration: 0, preds: [2] },
];
schedule(t, '2026-08-14'); // a Friday
assert.equal(fmtDate(t[0].startDate), '2026-08-14');
assert.equal(fmtDate(t[0].finishDate), '2026-08-17');
assert.equal(fmtDate(t[1].startDate), '2026-08-18');
assert.equal(fmtDate(t[2].startDate), fmtDate(t[2].finishDate)); // milestone

// Project start on a weekend rolls to Monday.
t = [{ id: 1, name: 'A', duration: 1, preds: [] }];
schedule(t, '2026-08-15');
assert.equal(fmtDate(t[0].startDate), '2026-08-17');

// Manual start acts as "no earlier than", never before a predecessor.
t = [
  { id: 1, name: 'A', duration: 5, preds: [] },
  { id: 2, name: 'B', duration: 1, preds: [1], start: '2026-08-17' },
];
schedule(t, '2026-08-14');
assert.equal(fmtDate(t[1].startDate), '2026-08-21');

// Cycles and bad links throw instead of hanging.
assert.throws(() => schedule([
  { id: 1, name: 'A', duration: 1, preds: [2] },
  { id: 2, name: 'B', duration: 1, preds: [1] },
], '2026-08-14'), /Circular/);
assert.throws(() => schedule([{ id: 1, name: 'A', duration: 1, preds: [9] }], '2026-08-14'), /unknown predecessor/);

// --- link types. Pred A: Mon 17 -> Fri 21 (5d). ---
const links = type => {
  const t = [
    { id: 1, name: 'A', duration: 5, preds: [], start: '2026-08-17' }, // Mon 17 - Fri 21
    { id: 2, name: 'B', duration: 2, preds: [type] },
  ];
  schedule(t, '2026-08-10'); // project starts a week earlier, so SF has room to go backwards
  return [fmtDate(t[1].startDate), fmtDate(t[1].finishDate)];
};
assert.deepEqual(links('1'), ['2026-08-24', '2026-08-25']);    // FS: starts after A finishes
assert.deepEqual(links('1FS'), ['2026-08-24', '2026-08-25']);
assert.deepEqual(links('1SS'), ['2026-08-17', '2026-08-18']);  // SS: starts with A
assert.deepEqual(links('1SS+2'), ['2026-08-19', '2026-08-20']);// SS + 2 working days
assert.deepEqual(links('1FF'), ['2026-08-20', '2026-08-21']);  // FF: finishes with A
assert.deepEqual(links('1FF-1'), ['2026-08-19', '2026-08-20']);
assert.deepEqual(links('1SF'), ['2026-08-14', '2026-08-17']);  // SF: finishes when A starts
assert.deepEqual(links('1FS+3'), ['2026-08-27', '2026-08-28']);

assert.deepEqual(parsePred('2ss+1'), { id: 2, type: 'SS', lag: 1 });
assert.deepEqual(parsePred(3), { id: 3, type: 'FS', lag: 0 });
assert.equal(parsePred('nope'), null);
assert.equal(fmtPred('4FS'), '4');
assert.equal(fmtPred('4FF-2'), '4FF-2');
assert.throws(() => schedule([{ id: 1, name: 'A', duration: 1, preds: ['banana'] }], '2026-08-14'), /cannot read predecessor/);

// --- shared storage API: last-writer-with-stale-rev must be rejected, not silently applied ---
(async () => {
  const os = require('os'), fs = require('fs'), path = require('path'), cp = require('child_process');
  const data = path.join(os.tmpdir(), 'planner-test-' + Date.now() + '.json');
  const srv = cp.spawn(process.execPath, [require.resolve('./serve.js')],
    { env: { ...process.env, PORT: '5199', DATA_FILE: data }, stdio: 'ignore' });
  const call = async (m, b) => {
    const r = await fetch('http://localhost:5199/api/project',
      { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) });
    return { code: r.status, body: await r.json() };
  };
  try {
    for (let i = 0; ; i++) { // wait for listen
      try { await call('GET'); break; } catch (e) { if (i > 50) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    assert.equal((await call('GET')).body.project, null);
    const p1 = { name: 'P', start: '2026-08-14', tasks: [], nextId: 1 };
    const a = await call('PUT', { rev: 0, project: p1 });
    assert.equal(a.code, 200);
    const b = await call('PUT', { rev: a.body.rev, project: { ...p1, name: 'P2' } });
    assert.equal(b.code, 200);
    const stale = await call('PUT', { rev: a.body.rev, project: { ...p1, name: 'clobber' } });
    assert.equal(stale.code, 409);
    assert.equal(stale.body.project.name, 'P2'); // conflicting write returns the winner, not silence
    assert.equal((await call('GET')).body.project.name, 'P2');
    assert.equal((await call('PUT', { rev: b.body.rev })).code, 400);
    assert.equal(JSON.parse(fs.readFileSync(data, 'utf8')).project.name, 'P2'); // survives restart
    console.log('ok');
  } finally { srv.kill(); try { fs.unlinkSync(data); } catch (e) { } }
})();
