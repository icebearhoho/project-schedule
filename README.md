# Project Planner

Tiny MS-Project-style planner: task grid + Gantt, exports to MS Project XML, Excel, CSV.
No build step, no npm install. Node 18+ only.

## Run

```bash
node serve.js
```

Open http://localhost:5173.

## Draft, then publish

Your edits are a **private draft** until you press **Publish changes**. Nothing touches
the shared file while you're typing, so you can rearrange a plan freely without everyone
watching each keystroke — and without hammering the server.

- The **Publish changes** button turns red and pulses while you have unpublished work,
  and the toolbar says `DRAFT - not published yet`.
- **Discard draft** throws your draft away and reloads the published version.
- A draft survives closing the tab (it's kept in your browser); closing with unpublished
  work warns you first.
- If a teammate publishes while you're drafting, you're told, and your draft is left
  alone. Publishing then needs a second, deliberate click labelled
  **Publish (overwrites theirs)** — or press **Discard draft** to take their version.
- **local only (this browser)** in the toolbar means no server was reachable (e.g. you
  opened `index.html` by double-clicking it); edits stay in that browser.

Teammates on the same office network can use `http://<your-ip>:5173` while it runs.

## Outline (WBS)

**Indent** makes a row a subtask of the row above; **Outdent** promotes it. A row with
subtasks becomes a **summary**: grey and bold, dates spanning its children, duration and
% complete rolled up (weighted by each subtask's length), and a `−`/`+` to fold it away.
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

Exports always cover the project you're looking at. **Save .json** saves the current
project; **Open .json** adds a saved project (or a whole workspace) to the list — which
is how you reuse one as a template.

## Working calendar

**Working calendar** opens a panel per project: tick which weekdays are working days
(any combination — a 6-day week is fine) and list holidays or shutdown days, one
`YYYY-MM-DD` per line. Durations, links and lag all count in working days, so a holiday
pushes everything after it. Non-working days are shaded in the Gantt and exported into
the MS Project XML as calendar exceptions.

## Dependencies

The **Pred** column takes MS Project syntax. Separate several with commas.

| You type | Means |
|---|---|
| `3` or `3FS` | finish-to-start: starts after task 3 finishes |
| `3SS` | start-to-start: starts when 3 starts |
| `3FF` | finish-to-finish: finishes when 3 finishes |
| `3SF` | start-to-finish: finishes when 3 starts |
| `3SS+2`, `3FF-1` | same, with lag/lead in **working** days |

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

**3. Always-on hosting, free (real answer for a team).** Render's *free* plan needs no
payment details — only its persistent disk costs money, so the plan is stored in this
GitHub repo instead. Every publish becomes a commit on the `plan-data` branch, which
means the plan survives restarts *and* you get its full history.

1. Create a GitHub token: **Settings > Developer settings > Personal access tokens >
   Fine-grained tokens > Generate new token**. Repository access: only
   `project-schedule`. Permissions: **Contents: Read and write**. Copy the token.
2. Sign in at https://render.com with that GitHub account.
3. **New > Blueprint**, pick `icebearhoho/project-schedule`, **Apply** (it reads
   `render.yaml`). If the repo isn't listed, click **Configure account** and grant
   access, or paste the repo URL in the **Public Git repository** field.
4. In the service's **Environment** tab set `GITHUB_TOKEN` to the token from step 1 and
   `PLANNER_TOKEN` to a password your team will share.
5. Send teammates the URL and that password.

What free costs you: after ~15 minutes with nobody connected the instance sleeps, and
the next visit takes ~30s to wake. While anyone has the page open it stays awake, since
the page polls every 3 seconds.

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

Back it up by copying `project.json`, or from the app with **Save .json**.

## Exports

| Button | File | Chart included? | Opens in |
|---|---|---|---|
| Export .xml | MSPDI XML | yes, MS Project draws its own Gantt from the dates | MS Project (File > Open), ProjectLibre |
| Export .xlsx | Excel workbook | yes, Gantt bars as coloured day cells next to the task columns | Excel, Google Sheets |
| Export .pdf | print dialog | yes, exactly what's on screen | anything |
| Export .csv | CSV | no, data only | anything |
| Save .json | app's own format | n/a | this app (**Open .json**) |

**PDF**: the button opens your browser's print dialog — choose *Destination: Save as PDF*.
The toolbar is hidden, the whole Gantt is unrolled (no scrollbars) and scaled to fit A3
landscape. Chrome needs *More settings > Background graphics* left on, or the bars print white.

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
