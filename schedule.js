// Scheduling engine: forward-pass, finish-to-start, Mon-Fri working days.
// Shared by index.html (script tag) and test.js (require).

function isWorkday(d) { const k = d.getDay(); return k !== 0 && k !== 6; }

function nextWorkday(d) {
  const x = new Date(d);
  while (!isWorkday(x)) x.setDate(x.getDate() + 1);
  return x;
}

function addWorkdays(d, n) {
  const step = n < 0 ? -1 : 1;
  const x = new Date(d);
  while (!isWorkday(x)) x.setDate(x.getDate() + step); // land on a working day first
  for (let i = 0; i < Math.abs(n); i++) {
    do { x.setDate(x.getDate() + step); } while (!isWorkday(x));
  }
  return x;
}

function prevWorkday(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - 1);
  while (!isWorkday(x)) x.setDate(x.getDate() - 1);
  return x;
}

function workdaysBetween(a, b) { // whole workdays in [a, b)
  let n = 0; const x = nextWorkday(a);
  while (x < b) { n++; x.setDate(x.getDate() + 1); while (!isWorkday(x)) x.setDate(x.getDate() + 1); }
  return n;
}

function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// A predecessor is written the way MS Project writes it: 3, 3FS, 2SS+1, 4FF-2.
// Lag is in working days. Returns null if it can't be parsed.
function parsePred(p) {
  if (p && typeof p === 'object') return { id: Number(p.id), type: (p.type || 'FS').toUpperCase(), lag: Number(p.lag) || 0 };
  const m = String(p).trim().match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)?\s*d?a?y?s?$/i);
  if (!m) return null;
  return { id: Number(m[1]), type: (m[2] || 'FS').toUpperCase(), lag: m[3] ? Number(m[3].replace(/\s/g, '')) : 0 };
}

function fmtPred(p) {
  const x = parsePred(p);
  if (!x) return String(p);
  return x.id + (x.type === 'FS' && !x.lag ? '' : x.type) + (x.lag ? (x.lag > 0 ? '+' : '') + x.lag : '');
}

// tasks: [{id, name, duration, preds:['3SS+1'|3|{id,type,lag}], start?:'YYYY-MM-DD'
// (manual, treated as "no earlier than"), ...}].
// Mutates each task with .startDate/.endExclusive/.finishDate.
// Throws on dependency cycles or unknown predecessor ids.
function schedule(tasks, projectStart) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const state = new Map(); // id -> 'busy' | 'done'
  const base = nextWorkday(projectStart instanceof Date ? projectStart : parseDate(projectStart));

  function resolve(t) {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'busy') throw new Error('Circular dependency at task ' + t.id + ' (' + t.name + ')');
    state.set(t.id, 'busy');
    let start = new Date(base); // earliest start, from FS/SS links
    let end = null;             // earliest finish, from FF/SF links
    const dur = Math.max(0, Number(t.duration) || 0);
    for (const raw of t.preds || []) {
      const link = parsePred(raw);
      if (!link) throw new Error('Task ' + t.id + ': cannot read predecessor "' + raw + '" (use 3, 3FS, 2SS+1, 4FF-2)');
      const p = byId.get(link.id);
      if (!p) throw new Error('Task ' + t.id + ' has unknown predecessor ' + link.id);
      if (p === t) throw new Error('Task ' + t.id + ' depends on itself');
      resolve(p);
      // Link type XY: X = which end of the predecessor we hang off (F/S),
      // Y = which end of this task it constrains (S/F).
      // Dates are half-open (endExclusive = day after the last working day), so an
      // SF link needs the day after the predecessor's start to mean "finishes on it".
      const anchor = link.type[0] === 'F' ? p.endExclusive
        : link.type[1] === 'F' ? addWorkdays(p.startDate, 1) : p.startDate;
      const at = addWorkdays(anchor, link.lag);
      if (link.type[1] === 'S') { if (at > start) start = at; }        // FS, SS -> our start
      else if (!end || at > end) end = at;                             // FF, SF -> our finish
    }
    if (end) { const s = dur === 0 ? end : addWorkdays(end, -dur); if (s > start) start = s; }
    if (t.start) { const m = parseDate(t.start); if (m > start) start = m; }
    t.startDate = nextWorkday(start);
    t.endExclusive = dur === 0 ? new Date(t.startDate) : addWorkdays(t.startDate, dur);
    t.finishDate = dur === 0 ? new Date(t.startDate) : prevWorkday(t.endExclusive);
    state.set(t.id, 'done');
  }

  for (const t of tasks) resolve(t);
  return tasks;
}

if (typeof module !== 'undefined') {
  module.exports = { schedule, parsePred, fmtPred, addWorkdays, nextWorkday, prevWorkday, workdaysBetween, isWorkday, parseDate, fmtDate };
}
