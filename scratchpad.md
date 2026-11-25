# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## BUILD: merged admin + paid delivery. On branch `merged-admin`, P1-P4 and M1-M6 done, live

**M3 done 2026-11-06 (local, not pushed).** The portal is mounted in billing's `app.js`: trust proxy always 1
hop; `hub-api` serves `/hub/*` and `/health` only (Host header); billing's CORS skips `/hub` and ignores portal
origins; the portal router sits before billing's JSON parser, with the raw-body slot above it for B1's webhook.
Without both `HUB_` secrets billing starts and `/hub` answers 503. Tests: `test-portal-mount.js`. 917/917,
three local runs; the real server booted on a throwaway folder with and without the hub secrets.
- Review fixes before M3 (`f2e54f3`): `openDatabase` copies before migrating by default (scripts too), hub writes
  take the pre-write copy, JSON 404s and errors under `/hub`.
- Before M6: check the tunnel's `hub-api` route keeps the Host header (TASKS Live Settings).
- M3 review fixes: client sign-in limited per address (billing's `rateLimit`) and per email (10 wrong codes in
  15 min); the hub reads billing's `clientIp`; the `hub-api` check compares one spelling of the host;
  `/health` is plain `ok` again, the deliverables state is `GET /hub/deliverables-health`; `TRUST_PROXY` retired.
  The portal shows a 429 on sign-in as "network" today; its rebuild should say "too many tries".

