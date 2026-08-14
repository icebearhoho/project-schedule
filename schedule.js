// Scheduling engine: forward pass, FS/SS/FF/SF links, WBS summary rollup,
// configurable working calendar. Shared by index.html (script tag) and test.js (require).

const MAX_STEPS = 3650; // ~10 years of calendar days: stops a broken calendar from hanging

function makeCal(c) {
  const days = (c && c.workdays && c.workdays.length) ? c.workdays : [1, 2, 3, 4, 5];
  return { days: new Set(days), holidays: new Set((c && c.holidays) || []) };
}
const asCal = c => (c && c.days instanceof Set) ? c : makeCal(c);

function isWorkday(d, cal) {
  const c = asCal(cal);
  return c.days.has(d.getDay()) && !c.holidays.has(fmtDate(d));
}

function roll(d, step, cal) { // move to the nearest working day in one direction
  const x = new Date(d);
  for (let i = 0; !isWorkday(x, cal); i++) {
    if (i > MAX_STEPS) throw new Error('The calendar has no working days - tick at least one weekday.');
    x.setDate(x.getDate() + step);
  }
  return x;
}

const nextWorkday = (d, cal) => roll(d, 1, cal);
const prevWorkday = (d, cal) => roll(new Date(+d - 864e5), -1, cal);

function addWorkdays(d, n, cal) {
  const step = n < 0 ? -1 : 1;
  const x = roll(d, step, cal);
  for (let i = 0; i < Math.abs(n); i++) {
    do { x.setDate(x.getDate() + step); } while (!isWorkday(x, cal));
  }
  return x;
}

function workdaysBetween(a, b, cal) { // whole working days in [a, b)
  let n = 0; const x = nextWorkday(a, cal);
  while (x < b) { n++; x.setDate(x.getDate() + 1); while (!isWorkday(x, cal)) x.setDate(x.getDate() + 1); }
  return n;
}

function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
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

// Outline: a task's children are the following tasks with a deeper level, until the
// level comes back. Returns child index lists, parallel to `tasks`.
function childrenOf(tasks) {
  const kids = tasks.map(() => []);
  const open = []; // indices of tasks that could still take children
  tasks.forEach((t, i) => {
    const lvl = Math.max(1, Number(t.level) || 1);
    while (open.length && (Math.max(1, Number(tasks[open[open.length - 1]].level) || 1)) >= lvl) open.pop();
    if (open.length) kids[open[open.length - 1]].push(i);
    open.push(i);
  });
  return kids;
}

// tasks: [{id, name, duration, level?, preds:['3SS+1'|3|{id,type,lag}],
//          start?:'YYYY-MM-DD' (manual, "no earlier than"), pct?}]
// Mutates each task with .startDate/.endExclusive/.finishDate, and for summary tasks
// also .rollDuration/.rollPct. Returns non-fatal warnings.
// Throws on dependency cycles, unknown predecessors or an unusable calendar.
function schedule(tasks, projectStart, calRaw) {
  const cal = asCal(calRaw);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const kids = childrenOf(tasks);
  const idx = new Map(tasks.map((t, i) => [t.id, i]));
  const state = new Map();
  const warnings = [];
  const base = nextWorkday(parseDate(projectStart) || new Date(), cal);

  function resolve(t) {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'busy') throw new Error('Circular dependency at task ' + t.id + ' (' + t.name + ')');
    state.set(t.id, 'busy');
    const myKids = kids[idx.get(t.id)];

    if (myKids.length) { // summary task: dates are whatever its subtasks add up to
      if ((t.preds || []).length) warnings.push('Task ' + t.id + ' (' + t.name + ') is a summary - its links are ignored, put them on the subtasks.');
      myKids.forEach(i => resolve(tasks[i]));
      const cs = myKids.map(i => tasks[i]);
      t.startDate = new Date(Math.min(...cs.map(c => +c.startDate)));
      t.endExclusive = new Date(Math.max(...cs.map(c => +c.endExclusive)));
      t.finishDate = +t.endExclusive === +t.startDate ? new Date(t.startDate) : prevWorkday(t.endExclusive, cal);
      t.rollDuration = workdaysBetween(t.startDate, t.endExclusive, cal);
      const w = cs.reduce((a, c) => a + (c.rollDuration != null ? c.rollDuration : Math.max(0, Number(c.duration) || 0)), 0);
      t.rollPct = w ? Math.round(cs.reduce((a, c) =>
        a + (c.rollDuration != null ? c.rollDuration : Math.max(0, Number(c.duration) || 0)) * (c.rollPct != null ? c.rollPct : Number(c.pct) || 0), 0) / w) : 0;
      state.set(t.id, 'done');
      return;
    }

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
        : link.type[1] === 'F' ? addWorkdays(p.startDate, 1, cal) : p.startDate;
      const at = addWorkdays(anchor, link.lag, cal);
      if (link.type[1] === 'S') { if (at > start) start = at; }        // FS, SS -> our start
      else if (!end || at > end) end = at;                             // FF, SF -> our finish
    }
    if (end) { const s = dur === 0 ? end : addWorkdays(end, -dur, cal); if (s > start) start = s; }
    if (t.start) { const m = parseDate(t.start); if (m > start) start = m; }
    t.startDate = nextWorkday(start, cal);
    t.endExclusive = dur === 0 ? new Date(t.startDate) : addWorkdays(t.startDate, dur, cal);
    t.finishDate = dur === 0 ? new Date(t.startDate) : prevWorkday(t.endExclusive, cal);
    t.rollDuration = null; t.rollPct = null;
    state.set(t.id, 'done');
  }

  for (const t of tasks) resolve(t);
  return warnings;
}

// WBS numbers (1, 1.1, 1.2, 2 ...) from the outline levels.
function wbsCodes(tasks) {
  const counters = [];
  return tasks.map(t => {
    const lvl = Math.max(1, Number(t.level) || 1);
    counters.length = lvl;
    counters[lvl - 1] = (counters[lvl - 1] || 0) + 1;
    return counters.map(n => n || 1).join('.');
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    schedule, parsePred, fmtPred, childrenOf, wbsCodes, makeCal,
    addWorkdays, nextWorkday, prevWorkday, workdaysBetween, isWorkday, parseDate, fmtDate,
  };
}
