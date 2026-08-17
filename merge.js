// Three-way merge for the shared plan, so two people publishing at the same time keep
// both sets of edits instead of one replacing the other.
//
// Inputs are three whole workspaces: the one the publisher started from (base), the one
// they are publishing (mine), and the one currently stored (theirs). The rule per field
// is the usual one: if only one side changed it, take that side; if both changed it the
// same way, no problem; if both changed it differently, the publisher wins and the
// disagreement is reported so the app can say so.
//
// Tasks and projects are matched by stable id, never by position, so reordering on one
// side doesn't scramble the other's edits.

const { parsePred } = require('./schedule');

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// Legacy workspaces have no project ids. Index-derived ids are deterministic, so two
// clients normalising the same old file agree on them.
function withIds(ws) {
  if (!ws || !Array.isArray(ws.projects)) return ws;
  return { ...ws, projects: ws.projects.map((p, i) => (p.pid ? p : { ...p, pid: 'p' + i })) };
}
const byId = (list, key) => new Map((list || []).map(x => [x[key], x]));

function mergeFields(base, mine, theirs, skip, conflicts, where) {
  const out = {};
  const keys = new Set([...Object.keys(mine || {}), ...Object.keys(theirs || {})]);
  for (const k of keys) {
    if (skip.includes(k)) continue;
    const b = base ? base[k] : undefined, m = mine ? mine[k] : undefined, t = theirs ? theirs[k] : undefined;
    if (same(m, t)) { out[k] = m; continue; }         // both agree (or only one exists)
    if (same(b, m)) { out[k] = t; continue; }         // I didn't touch it -> take theirs
    if (same(b, t)) { out[k] = m; continue; }         // they didn't touch it -> mine
    out[k] = m;                                       // both changed it: publisher wins, but say so
    conflicts.push(where + ' ' + k);
  }
  return out;
}

function mergeTasks(base, mine, theirs, conflicts, where) {
  const b = byId(base, 'id'), t = byId(theirs, 'id'), m = byId(mine, 'id');
  const mineIds = new Set((mine || []).map(x => x.id));
  const deleted = new Set();
  for (const was of base || []) {
    const label = where + ' task ' + was.id + ' "' + (was.name || '') + '":';
    const iHaveIt = m.has(was.id), theyHaveIt = t.has(was.id);
    if (iHaveIt && theyHaveIt) continue;
    if (!iHaveIt && !theyHaveIt) { deleted.add(was.id); continue; }          // both deleted it
    if (!theyHaveIt) {
      // They deleted a task I still have. Dropping it would throw away my edits without
      // a word, so an edited task survives the delete and the clash is reported.
      if (same(m.get(was.id), was)) deleted.add(was.id);
      else conflicts.push(label + ' deleted by a teammate, your edits kept it');
    } else {
      deleted.add(was.id);                                                   // I deleted it
      if (!same(t.get(was.id), was)) conflicts.push(label + " you deleted it, a teammate's edits went with it");
    }
  }

  // Start from my order — the publisher's view of the plan is the one on their screen.
  const out = [];
  for (const m of mine || []) {
    if (deleted.has(m.id)) continue;
    const other = t.get(m.id);
    out.push(other ? mergeFields(b.get(m.id), m, other, [], conflicts,
      where + ' task ' + m.id + ' "' + (m.name || '') + '":') : m);
  }

  // Then splice in tasks they added, each after whichever of its predecessors survived,
  // so a new subtask lands next to its phase rather than at the bottom.
  (theirs || []).forEach((task, i) => {
    if (mineIds.has(task.id) || b.has(task.id) || deleted.has(task.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex(x => x.id === theirs[j].id);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, task);
  });
  return out;
}

function mergeProjects(base, mine, theirs, conflicts) {
  const b = byId(base, 'pid'), t = byId(theirs, 'pid');
  const mineIds = new Set((mine || []).map(p => p.pid));
  const deleted = new Set([
    ...(base || []).filter(p => !mineIds.has(p.pid)).map(p => p.pid),
    ...(base || []).filter(p => !t.has(p.pid)).map(p => p.pid),
  ]);

  const out = [];
  for (const m of mine || []) {
    if (deleted.has(m.pid)) continue;
    const other = t.get(m.pid), older = b.get(m.pid);
    if (!other) { out.push(m); continue; }             // project only I have
    const where = '"' + (m.name || 'project') + '"';
    out.push({
      ...mergeFields(older, m, other, ['tasks'], conflicts, where),
      tasks: mergeTasks(older && older.tasks, m.tasks, other.tasks, conflicts, where),
    });
  }
  for (const other of theirs || []) {
    if (mineIds.has(other.pid) || b.has(other.pid) || deleted.has(other.pid)) continue;
    out.push(other);                                   // project only they have
  }
  return out;
}

// -> { data, conflicts: [...] }
function mergeWorkspaces(baseRaw, mineRaw, theirsRaw) {
  const mine = withIds(mineRaw);
  if (!theirsRaw || !Array.isArray(theirsRaw.projects)) return { data: mine, conflicts: [] };
  if (!baseRaw || !Array.isArray(baseRaw.projects)) return { data: mine, conflicts: [] };
  const base = withIds(baseRaw), theirs = withIds(theirsRaw);
  const conflicts = [];
  const projects = mergeProjects(base.projects, mine.projects, theirs.projects, conflicts);
  const nextPid = Math.max(Number(mine.nextPid) || 1, Number(theirs.nextPid) || 1);
  projects.forEach(p => {
    // Ids must never be reused after a merge, or two tasks could collide later.
    const maxId = Math.max(0, ...(p.tasks || []).map(x => Number(x.id) || 0));
    p.nextId = Math.max(Number(p.nextId) || 1, maxId + 1);
    // A link whose target one side deleted would leave the plan unschedulable for
    // everyone, so it is dropped here and named rather than left to break the app.
    const alive = new Set((p.tasks || []).map(x => x.id));
    (p.tasks || []).forEach(task => {
      const links = task.preds || [];
      const kept = links.filter(l => alive.has((parsePred(l) || {}).id));
      if (kept.length !== links.length) {
        task.preds = kept;
        conflicts.push('"' + (p.name || 'project') + '" task ' + task.id + ' "' + (task.name || '') +
          '": link to a deleted task removed');
      }
    });
  });
  return { data: { ...mine, projects, nextPid }, conflicts };
}

if (typeof module !== 'undefined') module.exports = { mergeWorkspaces, withIds };