**M4 done 2026-11-06 (local, not pushed).** The server serves `admin/web` (`server/src/web.js`): `js/config.js`
written per request (API = page origin, `LSC_MAPS_KEY`/`LSC_MAPS_ID`), pages `no-cache` with scripts and
stylesheets stamped `?v=<content hash>`, only current-stamp addresses cached long; only the pages' folders are
served. Cookie default `lax`. Docker builds from `admin/` (`admin/docker-compose.yml`, `admin/.dockerignore`).
Review fixes (M4 review): won't start without `web/` or with a mismatched `calc.js`/`documents.js`/`call-sheet.js`;
`/api` replies carry `X-LSC-Version` and an open tab shows a Reload banner (`js/update.js`); 933/933.
`test-web.js`; 928/928; checked in a real browser (launch config `admin`, port 8090, `/tmp/lsc-admin-scratch`):
with the old `calc.js` cached, a changed file loaded under its new stamp. Image build and the Cloudflare
header check wait for M6 (Docker wasn't running). New M6 settings in TASKS Live Settings: Maps key into
`.env`, Google OAuth redirect onto `app`, the app folder holding `server/` + `web/`.

**M5 done 2026-11-06 (local, not pushed).** `scripts/import-hub.js` (core `src/hub/import.js`) copies the hub's
tables into billing.db, never overwriting; a differing row undoes the run. Rehearsed on `.backup` copies of
both live DBs (deleted afterwards): live hub = schema 5, 31 file tokens, no records/logins/evidence. Run 1 added
31, runs 2-3 changed nothing; 28 live tokens serve 200 through the merged app, 3 point at deleted September test
files (dead today too). M6 steps for the import are in TASKS (copy with `.backup`, not `cp`: the hub's data sits
in its `-wal`). Backups are whole-file, every table covered (S16, tested). M5 review fixes: dead links/files
warn (exit 0), dry run on a throwaway copy, refuses while a server answers, strict args, tokens printed short;
re-rehearsed on fresh live copies (deleted after). 948/948 before the last output-only change; import tests 15/15.

**M6 in progress (2026-11-07).** Runbook: `.design/merged-admin/CUTOVER.md` (rollback first; its Progress
note is the live state). Prep done on the NAS from local `a0c2baa`: `/volume4/lsc-admin/{app,data}`, the NAS
compose (`lsc-admin`, `127.0.0.1:8098`, `LSC_ADMIN_DATA` override), `.env` built NAS-side (20 names), image
`lsc-admin:latest` built, full rehearsal on live copies 17/17 checks + PDF + 28/31 tokens (deleted after).
Old containers untouched and healthy. Pushed; draft PR LSCCreative/LSC-WEB.Studio#1. Waiting on the user:
P5 and P6 done 2026-11-07 (Maps values in the NAS `.env`, `app` redirect URI in Google). Pre-cutover review fixed (`21aba29`, 949/949; NAS image rebuilt, re-rehearsed 20/20). **Cut over 2026-11-07 19:43: live on `lsc-admin`, C1-C8 passed** (log in CUTOVER.md). C9 done: PR #1 merged as `dc6eac3` (site deploy ok, `/admin/` not published), lsc-billing-app's Pages workflow disabled. **M6 done.** Afterwards (CUTOVER.md): remove `CORS_ORIGINS` on 2026-11-14; old containers out after 2026-11-21 on the user's OK; repoint any hub `/health` monitor; ssh config + router reservation; `db.productiondecks.online` route still on .45.

**B1 done 2026-11-07: plan approved by the user and committed.** `buildplan.md` Slices
2-12 rewritten and `feature-spec.md`'s Decisions updated (not committed). Main changes: Bunny rows belong to a
deliverable version (R1), not a NAS path; admin publish/status move to `/api` behind billing's login; the server
builds (and in Slice 9 signs) media URLs when it answers; collections/storage paths use `projects.id`, not UPIDs or
folder names; Bunny pulls a 6h signed `/hub/source/` URL, not a permanent `/hub/files/` token; the webhook mounts
in the raw-body slot (S20) with a regression test; Slice 11 removes only what no client reply refers to, so Past
projects keep their files. User decisions 2026-11-07, now in the plan: no Bunny Optimizer (Slice 6 makes sizes with `sharp`;
ask before falling back to originals if it won't build on the NAS); add a manual Take offline button for archived
projects, explained on hover, focus and in the confirm dialog, with Bring back online (Slice 11); the desktop
widget is still wanted (Slice 10). **Order:** Slice 2 needs R1, R3, C1, C2, so per TASKS.md the next build task after B1 is **L1**,
not B2.

**L1 done 2026-11-07: look signed off by the user, ticked and committed.**
- `admin/web/css/tokens.css` = `.design/merged-admin/tokens.css`. Funnel Sans added as
  `web/fonts/FunnelSans-Variable.woff2` (from the installed TTF; licence read from the font: OFL 1.1).
- `app.css`: buttons are mono caps from `--btn-*`, plain `.btn` is an outline, new `.btn-confirm`
  (sage, not yet used: Approve/Confirm arrive with the portal work). All text fields and dropdowns
  take `--input-radius` through one `:where()` rule. `.stage-chip` gets 8px corners.
- All 30 sizes under 11px raised to `--font-size-xs`. The five `border-radius: 0` rules are deliberate
  (pencilled dot, rail tabs, flat sub-sections) and stay.
- Checked on the scratch admin: 11 screens at 1280/768/375, no page or button overflow. Calendar:
  Confirmed sage fill vs Proposed warm-grey shorter tile, distinct. `web/c/` quote page: computed
  styles identical old vs new on all 89 elements. 949 server tests pass.
- Scratch DB now holds a sample project `L1-TEST` (sent by link) for later visual checks.

**L2 done 2026-11-07 (not committed when written).** New `admin/web/js/shell.js` (`LSCShell`: AREAS, set,
title, setUser, bind) and `css/shell.css` (phone first). Header = wordmark + two area tabs (manual
activation) + account menu (declarative `LSCMenu`: Settings, Sign out). `#app-subnav` = the area's numbered
pages, not sticky, so every 52px sticky offset still holds. Titles "<Page> — <Area>"; login card "Scope &
Sales"; Finance tab + heading "Overview" (route id still `dashboard`). Old `#hdr-right`/compact menu and their
CSS removed from app.css/responsive.css/app.js. Checked on the scratch admin at 1280/768/375; guard asks on
tab, page, wordmark, sign-out; keyboard sign-out and sign back in land on the asked page. 949/949.
`#/pipeline` + the `?stage=` redirects moved to L3 (noted in TASKS.md L3).
Trap: a scripted `.click()` on an open menu item does nothing (the browser's re-entrant click rule); test
menus with real clicks or keys.

**L3 done 2026-11-07 (not committed when written).** Pipeline/Live split: one `ProjectsView` with `MODES`;
server `stage=pipeline|live`; redirects per IA except `accepted|invoiced` keep their chip (Live's own
addresses). `ProjectCard.placeOf(project)` + `LSCShell.placeProject(id, place)` decide the tab and Back crumb
from state (folder and invoice screens call it; `projectPlace(id)` carries it to estimate/call-sheet screens).
Review fixes (same day): list subtitle counts the whole list (sum of one-stage chips, so Pipeline's
Declined is in it); a card click notes its place first (`LSCShell.notePlace`) and estimate screens place
themselves on a deep link; folder Back uses `ProjectCard.backOf` (the list or client page one Back away,
via `LSCRouter.behindPath()`, else placeOf); old `?stage=` redirects keep `q`; server lists are one
`LISTS` map; new test with real accepted/invoiced/paid projects. Bare old `#/projects` now means Live
by design (it is Live's address). Tests 950/950.
Trap: a local `const next` in `show()` shadowed the module's paging cursor; the preview server keeps old
API code until restarted (`preview_stop` then start). Test post-acceptance pages by patching `LSCApi.get`.

**L4 done 2026-11-08 (not committed when written).** Every delete asks `clientDataHeld` (`src/projects.js`,
`CLIENT_DATA`: records, private_auth, agreement_evidence): project delete, last-estimate delete, setup merge
-> 409 `has_client_data`; client with projects -> 409 `has_projects`. R1/R3 must add their tables to
`CLIENT_DATA`; reword `clientDataRefusal` to point at Archive once R2 lands.
**L1-L4 review fixed 2026-11-08 (not committed):** one refusal helper (`clientDataRefusal(held, subject, verb,
advice)`) for delete and merge, lookups prepared once per db; merge refusal tested; `/hub/publish` now 404s
`unknown_project` unless `record.id` is a billing `projects.id` (the guard looks there; the old client-hub-app
publishes its own ids, so it can no longer publish; live hub never had records). Client page titled
"<Name> — Clients"; its Delete explains at once when the client has projects; a deleted project returns where
Back would. Root CLAUDE.md's responsive rules now name the marketing site only. 952/952; checked in the browser.

**R1 done 2026-11-08 (not committed when written).** Migration v22 (`src/migrations/v22-deliverables.js`):
`deliverables` (checklist items: title, format, duration, quote line, `stage` draft|final, `not_needed_at`) and
`deliverable_versions` (numbered per item, own stage, `source_path`, `published_at`; Bunny and C5 approvals hang
off a version), neither cascading from projects; projects gain `archived_at`, `no_deliverables_at`,
`payment_required` (0). v22 marks every already fully paid project `no_deliverables_at` once (IA: Complete at
import), so R4 needn't. `src/delivery.js`: `acceptEstimate` (both accept paths) links the client (project's, then
the quote's record, then match by email, then business name, else create from the quote; a quote with neither
stays without) and makes one item per quoted deliverable ("3 × Cut-down" = "Cut-down (1 of 3)".., max 50 a line),
once; activity detail gains `checklist` and `client`. `deliveryState()` is the IA table (Archived checked before
Live rows; empty checklist asks `checklist_empty` and never completes unless `no_deliverables_at`; payment off =
approval completes; payment claimed / downloads locked read future columns, absent today; flags `no_upid`,
`no_agreement`, `payment_required`). Folder reply: `project.delivery` + `deliverables`. `deliverables` added to
`CLIENT_DATA`. Mark accepted can't accept a project with no UPID (invoice numbers), so "No UPID" only arises via
signing; covered in the state tests. Old accepted projects with no client still get theirs in R4.
R1 review fixed (same day): matching folds in JS like the editor (accents); two clients sharing an email are
told apart by business name, else the oldest + activity `clientNote: shared_email`; a name match fills a missing
client email, or keeps its own and notes `email_differs`; a new client is named business || contact || email;
scheduled final counts as sent; the quote is loaded once after `confirmDays` and is the invoices' snapshot;
CLIENT_DATA rows carry their own reason (a checklist: "Accepted work stays on record…"); ROADMAP updated.
959/959; scratch admin migrated v21→v22 (backup taken), folder page clean.

**R2 done 2026-11-08 (not committed when written).** Schema v23 (emails normalised). `src/clients.js`: one spelling, one holder
(409 `email_taken`; existing shared pairs stay, warned on Client details), login moves with the email. Lists read `project.delivery`
(`deliveryReader`): Live = state model's group; `in-production`, `in-review`, `revisions`, `payment-due`, `current`, `complete`, `archived`.
Screens: client list search (project names, UPIDs), `#/clients/<id>/projects|details|invoices`, Archive/Unarchive, `js/subtabs.js`.
`test-client-record.js` 10/10. Checked in a real browser on scratch admin at desktop and 375: tabs by keyboard, unsaved guard between tabs,
archive focus, invoice table stacked, deep links, unknown client, unknown tab. Scratch DB now holds the R2 sample clients (ids `cl_r2*`) at v23.
Decisions to confirm are under R2 in TASKS.md.

**R3 done 2026-11-08 (not committed when written).** Schema v24. Accepted projects are four tabs, `ProjectFolder` + `project-deliverables.js`;
checklist, stage, versions and publish in `routes/deliverables.js`. PIN and hub editor routes gone; `/hub/publish-asset|status` behind billing's
login until Slice 2. 978+ tests. Checked on the scratch admin at desktop and 375: refusals beside the path field, publish dialog, stage flip, preview,
archive from the header, acceptance moving into the tabs, invoice Back to Payments, a hostile signer name rendered as text. Launch configs gained
`DELIVERABLES_DIR=/tmp/lsc-admin-scratch/deliverables`. Not checked: a real video playing in the preview (no small sample here; the error branch ran,
the Range route is tested), a day's Travel view link (scratch has no trips). Decisions to confirm are under R3 in TASKS.md.

R3 review fixed (same day, 10 findings): `streamFile` survives a failed read and lets a file go when the client leaves; `folderBack` only goes to a tab; a
deliverable counts as with the client from its first published version; adding an item clears "none expected"; publish says when the NAS is away; archived
projects are read-only on screen; a save keeps what's half-typed in the other forms; photo preview no longer lists per image; the real login on the Bunny
routes is tested and settings can't replace it.

**R4 done 2026-11-20 (not committed; R3 isn't committed either: last commit is R2).** Schema v25, `src/hub/adopt.js`,
`routes/hub-import.js`, screen `#/setup/hub-import` reached from Settings → Old hub. Details and calls to confirm under R4
in TASKS.md. This session finished what an earlier session left: wired the screen in (script tag, route, Settings section,
CSS), added `POST …/restore` (Bring back), the Documents "From the old hub" panel, fixed a 503-not-404 test setup, a
double change handler, the list forgetting imported projects when nothing is pasted, and phone overflow. Review fixes (same day): "Paste another list" reloads the server list; Bring back hands a browser-only copy back to the page; "New client" only reuses a same-named client with no other address; duplicate decisions are a 400; v25 carries a frozen copy of clientForAcceptance instead of calling live code. 1009/1009.
Scratch admin at `/tmp/lsc-admin-scratch` was re-seeded (it had been wiped): dev account, clients `cl_acme`, `cl_b1`/`cl_b2`
(shared email), and two imported test hub projects.
Trap: the import screen's unsaved guard (a list held only in the page) silently reverts a scripted hash change; test other
pages in a new tab.

**R5 done 2026-11-20 (committed 2026-11-24; R3 and R4 are in `ba3c15a`).** v26 `projects.opened_at`, `src/needs.js`, `GET /api/needs`, `web/js/needs.js`
(header count + Dashboard card). Later tasks add kinds in `readNeeds` (KINDS lists the IA order). Details and calls under R5 in TASKS.md. 1019 tests.

**Branch review fixes 2026-11-24 (committed).** `/code-review` of merged-admin vs main: 4 important fixed. (1) v25 reads the
accepted quote first, not the newest one (v25 hasn't run on live yet). (2) Only `GET /api/projects/:id?open=1` (the project page's
first load) stamps `opened_at`, and only with a valid `today`; Settings' agreement preview and the page's refresh no longer clear
"New project". (3) Add-version and publish re-read the item, version and archive state inside their write, after the NAS wait
(not reachable by a test today: the success path has no real await; it matters once Bunny's fetch sits in publish). (4) Reopen
deletes checklist items with no version and no hub_status (activity `checklistCleared`), so the next acceptance builds from the
quote. Left as reported: imported `accepted_at` unvalidated, Drive link editable on a published version. 1020/1020.

**C1 done 2026-11-24 (not committed).** v27 `client_logins` + `client_sessions`; `src/portal-access.js`, `src/hub/views.js`; portal
routes `/hub/auth` (cookie `lsc_portal`), `/hub/invite`, `/hub/session`, `/hub/sign-out`, `/hub/projects[/:id]`; studio
`GET|POST /api/clients/:id/portal`. Details and calls to confirm under C1 in TASKS.md. 1032/1032; leak test proven by a planted leak.
**C2 done 2026-11-24 (not committed).** Portal page rewritten on the tokens and C1's session; admin code gone; new
`GET /hub/projects/:id/versions/:versionId/review` plays published versions from the NAS (user's call). Details, calls and what
wasn't checked (Safari, iPhone, HLS) under C2 in TASKS.md. 1039/1039.
**To run the portal locally:** `sh scripts/copy-portal-tokens.sh`, then launch configs `portal-api` (8090, scratch db, throwaway
`HUB_SIGNING_SECRET`) and `lsc-static` (8734); open `http://127.0.0.1:8734/client-hub-app/` (127.0.0.1:8090 is the portal-only host,
localhost:8090 stays the admin). Scratch client `c2-tester@example.test` has a published video and three stills under
`/tmp/lsc-admin-scratch/deliverables/C2Test`; issue it a new code with `createPortalAccess(db,{secret}).issue(id)` (C6 builds the button).
**For C3:** the page opens one project (`openProjects` picks invite's, else the first current). The dashboard replaces that pick;
`portalProject()` is the one place the server's view becomes the page's model. Hash routes must keep `#/invite/<token>` working
(`boot` + the `hashchange` listener).

**C2 committed 2026-11-25 (`524ca18`), with the 10 review fixes.**

**C3 done 2026-11-25 (not committed).** Hash routes, dashboard, project page with invoices and the signed agreement. Details and
calls under C3 in TASKS.md. 1041/1041. Scratch tester (`c2-tester@example.test`) now also has an archived project `C3-PAST`, a
paid deposit and a sent final, a signed quote and an unpublished item; the other scratch client is `c2-other@example.test`.
**C3 review:** all 9 findings fixed (details under C3 in TASKS.md). 1042/1042.
**For C4:** notes and approvals live on `state.cache[projectId]` assets (`comments`, `status`), lost on reload; `carryOver()` keeps
them across a fresh read for the same version. C4 saves them: `portalProject()` is where server notes come in, and `bindAssetInteraction`/`bindPhotoLightbox` are where a note is added (keep the
partial repaint: no `setState` there). Photo notes are keyed by `photoKey` (the photo's review URL); the server's key is its `?photo=`.

**C3 committed 2026-11-25 (`9354c7f`).**

**C4 done 2026-11-25 (not committed), with its review fixes.** Scratch db got `client_notes.client_key` by hand (v28 changed after
it ran there; live has never run v28). v28 client notes and submissions; add, remove, send; the studio sees sent sets on the
item and in Needs you. Details, calls and the S16 check under C4 in TASKS.md. 1050/1050. Scratch: the tester's Hero film v1 and
Launch stills have sent sets (both items in Revisions); publish a v2 of either to reopen notes.
**For C5:** approvals join `client_submissions`' neighbours as their own table; `asset.approved` in the page is page-only today
(`carryOver` keeps it). Rounds: count `client_submissions` with stage 'final' per item. The rounds-used notice goes before the
revision box opens (`want-revisions`), and Send's dialog says the rounds left.

**C5 done 2026-11-25 (not committed).** v29 `client_approvals`; approve route; rounds and the rounds-used notice; the old hub's
`/hub/agreement` gone. Details and calls under C5 in TASKS.md. 1062/1062. Scratch (`/tmp/lsc-admin-scratch`, migrated to v29): the
tester's Hero film is a Final at v5, approved, with 3 final rounds (one extra); Cut-down 15s has its draft approved; the project's
signed agreement text now names $63.00. `delete from client_approvals` on the scratch db to approve again.
**C5 review:** all 8 findings fixed (details under C5 in TASKS.md), incl. Needs you's Send final invoice row. 1063/1063.
Restart `portal-api` after server edits: node doesn't reload, and a stale process showed "3 of 0 rounds".
**For C6:** Needs you's `revision_notes` rows carry `round`/`extraRound` for the "notes submitted" email; an approval logs
`client_approved` in activity. **For C7:** a deemed approval is a `client_approvals` row with `kind = 'deemed'` (client_id may be
NULL); `itemApproved` already counts it, and the portal shows `deemed`.

**C6 done 2026-11-25 (not committed).** Invite (first publish, one confirmation, or by hand) and the notes-submitted notice; details,
calls and what wasn't checked under C6 in TASKS.md. 1071/1071. Checked in the browser on the scratch admin (dialog, checklist line, invite emailed to the stub mailbox); the invite state now rides on every folder reply (`readFolder`), via `portal-invite.js setEnv`. Scratch project `C6-1` is invited; its client is `c6-tester@example.test`.
Code review fixes the same day (8 findings, all fixed, 1075/1075): invite wording by what's published, a failed invite's code kept on screen until dismissed and resendable (`retry`), refusal reasons in the publish toast, Needs you's final-invoice date, notes notice without APP_URL, round tie-break, and the approve reply's `itemStatus`. Launch config `portal-api-failmail` makes every email fail; scratch project `C6-2` (client `c6-fail@example.test`) went through a failed invite and a resend.

**C7 done 2026-11-25, committed 2026-11-26 as `aab3c80`.** Deemed-approval clock (`src/deemed.js`), the client's reminder (`src/deemed-reminders.js`, hourly from `index.js` and the stub script, schema v30), Mark approved on the item page (Needs you row opens it), Complete tested. Calls and what wasn't checked under C7 in TASKS.md. Scratch: `C7-1` was marked deemed approved (now Complete), `C7-2`'s clock runs to 10 Dec.
The same commit fixed `test-portal-approvals.js`: its TODAY was the UTC date, so it failed before 11am Sydney.

**C8 done 2026-11-26 (not committed).** View as client: schema v31 `portal_previews`, `POST /api/projects/:id/portal-preview`,
`/hub/preview` + `/hub/preview/end`, the read-only rule in the hub's `signedIn`, the header button and the portal's preview bar.
Calls and what wasn't checked under C8 in TASKS.md. Review fixes the same day (all 6), 1092/1092: previews apply only to calls
marked `?preview=1`, `portal_previews` cascades. Scratch db at v31; its `portal_previews` was rebuilt by hand for the cascade
(live has never run v31). In the browser pane the button's new tab is blocked as a popup, so the admin shows a link to click;
the pane blocks that too, so open the link's URL in a fresh tab to test (a hash-only change on an open portal page doesn't reload it).

**C9 in progress (2026-11-26).** Step 1: `merged-admin` pushed (`5853094`). Step 2: live db (v21) dry-run migrated to v31 on a
copy, no existing value changed, server boots on it. Step 3: **NAS deployed** at `5853094`: live backup
`data/backups/pre-c9-20261126-094514.db`, rollback image `lsc-admin:pre-c9` (`7e42400afaf3`), previous app folder
`/volume4/lsc-admin/app.prev-c9`; new image `178549010c2b`, migrated v21→v31 on boot, `m6-checks.sh` ALL PASS. The build takes
~10 minutes on the NAS (npm). **The NAS moved to 192.168.1.46** (same host keys as .45): use
`ssh -o HostName=192.168.1.46 -o HostKeyAlias=192.168.1.45 lsc-nas` until the router reserves it and ~/.ssh/config is updated.
Step 4: PR LSCCreative/LSC-WEB.Studio#2 merged as `f86adae`; the Pages run succeeded (tokens copied); the live portal loads,
reaches hub-api and shows sign-in (fonts and tokens load; only the signed-out 401 in the console).
**Rollback:** `cd /volume4/lsc-admin && mv app app.c9 && mv app.prev-c9 app && docker tag lsc-admin:pre-c9 lsc-admin:latest`, put the
pre-c9 db back as `data/billing.db` (container stopped), then `cd app && docker compose up -d` (no --build).
Left: step 5 (the user's real job on a phone), step 6 (tick C9, docs, CORS_ORIGINS, old containers, delete the live-db copy in
the session scratchpad).

**Next within C9: step 5, the user's real job on a phone.** Merge `merged-admin` to `main`, redeploy (NAS before Pages),
one real job start to finish with a test client on a real phone. Payment stays off. Ask the user before any push or deploy.

**M2 done 2026-11-06 (local `46c3b78`, not pushed).** Hub code is in `admin/server/src/hub/`:
`routes.js` (`createHubRouter(db, opts)`, not mounted yet), `url-signing.js` (was signing.js), `admin-auth.js`,
`bunny.js`, `deliverables.js`, `cors.js`, `tokens.js` (was crypto.js). Hub tables are migration v21; billing now
copies an existing db to `backups/premigrate-*.db` before any migration. Settings are `config.hub`; hub env names
that clash gained `HUB_` (rename table under Live Settings in TASKS.md). `nas/client-hub-api` is gone from this
branch; `main` keeps it for any hub hotfix before M6. 901/901 pass, three runs from a local-disk copy.
- Behaviour changes, both invisible today: missing Bunny keys answer 503 on publishing instead of stopping the
  server; `/hub/publish` writes its two rows in one transaction.
- A full run can stall on this Mac: a leftover Chrome crash reporter holds a PDF-rendering test's pipe (not Google Drive, as first thought). See WORKING_NOTES.

## (M2 notes)

**M1 done 2026-11-05 (local, not pushed).** Billing is at `admin/` with its 308 commits, rewritten only
so paths start `admin/`. 878 of 878 tests pass from a clean clone; allow-list site unchanged.
- Live billing still deploys from `LSCCreative/lsc-billing-app` until M6. Anything fixed there comes across
  too. Billing's own `main` still has the failing send-routes test; the fix is here only.
- Run tests: `cd admin/server && npm test`. Hub has no test suite yet; M2 adds hub tests.
- Timing check "a wrong, short or malformed link" failed once on a shifted-clock run, then passed 3 of 3
  alone: it's a timing assert, so suspect machine load before the code if it recurs.
- `.design/quote-format/` stays untracked in billing's folder and did not come across.

## PLANNING notes (design-flow)

User ran `/design-flow` to put deliverables behind payment; it grew into merging
the Billing App here. Full decisions: `.design/merged-admin/DESIGN_BRIEF.md`.
Design Tokens was skipped at the start, but the rebrand now needs a token mapping;
raise it at Phase 4. Agreed order: **merge → Bunny → payment**. `feature-spec.md` /
`buildplan.md` still describe Bunny only and are untouched. Next: user confirms the
Defaults are confirmed (2026-11-04). Work `.design/merged-admin/TASKS.md` top to bottom.
P3's live settings are in `TASKS.md`. `ssh lsc-nas` currently fails because the NAS's local address
moved; see `TASKS.md`.

The allow-list Pages deploy is live on `main` (`f177537`), merged into `merged-admin`, so
docs and `nas/` no longer reach the website. They are still public on GitHub.

Found in Phase 2 (code reading, not run live): on live projects client notes and
approvals never reach the server (`persistViewProject` no-ops, no route), the record
has no signed state, and `POST /hub/agreement` has no login check. User says no live
clients today, so this is built in the merge with no stopgap.

- **Names:** Billing App → "Scope & Sales", adopts the hub's UI/brand. Client Hub
  → "Client Portal". Full merge: one repo, one API container, one database.
- **Admin tabs:** Scope & Sales (Dashboard, pipeline before acceptance, Finance &
  Price) and Clients. Each client: Projects (active / complete, archive from
  complete, archived sub-tab), Client details, Invoice index. Settings → account menu.
- **Project page:** Production (shoot days, call sheets, trip planner),
  Deliverables, Payments. One server-side project under the billing UPID; hub
  projects leave `localStorage` via a one-time import.
- **Superseded detail below:** the brief is the source of truth. Overlap audit
  (2026-11-03) removed the hub's Final Sign-Off, added revision rounds (2 per Final,
  drafts free, Submit uses one), a quote-based checklist, contract rewording, and "show
  only the invoice actually sent" (no billing PDF or bank details beside Hnry's).
- **Lifecycle:** accepted quote opens the client project. Portal invite goes on
  first draft published (manual send also available). Complete is automatic:
  checklist approved or not needed + all invoices paid.
- **Assets:** stage replaces the `gated` checkbox. Draft Cut: notes or approve,
  never downloadable or payable. Final: approve → pay → download, same asset,
  comment history kept.
- **Payment:** final invoice via Hnry, order approve → pay. Downloads and
  the Drive link lock; review stays open. Per-project "Payment required" toggle
  (on for new, off for existing live projects).
- **Unlock:** Mark paid in billing, plus a hub admin override. Hnry via Zapier has
  no paid trigger or pay link, and Hnry sends no payment email. To test: does Find
  Invoice report PAID on a real paid invoice? If yes, add a ~15 min check.
  Client "I've paid" button alerts the admin and never unlocks by itself.
- **Review copy:** NAS review URLs are the permanent public master, so payment
  projects review over Bunny HLS only. The gate isn't real without Bunny publishing
  + signed URLs (Slice 9).
- **Login/hosting:** billing account is the one admin login (replaces hub PIN).
  app.lsccreative.studio is served from the merged NAS container; main site and
  portal stay on Pages.

Merge facts: no table-name collisions; both on `media_net`; both Express 5 +
better-sqlite3 12. Billing is CommonJS (server ~20k lines, web JS ~38k, CSS ~16k,
875 tests), hub is ESM (755 lines). Billing has `trip-should-fix` and `ui-clarity`
worktrees and uncommitted `.design/quote-format/` to settle first.

## ACTIVE FEATURE: Bunny delivery layer (planned 2026-10-20) — PAUSED until the merge lands

Decision 2026-11-03: Bunny continues AFTER the merge (order merge → Bunny → payment). Next agent:
the "first unchecked task" rule is suspended for `buildplan.md` until then. Work the merge first
(next: user confirms the brief's 7 defaults, then Phase 3 IA). Slice 2 code stays uncommitted on
branch `bunny-delivery-layer`; commit or stash it before merge work so it isn't lost. Slice 3's
"Next" line below is the resume point.

The user asked for something specific: Bunny for **client-facing media delivery
only**. The NAS stays master and backend, and records/auth/DB don't move (the
2026-10-17 "migrate DB to Bunny" slice stays dropped). Spec in
`feature-spec.md`, 13 slices (0-12) in `buildplan.md`. No code written yet.

- Top constraint (the user's words): the player is huge to maintain. Keep
  our own `<video id="asset-video">` and attach HLS to it, no Bunny iframe.
  Every [WEB] slice re-runs the 6-point player contract in the spec.
- The widget and editor link through the NAS relative path (admin projects
  live in browser localStorage, so the NAS can't write into an asset).
- Bunny Stream fetch-from-URL pulls from the existing `/hub/files/<token>`
  URL. Confirm its params against the OpenAPI before Slice 2.

### Slice 0 progress (2026-10-20, done in the browser pane) — PARTIAL
Done:
- Reused existing Stream library "Client Deliverables", ID `683470`, CDN host
  `vz-0c8c724c-a53.b-cdn.net`. Webhook set to
  `https://hub-api.lsccreative.studio/hub/bunny-webhook`. Its CDN token auth +
  block-direct-URL were ON; both turned OFF (re-enable in Slice 9). Direct
  play ON. Existing 2 videos are therefore unsigned until Slice 9.
- New Edge Storage zone `lsc-client-media` (ID 2003290, main region Sydney, no
  replicas, S3 off) + pull zone `lscclientmedia` (ID 6833812), CDN host
  `lscclientmedia.b-cdn.net`.
- Test HLS (200 OK):
  `https://vz-0c8c724c-a53.b-cdn.net/a3fdcf0a-f70d-4aa9-bb48-e04968478b30/playlist.m3u8`
Skipped on purpose: Optimizer + Dynamic Image API ($9.50/mo, user declined).
Slice 7 (resized photos) needs it later.
Secrets: all 8 BUNNY_* vars now in 1Password Environment "LSC Client Hub Bunny" (names verified).
Leftover: NAS `.env` via create_local_env_file at deploy (Slice 2/5); scrub gitignored
`client-hub-docs/Bunny.Net Storage zone & Pull Zone Details.rtf` (7 key/password lines) + rotate what it held.

### Slice 1 (2026-10-21) — CODE DONE, awaiting real Safari + iPhone check
`client-hub-app/index.html` only:
- hls.js **1.7.3 light build** (released 2026-09-11) from jsdelivr, pinned + SRI
  (`HLS_JS` const). Light = no subtitles/alt-audio/DRM, which Bunny review
  streams don't need. **Lazy-loaded** by `loadHlsJs()` only when a non-Apple
  browser opens an HLS asset (no `<script>` in `<head>`). A failed load
  resolves anyway → plain `src` fallback, and resets so the next attach retries.
- `#asset-video` renders `data-src` (no `src`). An asset with an EMPTY review
  link skips the player and renders the Drive fallback card directly
  (`renderVideoCanvas`), since the old `src=""` error path no longer exists.
- `attachReviewSource` OWNS `video.onerror` (onFail for native/plain, recovery
  routing for hls.js). `bindClientAsset` sets only onplay/onpause, then attaches.
  Re-attaching to the SAME element only swaps the hls instance (keeps the pill
  handlers), which Slice 9's 403 re-attach relies on.
- hls.js buffers one segment (`maxBufferLength` AND `maxMaxBufferLength` = 2)
  until the first `play`, then restores `Hls.DefaultConfig`. Note:
  `maxBufferLength` alone is only a floor. hls.js otherwise grows to
  `maxMaxBufferLength` (600s), and paused it pulled the whole 41s test video.
- Landing-card thumbnail skips the `<video>` for `.m3u8` links (`isHlsUrl`
  helper) → icon until Slice 4's `posterLink`.
- `attachReviewSource` branch rule: not `.m3u8` → plain `src` (NAS links
  unchanged); `.m3u8` on Apple WebKit (`navigator.vendor === 'Apple Computer, Inc.'`
  = Safari + every iOS browser) → native `src`; `.m3u8` elsewhere → hls.js;
  no MSE → native `src`. Note: Chrome 152 also says `canPlayType(mpegurl)='maybe'`,
  which is why the rule keys on vendor, not canPlayType alone.
- Module-level `reviewHls` / `reviewVideo`. `render()` calls `detachReviewSource()`
  first, which nulls the old element's onerror/onplay/onpause (stops a stale
  error flipping `videoFailed` on the next asset) and destroys hls.
- Fatal errors: before MANIFEST_PARSED → fail straight to `videoFailed` (a bad
  link used to hang forever because `startLoad()` can't re-fetch a manifest that
  never loaded — caught in testing). After it: one recovery (`recoverMediaError`
  / `startLoad`), then fail. In hls mode `video.onerror` is routed through the
  same single recovery (hls.js doesn't watch the element's own error event).
- onplay/onpause/setPausePill/refreshAssetInteraction untouched.

Verified in the browser pane (Chromium 152), Bunny test stream:
- hls.js branch: contract 1-4 pass; seek while panel open re-stamps (00:17);
  3 notes at 5.2/23.8/36.1s → same `<video>`, same Hls instance, playhead held,
  panel open, box empty+focused, logged 00:05/00:23/00:36. Timeline starts at
  0 (first frag 0.005s, buffered 0.08s).
- Native branch (vendor spoofed to Apple in Chromium, so the exact Safari code
  path ran): contract 1-4 pass, 3 notes 00:08/00:20/00:33, same element.
- Item 5: 404 HLS link → Drive card in ~0.6s (both branches). Forced fatal
  MEDIA_ERROR mid-playback → recovered, same element, playhead 12.30s kept;
  second fatal → Drive card, hls null.
- Plain webm (NAS-style link) → no hls instance, plays, pill/approve-hide work.
- Leaving the asset screen → `reviewHls` and `reviewVideo` both null.
- 375px: hls.js plays, contract holds, no horizontal overflow.
- After the /code-review fixes (all re-run, both branches): contract 1-6 pass
  again. Paused buffer = 0.1-4.0s only, a paused seek to 30s loads 28-32s only,
  and play restores defaults. Empty link → Drive card, no `<video>`. hls.js not
  loaded at boot or on landing. CDN 404 → native `src` fallback, loader resets,
  next attach loads 1.7.3 with SRI OK.
Test project `hls-test` removed from localStorage afterwards.

2026-10-28 — real desktop Safari 27.0.1 via a throwaway harness (session scratchpad,
not in repo: same-origin iframe drives the real app, POSTs results to a localhost-only
server that serves only client-hub-app/ + fonts). Chromium run of the same harness: 80/80.
**DESKTOP SAFARI: 81/81 PASS** (run `safari4`, 1280px + 375px). Native branch, hls.js
never loaded, no Hls instance, timeline from 0 (41.16s). Contract 1-6 all pass: no pill
on a plain pause; COMMENT REVISIONS stamps 00:03; play clears it; seek to 17.4 with panel
open + pause → 00:17; 3 notes at 5.2/23.8/36.1 → 00:05/00:23/00:36 saved, same <video>,
playhead unchanged, panel open, box empty + focused, approve absent; 404 HLS → Drive card
in ~0.6s; leaving the screen releases the player; no overflow at 375. Plain mp4
(NAS-style) stamps + submits the same way.
Gotcha for future harness runs: Safari rejects script `play()` (NotAllowedError) even
muted and even on screen without a user gesture, so the harness shows a CLICK TO PLAY
button once per <video>. Real clients always press play themselves, so not an app issue.

2026-11-03 — iOS Simulator (Xcode 27.2, iPhone 17, Mobile Safari iOS 27.2).
**iPHONE SIMULATOR: 44/44 PASS** (run `iphone2`, device width): native branch, contract
1-6, 3 notes, 404 → Drive card, no overflow. An earlier run went 40/41: its one failure
was the harness's in-browser MediaRecorder blob clip, which iOS wouldn't load. A real
mp4 over HTTP with Range support (what the NAS `/hub/files/` route sends) passes.
Also did the real client flow with real taps, no harness, top-level page, Bunny stream:
play → pause in fullscreen → ✕ → frame held, no pill → COMMENT REVISIONS → pill 00:38,
approve gone → typed note, SUBMIT → logged 00:38, box empty + focused, keyboard up, panel
open, video still 00:38 with pill intact. Pill + note + Submit all fit above the keyboard.
CONFIRMED (not changed): `#asset-video` has no `playsinline`, so on iPhone every play
opens native fullscreen and the client must pause, then ✕, to reach COMMENT REVISIONS.
Works, but it's extra steps. Pre-existing (NAS links same). Ask the user before changing.
Oddity: iOS fullscreen showed 0:39 where the inline player + pill show 00:38. Likely
rounding vs floor, not measured.
NOT verified: a physical iPhone (Simulator decodes on the Mac's hardware). User OK'd
ticking Slice 1 on the Simulator pass (2026-11-03); the physical check is in Slice 5.
Slice 1 code in client-hub-app/index.html is still UNCOMMITTED, so it isn't live yet.
Harness recipe for later [WEB] slices (the scratchpad copy gets wiped): same-origin iframe
of the real app, seed `lsc_hub_projects_v1` in localStorage, `?project=hls-test`, read
state via `iframe.contentWindow.eval`, first play in a real click, server allowlisted to
client-hub-app/ + fonts, localhost only. Simulator reaches localhost directly.
Disk: `xcodebuild -downloadPlatform iOS` installed TWO runtimes. Deleted the unused iPhone
Duo one (24B91016s) with the user's OK; 13 GB free. Kept iOS 27.2 24B8117 (7.7 GB) +
iPhone 17 for the [WEB] slices' contract re-runs.

### Slice 2 (2026-11-03) — CODE DONE, uncommitted, not deployed, no real Bunny call yet
New `src/bunny.js`, `bunny_assets` + `bunny_collections` (schema 6), `POST /hub/publish-asset`,
`GET /hub/publish-status`, `.env` names in the compose comment.
- **Fetch returns no video id** (OpenAPI 1.6.18: `{success,message,statusCode}` only). So the
  title carries a tag, `<file> [lsc-<16 hex>]`, and the id comes from `GET /videos?search=tag`.
  3 tries after fetch; if still unlisted the row stays `processing` with a NULL id and
  `/hub/publish-status` keeps looking. Unlisted after 30 min → `failed`.
- First-publish tag = hash of the path, so a crash after fetch adopts the video instead of a
  second pull. Repeat publishes get a time-salted tag so they can't find the old video.
- Calls I made beyond the plan: failed rows retry without `force`; a failed `force` keeps the
  working video (502, row untouched); `force` leaves the old video on Bunny, since a client
  record may still use it (only Slice 11's collection delete removes it); root-level files →
  422 (no project folder); only .mp4/.mov/.webm/.m4v; response adds `sourceChanged` for a NAS
  file replaced since publishing (Slice 4 should show this, or the client reviews the old cut).
- Boot requires 8 BUNNY_ vars, not `BUNNY_CDN_TOKEN_KEY` (Slice 9).
Verified: 57/57 in a throwaway harness (real API process, temp DB + tree, fake Bunny built from
the OpenAPI shapes, real network blocked). Covers guards, idempotency, 3 simultaneous publishes,
force, failures, late listing, adoption, timeout, restart, no key in logs.
NOT verified: real Bunny. Open assumption: a fetched video is listed and searchable by title
soon after the call. Also unproven: Bunny pulling a large master through the Cloudflare Tunnel.
**DEPLOY TRAP:** add the BUNNY_ vars to the NAS `.env` BEFORE rebuilding. Missing vars stop boot,
and `restart: always` makes that a crash loop that takes the live API down. Whether the NAS has
them is unchecked (my SSH read was blocked by the permission classifier; the user can check).
For Slice 3: Bunny's REST status enum differs from the webhook's. REST (OpenAPI) 3 = transcoding,
4 = finished, 5 = error, 6 = upload failed; the plan's webhook mapping has 3 = finished. Use
`statusFromVideo` for the 30-min fallback, NOT the webhook map. A webhook can also arrive before
the row has its id, so "unknown id → ignore" needs the 30-min fallback or a lookup behind it.

**Live Bunny test (2026-11-03, real library 683470):** called the real `bunny.js` (keys via a
1Password-mounted env file in the session scratchpad, never printed) with a public 5s sample mp4.
`findOrCreateCollection` ok; `fetchVideo` accepted; `findVideoByTag` found the video on the 3rd
poll ~12.6s after fetch (status 3 → 4 "ready" in ~15s more); `hlsUrl` returned 200. So the title-tag
lookup works. BUT the inline lookup in `publishVideo` only waits 3×1s, so on a real publish the row
will usually be saved `processing` with a NULL id and rely on `/hub/publish-status` to adopt it — that
path is the design, but is only unit-tested against the fake. NOT live-tested: the NAS `/hub/files/<token>`
source URL through the Tunnel, the full route/DB, webhook. Test collection and video were deleted from Bunny afterwards. Slice 2 left unticked until a real NAS publish.

Next: Slice 3 [API] | Model: Sonnet 5.5 | Effort: Medium (once Slice 2 is ticked)

## Previous feature notes (Client Review-Flow Fixes — complete, in git)

## Current Focus

All 9 slices done and verified locally. Feature is code-complete; the ONE
outstanding thing is a live end-to-end run of the photo-folder path against
the real NAS (see "Needs the live NAS" below) — that needs a container
deploy the sandbox can't do.

## What changed

**Part A — revision panel (`client-hub-app/index.html`, client-facing):**
- New `renderAssetInteraction(a)` / `refreshAssetInteraction()` /
  `bindAssetInteraction(a, p)`. The gateway buttons, revision form and
  activity log now live in `<div id="asset-interaction">`; revision clicks
  repaint only that container. **The `<video>` and `#pause-pill` sit outside
  it on purpose** — that's the whole fix for the restart-from-zero bug. Do
  not move them inside, and do not "simplify" these handlers back to
  `setState()`; `render()` rebuilds `root.innerHTML` and destroys the player.
- `submit-revision` keeps `revisionOpen` true, clears the draft, refocuses
  the textarea.
- `#approve-asset` is omitted from the markup entirely while
  `state.revisionOpen` (not disabled — absent).
- New `fmtVideoTime()` + `setPausePill()`. `video.onpause` returns early
  unless `state.revisionOpen`; opening the panel stamps the live playhead
  only when the video is actually paused past 0; closing/cancelling clears.

**Part B — photo libraries:**
- `nas/client-hub-api/src/deliverables.js`: new
  `listDeliverableFolderImages()` (directory sibling of
  `resolveDeliverablePath`, same traversal guards, `isDirectory()`),
  `PHOTO_EXTENSIONS` (.jpg/.jpeg/.png/.webp), `MAX_PHOTOS_PER_FOLDER = 200`.
  Non-recursive, natural-sorted.
- `nas/client-hub-api/src/hubRoutes.js`: new
  `POST /hub/deliverable-folder` (admin) → `{ photos:[{name, reviewUrl,
  downloadUrl}] }`. Mints the usual two tokens per image through the
  existing `insertDeliverableToken` (`ON CONFLICT DO NOTHING`, so
  re-registering a folder is idempotent). **No DB schema change.**
- `client-hub-app/index.html`: `hubApi.deliverableFolder()`;
  `asset.photos[]` on `newAsset`, in `loadProjects`'s normaliser, and in
  `buildPublishedRecord` (that map whitelists fields — omitting `photos`
  there silently ships an empty gallery to the client); editor labels the
  field "NAS SERVER PHOTO FOLDER" for photo assets with a linked-count line;
  `[data-gen-link]` branches on `asset.type`; `renderPhotoCanvas` renders
  real `<img>` thumbnails (2-col mobile / 4-col desktop) with an explicit
  empty state; comments now carry `photoName`; `renderClientFinal` lists a
  download per photo; SOP modal covers the folder case.
- **Regression caught and fixed during verification:** `smartBadges` keyed
  "Ready to Review" off `isValidUrl(a.reviewLink)`, which photo assets now
  deliberately leave empty — a photo-only project would never have shown the
  badge. It now checks `photos[]` for photo assets.

## Verified locally (browser, `?admin=1`, seeded state)

Part A, against a real canvas-recorded webm in the player:
- Paused at 2.5s with the panel closed → no pill, `state.pausedAt === null`.
- Clicking revisions → pill `00:02`, approve button absent from the DOM,
  same `<video>` node, playhead still 2.5s.
- Submit → same node, playhead held, panel open, textarea cleared+focused,
  comment logged with `00:02`.
- Seek to 4.2s → stamp `00:04`, submit, playhead still 4.2s. Three comments
  with correct distinct timestamps.
- Cancel on a comment-free asset → approve button back, pill cleared,
  playhead intact. Cancel refused once comments exist.
- Approve → modal → `agreement` screen (no regression). 375px clean.

Part B, with canvas-generated images + realistic `https://.../hub/files/<t>`
links: 5 real thumbnails load (`naturalWidth > 0`), filenames in the
dropdown, selection highlights, revision records `photoName:"DSC_0010.jpg"`
and the log shows the filename; unlinked library shows the empty state (0
frames); final screen lists one download per photo with correct hrefs while
the video row keeps `DOWNLOAD CONTENT`; `buildPublishedRecord` round-trips
photos; editor shows "NAS SERVER PHOTO FOLDER" + "✓ 4 photos linked";
"READY TO REVIEW" badge now appears for a photo-only project; SOP modal and
2-col grid clean at 375px with no overflow.

Backend guards unit-tested directly (`DELIVERABLES_DIR` pointed at a temp
tree): correct filter + natural sort, subdirectories excluded, and `null`
for missing folder / a file / absolute path / `..` traversal / null byte /
empty string.

## NAS deploy — DONE (2026-09-27)

Deployed over SSH, not the UGREEN GUI. **`ssh lsc-nas` works with a key and
the user is in the `docker` group, so no sudo is needed** — that's the fast
path for any future backend change; don't reach for the GUI.

Deploy is NOT a container restart. The NAS runs from its own copy at
`/volume4/client-hub-api/app`, so it is: copy changed files over, then
`docker compose up -d --build` in that directory. `--build` recompiles
better-sqlite3 (~20s) and briefly recreates the container.

UGOS blocks scp/sftp — transfers go `ssh lsc-nas "cat > '<dest>'" < <file>`
with `COPYFILE_DISABLE=1` (stops Google Drive xattrs littering `._*` files).

What was done:
- Checksummed all 8 NAS src files against `42fc0b2` first — all matched, so
  no divergent edits were clobbered. Worth repeating before any future push.
- Backup kept at `/volume4/client-hub-api/app/src.bak.20260927-113903`.
  Rollback = `cp -a src.bak.20260927-113903/. src/` then rebuild.
- Copied `deliverables.js` + `hubRoutes.js`, verified md5 match both ends.
- Rebuilt. Container `Up (healthy)`, `listening on 8097`.

Verified live:
- `/health` → `{"ok":true,"schemaVersion":"5","deliverables":{"ok":true,
  "projects":2}}` — schema unchanged (no migration), records intact.
- `POST /hub/deliverable-folder` → **401** (was 404). Route exists and is
  admin-gated. `/hub/deliverable-url` still 401 — no regression.
- Ran the deployed `listDeliverableFolderImages` inside the container against
  the real mount: `Test Media/Online Video` → 12 images, natural-sorted; a
  .mp4 path → null; empty folder → `[]` (route turns this into a 422);
  missing / absolute / `..` → null.

Still needs the user (browser + admin PIN, which the agent doesn't have):
paste a folder path in the editor → NAS LINK → publish → open the client link
and confirm thumbnails load and downloads save with the right filenames.

**NAS content note:** `Test Media/Online Photo Library` is EMPTY, so it will
fail with "no images in folder" — that's correct behaviour, not a bug. The
folder that actually holds images is `Test Media/Online Video` (12 JPGs,
despite the name). Either drop photos into the Photo Library folder or test
against `Test Media/Online Video`.

## Part E — per-photo lightbox (current work, NOT pushed)

- **Photo libraries no longer have an asset-level revision panel.** All photo
  feedback happens per photo inside `renderPhotoLightbox`. `renderRevisionForm`
  is video-only now — don't reintroduce the `state.selectedPhotoIdx` guard.
- **The isolation rule:** notes are filtered with `commentsForPhoto(a,i)` on
  `c.photoIdx`, and drafts live in `state.photoDrafts` keyed by
  `photoDraftKey()` = `assetId::filename`. The old single `state.revisionDraft`
  is still used by the VIDEO form only. If a future change reintroduces one
  shared draft for photos, half-typed notes will bleed between images — that
  was the specific bug this was built to prevent.
- `refreshLightbox()` repaints only `#lightbox-host`; `closeLightbox()` also
  repaints `#photo-canvas` so the thumbnail comment-count badges update.
  Same partial-repaint discipline as `#asset-interaction` — don't call
  `render()` from these paths.
- Review actions are now `COMMENT REVISIONS` (12px) / `APPROVE CONTENT`
  (16px) / `Download` (10px, muted, underneath).
- Added a `@media (max-width:767px){ .field{font-size:16px} }` override at the
  END of the style block — it must stay last, since `.field`'s base `.9rem`
  has equal specificity and would otherwise win on source order.

## Deliverable gating (Slice 17)

- `asset.gated` defaults **true** everywhere — `newAsset()`, `loadProjects()`
  (`a.gated !== false`) and `buildPublishedRecord`. The `!== false` form is
  deliberate: projects stored before the field existed have `undefined`, which
  must read as GATED, not open.
- `downloadUnlocked(p, a)` is the only place the rule lives. Ungated → always
  available. Gated → only once `p.agreement.accepted`. Use it for any new
  download surface rather than re-deriving the condition.
- A gated asset shows "Download · unlocks after sign-off" on the review screen
  and "Unlocks after sign-off" in the lightbox rail, both with a lock icon.
- Photo libraries have no single download, so their per-photo link lives in the
  lightbox rail; the review screen just says "Open a photo to download it".
- The final-delivery screen needs no gate check — it already sits behind the
  signed agreement, so gated assets unlock there naturally.

## Open questions for the user

1. `MAX_PHOTOS_PER_FOLDER` is set to **200** — assumption, not confirmed.
   Raise it if real libraries run bigger.
2. Photo libraries deliver as per-photo links; a single zip download is
   currently out of scope. Say if that's wanted.

## Next

Nothing unchecked in `buildplan.md`. Everything is committed and pushed to
`main` → live on GitHub Pages.

Parts A-D are live (GitHub Pages + NAS API deployed). **Part E is committed
locally but deliberately NOT pushed** — the user asked to review it before it
goes live. Next action is theirs: look it over, then say push.

Note the download link now on the REVIEW screen is a policy change worth
confirming — see Open questions.

## FAQ page (separate from the client-hub work above) — NOT committed

- New: `faq.html`, `css/faq.css`, `js/faq.js`. Only edit to existing files: one
  `<a href="faq.html">FAQs</a>` in `index.html`'s `.footer-right`. Main nav
  untouched on purpose (user: footer link only).
- `faq.html` was generated from the FAQ text so the visible copy and the
  FAQPage JSON-LD match; if copy changes, edit both (or regenerate).
- Source copy: `LSC Billing App [V8]/LSC Creative FAQs.txt`. Q9 still says
  "this production business" verbatim — user may want "LSC Creative".
- Verified in browser at 1024 and 375px: no horizontal overflow, 44px targets,
  deep links (`faq.html#q-revision-rounds`) open + scroll to the answer.

## Grid unification (2026-10-02) — NOT committed

User wanted ONE background grid site-wide: the hairline + plus-marker grid from
`assets/LSC-White-Background-Grid.png`.
- New tiles: `assets/lsc-grid-light.svg` / `assets/lsc-grid-dark.svg`
  (240×180 cell, lines + plus at intersection, non-scaling 1px stroke).
- Tokens in `css/main.css` `:root`: `--lsc-grid-light`, `--lsc-grid-dark`,
  `--lsc-grid-size` (240×180), `--lsc-grid-offset`. ≤768px block at the
  bottom shrinks to 160×120, forces scroll attachment, and gives the
  (dark-on-phone) Process section the dark tint.
- Replaced: Services (PNG cover), Process (PNG 480×360 + dark 56px base),
  Works `::before` (480×360 lines), works glass panel (80px crosses), Contact
  (56px), About modal overlay (60px), FAQ body (56px, `css/faq.css`).
- Removed the Services open-state overlays (72px line grid + orange cross mask):
  `.svc-grid-overlay` / `.svc-grid-cross` markup + CSS, and the now-unused
  `svc-any-open` toggle in `js/main.js`.
- Left alone on purpose: `.lsc-pre__grid` (preloader matrix — aligned to the
  L/S/C morph cells, part of the logo animation, not a section background).
- `LSC-White-Background-Grid.png` is no longer referenced; kept in assets.
- Verified at 1024px and 375px: all sections share the grid, no overflow.
