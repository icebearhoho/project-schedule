// Scheduling engine: forward pass, FS/SS/FF/SF links, WBS summary rollup,
// configurable working calendar. Shared by index.html (script tag) and test.js (require).

const MAX_STEPS = 3650; // ~10 years of calendar days: stops a broken calendar from hanging

function makeCal(c) {
  const days = (c && c.workdays && c.workdays.length) ? c.workdays : [1, 2, 3, 4, 5];
  return { days: new Set(days), holidays: new Set((c && c.holidays) || []), extra: new Set((c && c.extra) || []) };
}
const asCal = c => (c && c.days instanceof Set) ? c : makeCal(c);

// `extra` wins over everything: it exists for make-up working days, like the Saturdays
// China works to bridge a long holiday.
function isWorkday(d, cal) {
  const c = asCal(cal), key = fmtDate(d);
  if (c.extra.has(key)) return true;
  return c.days.has(d.getDay()) && !c.holidays.has(key);
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

// Folds `source` into `target` as one phase: the source's tasks become subtasks of a
// summary row named after it. Task ids are renumbered so they can't collide with the
// target's, and the links between them are rewritten to the new ids. Returns the new
// target project plus notes about anything the caller should tell the user.
function combineProjects(target, source) {
  const notes = [];
  const targetTasks = target.tasks || [], srcTasks = source.tasks || [];
  let nextId = Math.max(Number(target.nextId) || 1, ...targetTasks.map(t => (Number(t.id) || 0) + 1), 1);

  const phase = {
    id: nextId++, name: source.name || 'Imported', duration: 1, level: 1, preds: [], pct: 0,
    ...(source.color ? { color: source.color } : {}),
  };

  const idMap = new Map();
  const moved = srcTasks.map(t => {
    const id = nextId++;
    idMap.set(t.id, id);
    return { ...t, id, level: Math.max(1, Number(t.level) || 1) + 1 };
  });

  moved.forEach(t => {
    t.preds = (t.preds || []).map(p => {
      const link = parsePred(p);
      if (!link) return null;
      if (!idMap.has(link.id)) { // pointed at something that isn't coming along
        notes.push('"' + t.name + '" lost a link to task ' + link.id + ', which is not in ' + (source.name || 'that project') + '.');
        return null;
      }
      return fmtPred({ ...link, id: idMap.get(link.id) });
    }).filter(Boolean);
  });

  // A project that starts later than its new home would silently slide earlier, so the
  // tasks that decided its start date keep it as a "no earlier than" constraint.
  if (source.start && target.start && parseDate(source.start) > parseDate(target.start)) {
    let pinned = 0;
    const kids = childrenOf(moved); // summary dates come from their children, so pinning them means nothing
    moved.forEach((t, i) => {
      if (!t.start && !(t.preds || []).length && !kids[i].length) { t.start = source.start; pinned++; }
    });
    if (pinned) notes.push((source.name || 'That project') + ' started later than this one, so its opening ' +
      pinned + ' task(s) are pinned to ' + source.start + '. Clear the Start cell to let them run earlier.');
  }
  if (JSON.stringify(source.calendar || {}) !== JSON.stringify(target.calendar || {})) {
    notes.push('Working calendars differ — the combined plan uses this project\'s calendar, so imported dates may shift.');
  }

  return {
    project: { ...target, tasks: [...targetTasks, phase, ...moved], nextId },
    notes,
  };
}

// Public-holiday presets, for clicking into a project's calendar.
//
// IMPORTANT: these are a convenience, not an authority. Lunar and Islamic dates move,
// governments gazette days in lieu, and China sets its make-up working weekends
// (调休) year by year — so check them against the official notice before you commit to
// a plan. Every date lands in the Schedule panel as normal text you can edit.
//   China:     www.gov.cn holiday notices
//   Singapore: www.mom.gov.sg/employment-practices/public-holidays
const NATIONAL_CALENDARS = {
  'SG-2026': {
    label: 'Singapore 2026',
    // Dates in lieu are used where the holiday falls on a Sunday.
    holidays: [
      '2026-01-01', // New Year's Day
      '2026-02-17', '2026-02-18', // Chinese New Year
      '2026-03-20', // Hari Raya Puasa
      '2026-04-03', // Good Friday
      '2026-05-01', // Labour Day
      '2026-05-27', // Hari Raya Haji
      '2026-06-01', // Vesak Day (in lieu of Sun 31 May)
      '2026-08-10', // National Day (in lieu of Sun 9 Aug)
      '2026-11-09', // Deepavali (in lieu of Sun 8 Nov)
      '2026-12-25', // Christmas Day
    ],
    extra: [],
  },
  'CN-2026': {
    label: 'China 2026',
    holidays: [
      '2026-01-01', // 元旦
      '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
      '2026-02-21', '2026-02-22', // 春节
      '2026-04-04', '2026-04-05', '2026-04-06', // 清明节
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
      '2026-06-19', '2026-06-20', '2026-06-21', // 端午节
      '2026-09-25', '2026-09-26', '2026-09-27', // 中秋节
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07', // 国庆节
    ],
    // Left empty on purpose: the make-up working weekends are announced annually and I
    // will not invent them. Add them under "Extra working days" once published.
    extra: [],
  },

  // ---- 2027: the official notices are not out yet, so these are marked provisional.
  // Fixed dates and Good Friday are certain (Easter 2027 falls on 28 March). Everything
  // driven by the lunar or Islamic calendar is an estimate that must be confirmed.
  'SG-2027': {
    label: 'Singapore 2027',
    provisional: 'Chinese New Year, Hari Raya Puasa, Hari Raya Haji, Vesak and Deepavali are estimates. ' +
      'Confirm with MOM before committing to dates.',
    holidays: [
      '2027-01-01', // New Year's Day (Fri)
      '2027-02-06', '2027-02-07', '2027-02-08', // Chinese New Year (Sat/Sun) + Mon in lieu — estimated
      '2027-03-09', // Hari Raya Puasa — estimated
      '2027-03-26', // Good Friday (Easter 28 Mar 2027)
      '2027-05-01', // Labour Day (Sat)
      '2027-05-17', // Hari Raya Haji — estimated
      '2027-05-20', // Vesak Day — estimated
      '2027-08-09', // National Day (Mon)
      '2027-10-28', // Deepavali — estimated
      '2027-12-25', // Christmas Day (Sat)
    ],
    extra: [],
  },
  'CN-2027': {
    label: 'China 2027',
    provisional: 'Statutory days only — the State Council notice normally extends these with bridge ' +
      'weekends, and the lunar dates here are estimates. Confirm on gov.cn.',
    holidays: [
      '2027-01-01', // 元旦
      '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', // 除夕 + 春节前三天 — estimated
      '2027-04-05', // 清明节 — estimated
      '2027-05-01', '2027-05-02', // 劳动节
      '2027-06-09', // 端午节 — estimated
      '2027-09-15', // 中秋节 — estimated
      '2027-10-01', '2027-10-02', '2027-10-03', // 国庆节
    ],
    extra: [],
  },
};

// Folds a preset into a calendar without losing what's already there.
function applyNationalCalendar(cal, key) {
  const preset = NATIONAL_CALENDARS[key];
  if (!preset) return { holidays: (cal && cal.holidays) || [], extra: (cal && cal.extra) || [], added: 0, addedExtra: 0 };
  const holidays = new Set((cal && cal.holidays) || []);
  const extra = new Set((cal && cal.extra) || []);
  const before = holidays.size, beforeExtra = extra.size;
  preset.holidays.forEach(d => holidays.add(d));
  (preset.extra || []).forEach(d => extra.add(d));
  return {
    holidays: [...holidays].sort(), extra: [...extra].sort(),
    added: holidays.size - before, addedExtra: extra.size - beforeExtra,
  };
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
    schedule, parsePred, fmtPred, childrenOf, wbsCodes, makeCal, combineProjects,
    NATIONAL_CALENDARS, applyNationalCalendar,
    addWorkdays, nextWorkday, prevWorkday, workdaysBetween, isWorkday, parseDate, fmtDate,
  };
}
