# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

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
