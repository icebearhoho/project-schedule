const assert = require('assert');
const { schedule, fmtDate, parsePred, fmtPred, wbsCodes, childrenOf } = require('./schedule');

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

// --- WBS: summary rows span their subtasks and roll up duration and % ---
t = [
  { id: 1, name: 'Phase 1', duration: 0, level: 1, preds: [] },
  { id: 2, name: 'A', duration: 5, level: 2, preds: [], pct: 100 },
  { id: 3, name: 'B', duration: 5, level: 2, preds: ['2'], pct: 0 },
  { id: 4, name: 'Phase 2', duration: 0, level: 1, preds: [] },
  { id: 5, name: 'C', duration: 2, level: 2, preds: ['3'] },
];
assert.deepEqual(schedule(t, '2026-08-17'), []);
assert.equal(fmtDate(t[0].startDate), '2026-08-17');   // summary starts with its first child
assert.equal(fmtDate(t[0].finishDate), '2026-08-28');  // and ends with its last
assert.equal(t[0].rollDuration, 10);
assert.equal(t[0].rollPct, 50);                        // 5d done + 5d not
assert.equal(fmtDate(t[3].startDate), '2026-08-31');
assert.deepEqual(wbsCodes(t), ['1', '1.1', '1.2', '2', '2.1']);
assert.deepEqual(childrenOf(t), [[1, 2], [], [], [4], []]);

// A leaf can depend on a summary; links ON a summary are reported, not silently applied.
t = [
  { id: 1, name: 'Phase', duration: 0, level: 1, preds: ['3'] },
  { id: 2, name: 'A', duration: 3, level: 2, preds: [] },
  { id: 3, name: 'Outside', duration: 2, level: 1, preds: [] },
  { id: 4, name: 'After phase', duration: 1, level: 1, preds: ['1'] },
];
const warn = schedule(t, '2026-08-17');
assert.equal(warn.length, 1);
assert.match(warn[0], /summary/);
assert.equal(fmtDate(t[3].startDate), '2026-08-20'); // waits for the whole phase (Mon-Wed)
assert.throws(() => schedule([
  { id: 1, name: 'Phase', duration: 0, level: 1, preds: [] },
  { id: 2, name: 'child', duration: 1, level: 2, preds: ['1'] },
], '2026-08-17'), /Circular/);

// --- custom calendar: 6-day week plus a holiday ---
t = [{ id: 1, name: 'A', duration: 4, preds: [] }];
schedule(t, '2026-08-14', { workdays: [1, 2, 3, 4, 5, 6], holidays: ['2026-08-17'] });
assert.equal(fmtDate(t[0].finishDate), '2026-08-19'); // Fri 14, Sat 15, (Mon 17 off), Tue 18, Wed 19
t = [{ id: 1, name: 'A', duration: 1, preds: [] }];
schedule(t, '2026-08-14', { workdays: [0], holidays: [] });    // Sundays only
assert.equal(fmtDate(t[0].startDate), '2026-08-16');
t = [{ id: 1, name: 'A', duration: 1, preds: [] }];   // no days ticked falls back to Mon-Fri
schedule(t, '2026-08-15', { workdays: [], holidays: [] });
assert.equal(fmtDate(t[0].startDate), '2026-08-17');

