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

/* ---- importing a spreadsheet ----
   Takes rows of cells (from a .csv or a .xlsx sheet) and works out tasks from them.
   Columns are found by their heading, so the column order doesn't matter and extra
   columns are ignored. Anything it has to guess is returned in `notes`. */

// Splits CSV text into rows of cells, honouring quoted fields and embedded newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const HEADINGS = {
  wbs: /^wbs$/i,
  id: /^(id|uid|ref|task ?id|no\.?|#)$/i,
  name: /(task ?name|^name$|^task$|description|activity)/i,
  duration: /(duration|^days$|^dur\b)/i,
  start: /^start/i,
  finish: /^(finish|end)/i,
  preds: /(predecessor|^pred|depend)/i,
  linkType: /^(type|link ?type|relationship)$/i,   // some sheets keep FS/SS in its own column
  phase: /^(phase|group|stage|workstream)$/i,      // ... and group their rows under a heading
  pct: /(%|percent|progress|complete)/i,
  milestone: /^milestone$/i,             // a Yes/No flag: this task also marks a gate
  milestoneName: /^milestone ?name$/i,   // the gate's own name, separate from the task's
};

// Sheets write dates every which way. Accept ISO, d/m/y and real date cells; anything
// else is left alone and reported rather than guessed at.
function readDate(v) {
  if (v instanceof Date) return fmtDate(v);
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); // d/m/y, the common non-US form
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }
  return '';
}

