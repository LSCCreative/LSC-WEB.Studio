# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## PLANNING (design-flow): merged admin + paid delivery — Phase 2 brief written, nothing built

User ran `/design-flow` to put deliverables behind payment; it grew into merging
the Billing App here. Full decisions: `.design/merged-admin/DESIGN_BRIEF.md`.
Design Tokens was skipped at the start, but the rebrand now needs a token mapping;
raise it at Phase 4. Agreed order: **merge → Bunny → payment**. `feature-spec.md` /
`buildplan.md` still describe Bunny only and are untouched. Next: user confirms the
brief's 7 defaults, then Phase 3 Information Architecture.

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
- **Lifecycle:** accepted quote opens the client project. Portal invite goes on
  first draft published (manual send also available). Complete is automatic:
  finals approved + signed + all invoices paid (signed alone if payment is off).
- **Assets:** stage replaces the `gated` checkbox. Draft Cut: comment or approve,
  never downloadable or payable. Final: re-approve → sign → pay → download, same
  asset, comment history kept.
- **Payment:** final invoice via Hnry, order approve → sign → pay. Downloads and
  the Drive link lock; review stays open. Per-project "Payment required" toggle
  (on for new, off for existing live projects). Billing pushes invoice number,
  amount, due date and PDF.
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