// --- three-way merge: two people publishing at once keep both sets of edits ---
{
  const { mergeWorkspaces } = require('./merge');
  const base = () => ({
    nextPid: 3, projects: [{
      pid: 'p0', name: 'Site', start: '2026-08-17', nextId: 4,
      tasks: [
        { id: 1, name: 'Design', duration: 3, level: 1, preds: [], pct: 0 },
        { id: 2, name: 'Build', duration: 5, level: 1, preds: ['1'], pct: 0 },
        { id: 3, name: 'Test', duration: 2, level: 1, preds: ['2'], pct: 0 },
      ],
    }],
  });
  const edit = (ws, id, fn) => { fn(ws.projects[0].tasks.find(t => t.id === id)); return ws; };

  // different tasks -> both edits survive
  let mine = edit(base(), 1, t => t.pct = 100);
  let theirs = edit(base(), 3, t => t.duration = 9);
  let r = mergeWorkspaces(base(), mine, theirs);
  assert.equal(r.data.projects[0].tasks[0].pct, 100);
  assert.equal(r.data.projects[0].tasks[2].duration, 9);
  assert.deepEqual(r.conflicts, []);

  // different fields of the SAME task -> both survive
  mine = edit(base(), 2, t => t.pct = 50);
  theirs = edit(base(), 2, t => t.name = 'Build it');
  r = mergeWorkspaces(base(), mine, theirs);
  assert.equal(r.data.projects[0].tasks[1].pct, 50);
  assert.equal(r.data.projects[0].tasks[1].name, 'Build it');
  assert.deepEqual(r.conflicts, []);

  // same field, different values -> publisher wins and it is reported
  mine = edit(base(), 2, t => t.duration = 6);
  theirs = edit(base(), 2, t => t.duration = 8);
  r = mergeWorkspaces(base(), mine, theirs);
  assert.equal(r.data.projects[0].tasks[1].duration, 6);
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0], /Build.*duration/);

  // both add a task -> both are kept, theirs lands after its neighbour
  mine = base(); mine.projects[0].tasks.push({ id: 4, name: 'Mine', duration: 1, level: 1, preds: [] });
  theirs = base(); theirs.projects[0].tasks.splice(1, 0, { id: 9, name: 'Theirs', duration: 1, level: 1, preds: [] });
  r = mergeWorkspaces(base(), mine, theirs);
  const names = r.data.projects[0].tasks.map(t => t.name);
  assert.deepEqual(names, ['Design', 'Theirs', 'Build', 'Test', 'Mine']);
  assert.ok(r.data.projects[0].nextId > 9); // ids never reused after a merge

  // a deletion on either side sticks
  mine = base(); mine.projects[0].tasks = mine.projects[0].tasks.filter(t => t.id !== 2);
  theirs = edit(base(), 2, t => t.pct = 10);
  r = mergeWorkspaces(base(), mine, theirs);
  assert.deepEqual(r.data.projects[0].tasks.map(t => t.id), [1, 3]);
  mine = base(); // I left it alone, so their delete stands
  theirs = base(); theirs.projects[0].tasks = theirs.projects[0].tasks.filter(t => t.id !== 3);
  assert.deepEqual(mergeWorkspaces(base(), mine, theirs).data.projects[0].tasks.map(t => t.id), [1, 2]);

  // my reorder + their edit: order is mine, their edit still applied
  mine = base(); mine.projects[0].tasks.reverse();
  theirs = edit(base(), 1, t => t.name = 'Design v2');
  r = mergeWorkspaces(base(), mine, theirs);
  assert.deepEqual(r.data.projects[0].tasks.map(t => t.id), [3, 2, 1]);
  assert.equal(r.data.projects[0].tasks[2].name, 'Design v2');

  // project-level: their rename + my calendar change, plus a project only they added
  mine = base(); mine.projects[0].start = '2026-09-01';
  theirs = base(); theirs.projects[0].name = 'Site v2';
  theirs.projects.push({ pid: 'pX', name: 'Their project', start: '2026-08-17', nextId: 1, tasks: [] });
  r = mergeWorkspaces(base(), mine, theirs);
  assert.equal(r.data.projects[0].start, '2026-09-01');
  assert.equal(r.data.projects[0].name, 'Site v2');
  assert.deepEqual(r.data.projects.map(p => p.pid), ['p0', 'pX']);

  // a long draft: they deleted a task the publisher spent the morning editing.
  // The edits win over the delete, and the clash is named rather than swallowed.
  mine = edit(base(), 2, t => { t.pct = 80; t.name = 'Build (revised)'; });
  theirs = base(); theirs.projects[0].tasks = theirs.projects[0].tasks.filter(t => t.id !== 2);
  r = mergeWorkspaces(base(), mine, theirs);
  assert.ok(r.data.projects[0].tasks.find(t => t.id === 2), 'edited task survives the delete');
  assert.equal(r.data.projects[0].tasks.find(t => t.id === 2).pct, 80);
  assert.match(r.conflicts.join(' '), /deleted by a teammate, your edits kept it/);

  // the mirror image: I deleted a task they had edited — reported too
  mine = base(); mine.projects[0].tasks = mine.projects[0].tasks.filter(t => t.id !== 2);
  theirs = edit(base(), 2, t => t.pct = 40);
  r = mergeWorkspaces(base(), mine, theirs);
  assert.equal(r.data.projects[0].tasks.find(t => t.id === 2), undefined);
  assert.match(r.conflicts.join(' '), /you deleted it, a teammate's edits went with it/);

  // an untouched task they deleted just goes, quietly, and links to it are cleaned up
  // so the plan still schedules instead of erroring for everyone
  mine = base(); mine.projects[0].tasks.push({ id: 9, name: 'Handover', duration: 1, level: 1, preds: ['2'], pct: 0 });
  theirs = base(); theirs.projects[0].tasks = theirs.projects[0].tasks.filter(t => t.id !== 2);
  r = mergeWorkspaces(base(), mine, theirs);
  assert.equal(r.data.projects[0].tasks.find(t => t.id === 2), undefined);
  assert.deepEqual(r.data.projects[0].tasks.find(t => t.id === 9).preds, []);
  assert.deepEqual(r.data.projects[0].tasks.find(t => t.id === 3).preds, []);
  assert.equal(r.conflicts.filter(c => /link to a deleted task removed/.test(c)).length, 2);
  // and the merged plan actually schedules — no dangling reference left behind
  assert.doesNotThrow(() => schedule(r.data.projects[0].tasks, '2026-08-17'));

  // no base (first ever publish) -> mine, untouched
  assert.deepEqual(mergeWorkspaces(null, base(), base()).data.projects[0].tasks.length, 3);
}