// "#4" and "4.0" both mean task 4 as far as a link is concerned.
const idKey = v => String(v || '').trim().replace(/^#/, '').replace(/\.0+$/, '');

const cellText = v => (v === null || v === undefined) ? ''
  : (v instanceof Date) ? fmtDate(v)
    : (typeof v === 'object') ? String(v.text || v.result || v.richText && v.richText.map(t => t.text).join('') || '')
      : String(v);

// rows: array of arrays. -> { tasks, notes }
function tasksFromRows(rows, cal) {
  const grid = (rows || []).map(r => (r || []).map(cellText));
  const notes = [];
  const headerAt = grid.findIndex(r => r.some(c => HEADINGS.name.test(c.trim())));
  if (headerAt < 0) throw new Error('No task name column found — the sheet needs a heading row with a column called "Task name".');

  const header = grid[headerAt].map(c => c.trim());
  const col = {};
  for (const [key, re] of Object.entries(HEADINGS)) {
    const i = header.findIndex(h => re.test(h));
    if (i >= 0 && col[key] === undefined) col[key] = i;
  }
  const at = (row, key) => col[key] === undefined ? '' : (row[col[key]] || '').trim();

  const body = grid.slice(headerAt + 1).filter(r => at(r, 'name') !== '');
  if (!body.length) throw new Error('The sheet has headings but no task rows.');

  const idMap = new Map();           // whatever the file called a task -> the id we give it
  let tasks = body.map((r, i) => {
    const id = i + 1;
    const oldId = idKey(at(r, 'id'));
    idMap.set(oldId || String(i + 1), id);
    if (!oldId) idMap.set(String(i + 1), id);

    const rawName = col.name === undefined ? '' : (r[col.name] || '');
    const wbs = at(r, 'wbs');
    // Depth comes from the WBS code (1.2.1) when there is one, otherwise from the
    // leading spaces this app writes when it exports.
    const level = /^\d+(\.\d+)*$/.test(wbs) ? wbs.split('.').length
      : Math.floor((rawName.match(/^ */)[0].length) / 2) + 1;

    const durText = at(r, 'duration');
    const duration = durText === '' ? null : Math.max(0, parseFloat(durText.replace(/[^\d.\-]/g, '')) || 0);
    const pctText = at(r, 'pct');
    const startText = col.start === undefined ? '' : r[col.start];
    const finishText = col.finish === undefined ? '' : r[col.finish];
    // A link type held in its own column applies to every link on that row.
    const rowType = (at(r, 'linkType').match(/\b(FS|SS|FF|SF)\b/i) || [])[1];
    // A Yes/No "Milestone" column marks this task as also being a sign-off gate; its own
    // name (if given) becomes a separate milestone right after the task finishes.
    const isMilestone = /^(y|yes|true|1)$/i.test(at(r, 'milestone'));

    return {
      id, name: rawName.trim(), level: Math.max(1, level),
      duration, pct: pctText === '' ? 0 : Math.min(100, Math.max(0, parseFloat(pctText.replace(/[^\d.\-]/g, '')) || 0)),
      preds: at(r, 'preds').split(/[,;]+/).map(x => x.trim()).filter(Boolean),
      _type: rowType ? rowType.toUpperCase() : '', _phase: at(r, 'phase'),
      _msName: isMilestone ? (at(r, 'milestoneName') || rawName.trim()) : '',
      _start: readDate(startText), _finish: readDate(finishText),
      _rawStart: String(startText || '').trim(), _rawFinish: String(finishText || '').trim(),
    };
  });

  let guessedDuration = 0, droppedLinks = 0, unreadDates = 0;
  tasks.forEach(t => {
    // Links are rewritten to the new ids; a link to something not in the file is dropped.
    const one = tok => {
      const clean = idKey(tok);
      const key = clean.replace(/(FS|SS|FF|SF).*$/i, '').replace(/[+-]\d+\s*$/, '').trim();
      if (!idMap.has(key)) return null;
      const link = parsePred(clean) || { id: 0, type: 'FS', lag: 0 };
      // An explicit type on the token wins; otherwise the row's Type column applies.
      return fmtPred({ ...link, id: idMap.get(key), type: link.type !== 'FS' ? link.type : (t._type || 'FS') });
    };
    t.preds = t.preds.flatMap(tok => {
      const whole = one(tok);            // "4", "#4", "4.0", "200FS+2"
      if (whole) return [whole];
      if (tok.includes('+')) {           // "part 1 + part 2" is a list, not a lag
        const parts = tok.split('+').map(x => one(x.trim())).filter(Boolean);
        if (parts.length) return parts;
      }
      // "(project start)" and other prose are not dropped links, they are just not links.
      if (/\d/.test(tok)) droppedLinks++;
      return [];
    });

    if (t.duration === null) {
      if (t._start && t._finish) {
        t.duration = Math.max(0, workdaysBetween(parseDate(t._start), addWorkdays(parseDate(t._finish), 1, cal), cal));
        guessedDuration++;
      } else t.duration = 1;
    }
    // Only tasks with nothing driving them keep their date, or the links would be pointless.
    if (t._start && !t.preds.length) t.start = t._start;
    else if (t._rawStart && !t._start) unreadDates++;
    delete t._start; delete t._finish; delete t._rawStart; delete t._rawFinish; delete t._type;
  });

  // Splice in a zero-day milestone right after any task the Milestone column flagged,
  // before phase grouping runs so each lands in the same phase as the task it follows.
  let milestonesAdded = 0, msNextId = body.length + 1;
  tasks = tasks.flatMap(t => {
    const msName = t._msName; delete t._msName;
    if (!msName) return [t];
    milestonesAdded++;
    return [t, { id: msNextId++, name: msName, duration: 0, level: t.level, preds: [String(t.id)], pct: 0 }];
  });

  // A Phase/Group column becomes real summary rows, so the outline matches the sheet.
  let grouped = tasks;
  const phases = tasks.map(t => t._phase || '');
  if (col.phase !== undefined && col.wbs === undefined && phases.some(Boolean)) {
    let nextId = tasks.length + 1;
    grouped = [];
    let current = null;
    tasks.forEach((t, i) => {
      if (phases[i] && phases[i] !== current) {
        current = phases[i];
        grouped.push({ id: nextId++, name: current, duration: 0, level: 1, preds: [], pct: 0 });
      }
      grouped.push({ ...t, level: current ? t.level + 1 : t.level });
    });
    notes.push('Grouped the tasks under ' + grouped.filter(t => t.level === 1).length + ' phase heading(s) from the Phase column.');
  }
  grouped.forEach(t => delete t._phase);

  // A row with subtasks is a summary here, so its own duration is ignored anyway.
  const kids = childrenOf(grouped);
  grouped.forEach((t, i) => { if (kids[i].length) { t.duration = 0; t.preds = []; } });
  tasks = grouped;

  if (milestonesAdded) notes.push(milestonesAdded + ' milestone(s) added from the Milestone column, each right after the task it follows.');
  if (guessedDuration) notes.push(guessedDuration + ' task(s) had no duration, so it was worked out from their start and finish dates.');
  if (droppedLinks) notes.push(droppedLinks + ' predecessor reference(s) pointed outside the file and were dropped.');
  if (unreadDates) notes.push(unreadDates + ' date(s) were not in YYYY-MM-DD format and were ignored.');
  if (col.duration === undefined && col.start === undefined) notes.push('No duration column was found, so every task was given 1 day.');
  return { tasks, notes };
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
    NATIONAL_CALENDARS, applyNationalCalendar, tasksFromRows, parseCsv,
    addWorkdays, nextWorkday, prevWorkday, workdaysBetween, isWorkday, parseDate, fmtDate,
  };
}
