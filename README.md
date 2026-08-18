# Project Planner

Tiny MS-Project-style planner: WBS task grid + Gantt, FS/SS/FF/SF dependencies, exports
to MS Project XML, Excel, PDF and CSV. No build step, no npm install. Node 18+ only.

| File | What it is |
|---|---|
| `index.html` | the whole app (grid, Gantt, exports, draft/publish) |
| `schedule.js` | scheduling engine — dates, links, rollups, calendar |
| `storage.js` | where the shared plan lives: local file, or a GitHub repo |
| `serve.js` | static files + API, for running as a normal server |
| `api/data.js` | the same API as a serverless function (Vercel) |
| `merge.js` | combines two people’s edits when they publish at once |
| `test.js` | `node test.js` — scheduler, import, merge, storage and API checks |

## Run

```bash
node serve.js
```

Open http://localhost:5173.

## Draft, then publish

Your edits are a **private draft** until you press **Publish changes**. Nothing touches
the shared file while you're typing, so you can rearrange a plan freely without everyone
watching each keystroke — and without hammering the server.

- The **Publish changes** button in the header highlights and pulses while you have
  unpublished work, and the status pill next to it reads `Draft — …`.
- **Discard draft** throws your draft away and reloads the published version.
- A draft survives closing the tab (it's kept in your browser); closing with unpublished
  work warns you first.
- If a teammate publishes while you're drafting, you're told, and your draft is left
  alone. Publishing then needs a second, deliberate click labelled
  **Publish (merges with theirs)** — or press **Discard draft** to take their version.
- **local only (this browser)** in the status pill means no server was reachable (e.g. you
  opened `index.html` by double-clicking it); edits stay in that browser.

### Two people publishing at once

Drafts never collide: they live in each person's browser and touch nothing shared.

Publishes are **merged, not overwritten**. Each publish carries the version it was built
on, so the server can tell your changes apart from anyone else's and combine them:

- edits to **different tasks** both survive
- edits to **different fields of the same task** both survive (your % and their rename)
- a task **either of you added** is kept, landing next to the row it followed
- a task **either of you deleted** stays deleted
- your **row order** wins, and their edits still apply to the rows you moved

Only when you both change the *same field of the same task* to different values is there
a real conflict. The one publishing keeps their value, and the toolbar names exactly what
was kept, e.g. `1 field kept yours: "Site" task 2 "Build": duration`. Nothing is lost
silently — the other person's version is still in the plan's history on the `plan-data`
branch.

Publishes are also serialized, so two arriving in the same millisecond cannot interleave.

**Long drafts.** None of this depends on publishing quickly. A draft left open for hours
still merges against whatever the plan has become in the meantime, however many times
other people published. While you draft, the toolbar tells you a teammate has published;
your draft is never touched until you press the button.

Two cases are worth knowing about, because a merge is textual and cannot read intent:

- **They deleted a task you had been editing.** Your edits win — the task stays, and the
  toolbar names it. Losing an afternoon's work to someone else's delete would be the
  worse outcome, and a task that shouldn't be there is easy to delete again.
- **A link pointed at a task that got deleted.** The link is removed and named, so the
  plan still schedules. Without that, one person's delete would leave everyone staring
  at "unknown predecessor" until someone fixed it by hand.

What a merge cannot do is judge meaning: if you shortened a task because a teammate's
phase moved, and they then moved it back, both edits are kept and the result may be a
plan neither of you intended. The safeguard is the message naming what was combined —
read it, and glance at the affected rows.

Teammates on the same office network can use `http://<your-ip>:5173` while it runs.

## Outline (WBS)

**Indent** makes a row a subtask of the row above; **Outdent** promotes it. A row with
subtasks becomes a **summary**: grey and bold, dates spanning its children, duration and
% complete rolled up (weighted by each subtask's length), and a chevron to fold it away.
The WBS column numbers rows as `1`, `1.1`, `1.2`, `2`. Up/Down move a row with its whole
subtree, and deleting a summary offers to take its subtasks with it.

Other tasks can depend on a summary (it means "when that whole phase is done"). Links
put *on* a summary row are ignored, with a note in the yellow bar — put them on the
subtasks instead.

**Ctrl+Z** (or the Undo button) walks back through the last 100 changes.

## Multiple projects

The **Project** dropdown switches between plans; **New** and **Delete project** manage
the list. All projects live in one workspace file and are published together, so
switching projects is not itself a change and won't mark a draft.

Exports always cover the project you're looking at. **File > Save project** saves the
current one; **File > Open project** adds a saved project (or a whole workspace) — which
is how you reuse one as a template.

## Importing a spreadsheet

**File > Import tasks (.xlsx, .csv)** reads a sheet into a **new project**, so an import
can never damage the plan you have open. Combine it in afterwards if that's what you want.

Columns are matched by their heading, in any order, and extra columns are ignored:

| It looks for | Also accepts |
|---|---|
| Task name | Name, Task, Description, Activity |
| Duration | Days, Dur — and values like `5 days` |
| Start / Finish | `YYYY-MM-DD`, or real spreadsheet date cells |
| Predecessors | Pred, Depends — including `3SS+2` style links |
| ID | UID, Ref, Task ID — used to resolve those links |
| WBS | gives the outline depth (`1.2.1` = three levels deep) |
| % Complete | %, Percent, Progress |

Anything it has to work out is reported in the yellow bar rather than done quietly:

- **No duration column?** It's calculated from Start and Finish in working days, or
  defaults to one day.
- **Links pointing outside the file** are dropped and counted.
- **Outline depth** comes from the WBS codes, or failing that from leading spaces in the
  task names — which is what this app's own CSV export writes.
- **Only tasks with no predecessors keep their date** as a pin. Pinning everything would
  make the dependencies decorative.
- The new project **inherits the working calendar** of the project you were viewing,
  since a spreadsheet carries no calendar of its own.

A sheet with no recognisable task-name column is refused with an explanation instead of
producing an empty project.

## Combining projects into one

**File > Combine into this project** folds another project in as a single phase: its
tasks become subtasks of a summary row named after it. Use it when someone planned their
part separately, or to drop in a saved standard phase as a template.

What it takes care of:

- **Task ids are renumbered** so they cannot clash with the ones already here, and the
  links inside the imported project are rewritten to the new ids, keeping their type and
  lag (`2SS+2` still means the same pair afterwards).
- **Outline shape is preserved** — everything moves down one level, so an imported phase
  with its own subtasks keeps its structure. WBS renumbers automatically.
- **Its colour comes with it**: the new phase takes the imported project's colour, so
  its tasks stay visually grouped.
- **Dates don't slide.** If the imported project started later than this one, its opening
  tasks are pinned to that date rather than quietly moving earlier. Clear the Start cell
  to release them.
- Anything worth knowing — a different working calendar, a link pointing at a task that
  didn't come along — is reported in the yellow bar rather than applied silently.

The original project stays in the list; delete it once you're happy with the master plan.

**This is what makes cross-phase dependencies possible.** Predecessors resolve inside one
project, so `Services` can only wait for `Frame` once both live in the same plan. Combine
first, then link across the phases.

## Working calendar

**Schedule** in the toolbar opens a panel per project: tick which weekdays are working days
(any combination — a 6-day week is fine) and list holidays or shutdown days, one
`YYYY-MM-DD` per line. Durations, links and lag all count in working days, so a holiday
pushes everything after it. Non-working days are shaded in the Gantt and exported into
the MS Project XML as calendar exceptions.

### Public holidays

One-click presets live in the **Schedule** panel: **Singapore** and **China**, for 2026
and 2027. Clicking one adds its dates to this project's holiday list — they stack (add
both countries, or both years) and clicking twice adds nothing new. The dates then sit in
the text box as ordinary lines you can edit.

**A dashed button marked `*` means that year's official notice isn't published yet**, so
those dates are estimates. Hovering says which ones. Today that's both 2027 presets:

| Preset | Confidence |
|---|---|
| Singapore 2026, China 2026 | published dates |
| Singapore 2027 | fixed dates and Good Friday (26 Mar, Easter is 28 Mar 2027) are certain; Chinese New Year, Hari Raya Puasa/Haji, Vesak and Deepavali are estimates |
| China 2027 | statutory days only — the State Council normally extends them with bridge weekends; the lunar dates are estimates |

> Treat every preset as a starting point, not an authority. Lunar and Islamic holidays
> move, days in lieu are gazetted per year, and **China's make-up working weekends
> (调休) are announced annually and are deliberately never included** — I won't invent
> them. Check against
> [gov.cn](https://www.gov.cn/) and
> [mom.gov.sg](https://www.mom.gov.sg/employment-practices/public-holidays),
> then edit the list.

### Extra working days

Some countries work a normally-free day to bridge a long holiday — China's 调休
Saturdays. List those under **Extra working days** and they count as working days even
though the weekday is unticked or the date is also in the holiday list. They export to
MS Project as working exceptions, so it schedules them the same way.

## Phases and colours

**Add phase** creates a summary row with a first subtask already under it — the quickest
way to give a plan structure. (A phase is just a task with children; **Indent** on
existing rows does the same thing by hand.)

**Colour** sets the chart colour of the selected row, or of the whole project. A phase's
colour carries down to its subtasks unless a subtask picks its own, so one click colours
a whole workstream. The eight colours are mid-tones chosen to clear 3:1 contrast against
both the light and the dark background, and the completed part of each bar is derived
from the bar's own colour — darker on light, lighter on dark. The Excel export uses the
same colours.

Each bar is labelled with its task name and, once you set one, its percentage. The label
never lives inside the bar, so a one-day bar can still show a long name:

- normally the name sits **after** the bar,
- if the bar runs to the right edge, the name moves **before** it,
- if the bar fills the pane (usually in `Day` view) the name rides **on** it in a chip,
  so it stays on a readable background rather than on the bar colour,
- when there is genuinely no room, the text is cut with an ellipsis and the tooltip
  carries the full name, dates and percentage.

A bar is drawn only on the days the task actually occupies: it breaks over weekends,
holidays and any day you untick in **Schedule**, so its painted length matches the day
count in the grid. (Below about 8px per day the gaps would read as noise, so at `3 months`
and wider zooms the bar is drawn solid.)

## Room for the chart

Drag the divider between the table and the chart to give either side more room — the
timeline refits as you drag, so a wider chart means wider days rather than more
scrolling. Drag it fully left for chart-only; double-click it to reset. It also takes
arrow keys (with Shift for bigger steps) when focused, and the position is remembered
per browser.

The expand button next to the range buttons puts the plan **full screen**; Esc or the
button in the corner comes back.

## Timeline focus

The **Day / Week / Month / 3 months / All** buttons set how much calendar the Gantt shows
at once. A chosen range is scaled to fit the pane exactly, so there's nothing to scroll —
pick `Week` and you get one wide week, pick `3 months` and the quarter is squeezed in.
`All` goes back to the whole plan at a fixed day width, scrolling sideways.

`‹` and `›` move the window (by three quarters of a span, so you keep some overlap) and
**Today** jumps back to now. A task whose bar falls outside the window keeps its row and
shows a small arrow at the edge pointing the way, so nothing silently disappears.

The view is per browser, not part of the plan: changing it never marks a draft and never
affects what teammates see. Exports are unaffected too — Excel always covers the whole
plan; only the PDF follows what's on screen, since it prints the current view.

## Light and dark

The sun/moon button in the header cycles **System → Light → Dark**. System follows your
OS setting; the other two override it. Like the timeline view, it's stored per browser
and is never part of the plan, so your choice doesn't follow teammates around.

Both palettes are built from the same tokens and tuned to the same rhythm: page darker
than the surface it holds, one accent, and the completed part of a bar always the more
prominent blue of the pair — darker than the bar in light, brighter in dark, so "done"
reads the same way in both. Every text pair clears WCAG AA (4.5:1) in both themes, and
bars clear 3:1 against their row. Printing always uses the light palette on white paper,
whichever theme is on screen.

## Dependencies

The **Pred** column takes MS Project syntax. Separate several with commas.

| You type | Means |
|---|---|
| `3` or `3FS` | finish-to-start: starts after task 3 finishes |
| `3SS` | start-to-start: starts when 3 starts |
| `3FF` | finish-to-finish: finishes when 3 finishes |
| `3SF` | start-to-finish: finishes when 3 starts |
| `3SS+2`, `3FF-1` | same, with lag/lead in **working** days |

**Start** and **Finish** are date pickers. Start is filled in with the scheduled date;
picking one pins the task to "no earlier than that" and shows it in the accent colour.
Picking a **Finish** date sets the duration that lands on it, counting working days only.
Summary rows and milestones show their dates as plain text, since they are derived.

Nothing is scheduled before the project start date, so a link that would push a task
earlier than that is clamped to it. Unreadable entries and circular links show up in
the red bar instead of silently doing the wrong thing.

## Share it with teammates

Three ways, cheapest first.

**1. Same office network (zero setup).** Keep `node serve.js` running and send them
`http://<your-ip>:5173` — on this machine that's `http://10.100.161.54:5173`. Works only
while your PC is on and they're on the same network. Windows will ask to allow Node
through the firewall the first time; say yes for private networks.

**2. Temporary public link (no account).** With the server running, in another terminal:

```bash
ssh -R 80:localhost:5173 nokey@localhost.run
```

It prints a public https URL anyone can open. Dies when you close the terminal or shut
down, so set `PLANNER_TOKEN` first if the plan isn't public information.

**3. Always-on hosting, free.** There is no disk to pay for: the plan is stored in this
GitHub repo, as a file on a `plan-data` branch. Every publish is a commit, so the plan
survives restarts *and* you get its history.

First, the token both options need: GitHub **Settings > Developer settings > Personal
access tokens > Fine-grained tokens > Generate new token**. Repository access: only
`project-schedule`. Permissions: **Contents: Read and write**. Copy it.

*Vercel* (Hobby plan, no payment details):

1. https://vercel.com > **Add New > Project** > import `icebearhoho/project-schedule`.
2. Framework preset **Other**, no build command. Deploy.
3. **Settings > Environment Variables**: `GITHUB_TOKEN` = your token,
   `GITHUB_REPO` = `icebearhoho/project-schedule`, `PLANNER_TOKEN` = a shared password.
   Redeploy so they take effect.

`api/data.js` is the serverless half; the page itself is served as a static file. Never
sleeps, and there's no wake-up delay.

*Render free plan* — note that Render asks for a payment method for **Blueprints**, so
skip `render.yaml` and create the service by hand:

1. **New > Web Service** > connect the repo.
2. Runtime `Node`, build command empty, start command `node serve.js`, instance type
   **Free**.
3. Add `GITHUB_TOKEN`, `GITHUB_REPO` and `PLANNER_TOKEN` as environment variables.

Free Render instances sleep after ~15 minutes with nobody connected, so the next visit
waits ~30s for a wake-up; while anyone has the page open the 3-second polling keeps it
awake.

Later changes go live with:

```bash
git push
```

Railway, Fly.io, or any $5 VPS work the same way — start command `node serve.js`,
it uses `$PORT` if the host sets one.

Environment variables:

| Var | Meaning |
|---|---|
| `PORT` | listen port (default 5173) |
| `PLANNER_TOKEN` | shared password; asked once per browser, or pass `?key=...` |
| `DATA_FILE` | local storage path (default `./project.json`), used when no `GITHUB_TOKEN` |
| `GITHUB_TOKEN` | fine-grained token, Contents read+write; switches storage to GitHub |
| `GITHUB_REPO` | `owner/name` holding the plan |
| `GITHUB_BRANCH` | branch to commit to (default `plan-data`, deliberately not `main`) |
| `GITHUB_PATH` | file in that branch (default `plan.json`) |

Locally, with no `GITHUB_TOKEN` set, nothing changes — it still uses the local file.

Back it up by copying `project.json`, or from the app with **File > Save project**.

## Exports

| Button | File | Chart included? | Opens in |
|---|---|---|---|
| Export > MS Project XML | MSPDI XML | yes, MS Project draws its own Gantt from the dates | MS Project (File > Open), ProjectLibre |
| Export > Excel with Gantt | Excel workbook | yes, Gantt bars as coloured day cells next to the task columns | Excel, Google Sheets |
| Export > PDF / print | print dialog | yes, exactly what's on screen | anything |
| Export > CSV | CSV | no, data only | anything |
| File > Save project | app's own format | n/a | this app (**File > Open project**) |

**PDF**: the menu item opens your browser's print dialog — choose *Destination: Save as PDF*.
The toolbar is hidden, the whole Gantt is unrolled (no scrollbars) and scaled to fit A3
landscape. Chrome needs *More settings > Background graphics* left on, or the bars print white.

### Checking the XML is good

1. **Is it well formed?** Open it in Chrome or Edge. A collapsible tree means the file is
   valid XML; a red parse error means it is not.
2. **Does a scheduler accept it?** The real test: install the free
   [ProjectLibre](https://www.projectlibre.com/), then **File > Open** and pick the
   `.xml`. Your tasks, outline, links and dates should appear with a Gantt beside them.
   MS Project: **File > Open > Browse**, set the file-type filter to XML, pick the file.
3. **Did everything survive?** Compare the task count, the WBS numbers and the finish
   date of the last task against this app. Those three matching means the export is sound.

**The `.xml` export is not a document to look at** — double-clicking it opens your
browser, which shows the raw code. It is an interchange file: open MS Project (or the
free ProjectLibre), then **File > Open**, switch the file-type filter to XML, and pick it.
For something readable on its own, use the PDF or Excel export.

`.mpp` is not possible — it's a closed binary format; XML is Microsoft's supported
interchange file. The `.xlsx` export pulls the ExcelJS library from a CDN on first click,
so that one button needs internet; the rest of the app doesn't.

## Scheduling rules

Forward pass, finish-to-start links, Mon–Fri working days, 8h days. Duration `0` = milestone.
The **Start** column is optional and means "not before this date". Circular links are
reported instead of hanging.

## Test

```bash
node test.js
```

Covers weekend skipping, milestones, cycle detection, and the server's
conflicting-save rejection.

## Not implemented

Resources and assignments (the column was removed on request), workload and levelling,
cost and effort, critical path and baselines, kanban board, dashboard, comments, and
per-user logins — everyone with the URL and team key is an editor.