// --- shared storage API: last-writer-with-stale-rev must be rejected, not silently applied ---
(async () => {
  const os = require('os'), fs = require('fs'), path = require('path'), cp = require('child_process');
  const data = path.join(os.tmpdir(), 'planner-test-' + Date.now() + '.json');
  const srv = cp.spawn(process.execPath, [require.resolve('./serve.js')],
    { env: { ...process.env, PORT: '5199', DATA_FILE: data }, stdio: 'ignore' });
  const call = async (m, b) => {
    const r = await fetch('http://localhost:5199/api/data',
      { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) });
    return { code: r.status, body: await r.json() };
  };
  const wsOf = name => ({ projects: [{ name, start: '2026-08-14', tasks: [], nextId: 1 }], nextPid: 2 });
  try {
    for (let i = 0; ; i++) { // wait for listen
      try { await call('GET'); break; } catch (e) { if (i > 50) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    assert.equal((await call('GET')).body.data, null);
    const a = await call('PUT', { rev: 0, data: wsOf('P') });
    assert.equal(a.code, 200);
    const b = await call('PUT', { rev: a.body.rev, data: wsOf('P2') });
    assert.equal(b.code, 200);
    const stale = await call('PUT', { rev: a.body.rev, data: wsOf('clobber') });
    assert.equal(stale.code, 409);
    assert.equal(stale.body.data.projects[0].name, 'P2'); // conflicting write returns the winner, not silence
    assert.equal((await call('GET')).body.data.projects[0].name, 'P2');
    assert.equal((await call('PUT', { rev: b.body.rev })).code, 400);         // no data
    assert.equal((await call('PUT', { rev: b.body.rev, data: { x: 1 } })).code, 400); // no projects array
    assert.equal(JSON.parse(fs.readFileSync(data, 'utf8')).data.projects[0].name, 'P2'); // survives restart

    // End to end: Alice and Bob both draft from the same published plan and publish at
    // the same moment, each having edited a different task. Both edits must survive.
    {
      const plan = tasks => ({ projects: [{ pid: 'p0', name: 'Site', start: '2026-08-17', nextId: 4, tasks }], nextPid: 2 });
      const start = [
        { id: 1, name: 'Design', duration: 3, level: 1, preds: [], pct: 0 },
        { id: 2, name: 'Build', duration: 5, level: 1, preds: ['1'], pct: 0 },
        { id: 3, name: 'Test', duration: 2, level: 1, preds: ['2'], pct: 0 },
      ];
      await call('PUT', { rev: (await call('GET')).body.rev, data: plan(start) });
      const base = (await call('GET')).body;

      const aliceTasks = JSON.parse(JSON.stringify(start)); aliceTasks[0].pct = 100;
      const bobTasks = JSON.parse(JSON.stringify(start)); bobTasks[2].duration = 9;
      bobTasks.push({ id: 4, name: 'Launch', duration: 0, level: 1, preds: ['3'], pct: 0 });

      const [a, bres] = await Promise.all([
        call('PUT', { rev: base.rev, data: plan(aliceTasks), base: base.data }),
        call('PUT', { rev: base.rev, data: plan(bobTasks), base: base.data }),
      ]);
      assert.equal(a.code, 200); assert.equal(bres.code, 200); // nobody is turned away now
      const merged = (await call('GET')).body.data.projects[0].tasks;
      assert.equal(merged.find(t => t.id === 1).pct, 100, "Alice's edit survived");
      assert.equal(merged.find(t => t.id === 3).duration, 9, "Bob's edit survived");
      assert.ok(merged.find(t => t.id === 4), "Bob's new task survived");
      const second = [a, bres].find(r => r.body.merged);
      assert.ok(second && Array.isArray(second.body.conflicts), 'the later publish reports what it merged');
      assert.deepEqual(second.body.conflicts, [], 'edits to different tasks are not conflicts');
    }

    // Without a base (an old client), the server must still refuse a stale write rather
    // than overwrite: exactly one of a simultaneous pair may win.
    for (let round = 0; round < 20; round++) {
      const rev = (await call('GET')).body.rev;
      const names = ['Alice' + round, 'Bob' + round, 'Carol' + round];
      const res = await Promise.all(names.map(n => call('PUT', { rev, data: wsOf(n) })));
      const winners = names.filter((_, i) => res[i].code === 200);
      assert.equal(winners.length, 1, 'round ' + round + ' accepted ' + winners.length + ' publishes');
      res.filter(r => r.code !== 200).forEach(r => assert.equal(r.code, 409));
      assert.equal((await call('GET')).body.data.projects[0].name, winners[0]);
    }

    // a file written by the single-project version still loads
    srv.kill();
    fs.writeFileSync(data, JSON.stringify({ rev: 7, project: { name: 'Old', tasks: [] } }));
    const srv2 = cp.spawn(process.execPath, [require.resolve('./serve.js')],
      { env: { ...process.env, PORT: '5199', DATA_FILE: data }, stdio: 'ignore' });
    try {
      for (let i = 0; ; i++) {
        try { await call('GET'); break; } catch (e) { if (i > 50) throw e; await new Promise(r => setTimeout(r, 100)); }
      }
      const migrated = (await call('GET')).body;
      assert.equal(migrated.data.projects[0].name, 'Old');
      assert.equal(migrated.rev, 7);
    } finally { srv2.kill(); }

    // --- GitHub-backed storage, against a stub of the bits of the API we use ---
    const http = require('http');
    let stored = null, storedSha = null, branches = [], commits = 0;
    const stub = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => body += c);
      rq.on('end', () => {
        const send = (code, o) => rs.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
        const p = rq.url.split('?')[0];
        if (p === '/repos/o/r/git/refs/heads') return send(200, [{ object: { sha: 'mainsha' } }]);
        if (p === '/repos/o/r/git/ref/heads/plan-data') return branches.includes('plan-data') ? send(200, {}) : send(404, {});
        if (p === '/repos/o/r/git/refs' && rq.method === 'POST') { branches.push('plan-data'); return send(201, {}); }
        if (p === '/repos/o/r/contents/plan.json') {
          if (rq.method === 'GET') return stored ? send(200, { sha: storedSha, content: Buffer.from(stored).toString('base64') }) : send(404, {});
          const b = JSON.parse(body);
          if (storedSha && b.sha !== storedSha) return send(409, { message: 'sha mismatch' }); // real CAS
          stored = Buffer.from(b.content, 'base64').toString('utf8');
          storedSha = 'sha' + (++commits);
          return send(201, { content: { sha: storedSha } });
        }
        send(404, {});
      });
    });
    await new Promise(r => stub.listen(5201, r));
    const ghEnv = {
      ...process.env, PORT: '5202', GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r',
      GITHUB_API: 'http://localhost:5201', DATA_FILE: data + '.unused',
    };
    const ghCall = async (m, b) => {
      const r = await fetch('http://localhost:5202/api/data',
        { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) });
      return { code: r.status, body: await r.json() };
    };
    const waitUp = async () => { for (let i = 0; ; i++) { try { return await ghCall('GET'); } catch (e) { if (i > 50) throw e; await new Promise(r => setTimeout(r, 100)); } } };
    let srv3 = cp.spawn(process.execPath, [require.resolve('./serve.js')], { env: ghEnv, stdio: 'ignore' });
    try {
      assert.equal((await waitUp()).body.data, null);
      assert.deepEqual(branches, ['plan-data']);              // data branch created, off main
      const put = await ghCall('PUT', { rev: 0, data: wsOf('Cloud plan') });
      assert.equal(put.code, 200);
      assert.equal(JSON.parse(stored).data.projects[0].name, 'Cloud plan'); // really committed
      srv3.kill();
      srv3 = cp.spawn(process.execPath, [require.resolve('./serve.js')], { env: ghEnv, stdio: 'ignore' });
      const after = await waitUp();                            // survives a wiped filesystem
      assert.equal(after.body.data.projects[0].name, 'Cloud plan');
      assert.equal(after.body.rev, 1);
      assert.equal((await ghCall('PUT', { rev: 99, data: wsOf('stale') })).code, 409);
      assert.equal(JSON.parse(stored).data.projects[0].name, 'Cloud plan'); // stale write changed nothing
      // --- the serverless handler (Vercel) against the same stub ---
      Object.assign(process.env, {
        GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r', GITHUB_API: 'http://localhost:5201',
        GITHUB_BRANCH: 'plan-data', GITHUB_PATH: 'plan.json',
      });
      const handler = require('./api/data.js');
      const call = async (method, body) => {
        const out = { code: 0, body: null, headers: {} };
        const req = Object.assign(new (require('stream').Readable)({ read() { this.push(null); } }),
          { method, url: '/api/data', headers: {}, body });
        const res = {
          set statusCode(c) { out.code = c; }, get statusCode() { return out.code; },
          setHeader(k, v) { out.headers[k] = v; }, end(s) { out.body = JSON.parse(s); },
        };
        await handler(req, res);
        return out;
      };
      const got = await call('GET');
      assert.equal(got.code, 200);
      assert.equal(got.body.data.projects[0].name, 'Cloud plan'); // reads what the server wrote
      const fresh = await call('PUT', { rev: got.body.rev, data: wsOf('From serverless') });
      assert.equal(fresh.code, 200);
      assert.equal(JSON.parse(stored).data.projects[0].name, 'From serverless');
      const staleServerless = await call('PUT', { rev: 1, data: wsOf('stale') });
      assert.equal(staleServerless.code, 409);
      assert.equal(staleServerless.body.data.projects[0].name, 'From serverless');
      assert.equal((await call('PUT', { rev: 99, data: { nope: 1 } })).code, 400);
      assert.equal((await call('DELETE')).code, 405);
    } finally { srv3.kill(); stub.close(); fs.rmSync(data + '.unused', { force: true }); }
    console.log('ok');
  } finally { srv.kill(); try { fs.unlinkSync(data); } catch (e) { } }
})();
