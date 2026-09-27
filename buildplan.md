# Build Plan

## Feature: Client Review-Flow Fixes — Revision Panel + Photo Thumbnails

Slices 1-3 and 5-8 are in `client-hub-app/index.html` (**[WEB]**). Slice 4 is
in `nas/client-hub-api/` (**[API]**) and needs a deploy to the NAS container
before Slices 5+ can be verified live. Work strictly top-to-bottom; don't skip
ahead. Full context: `feature-spec.md`.

## Task Slices

### Part A — Revision panel (defects 1-3)

- [x] Slice 1: Extract the asset screen's interaction zone so revision
      interactions stop destroying the `<video>`. In `renderClientAsset`,
      wrap `gateway` + `commentLog` in `<div id="asset-interaction">` and
      move their markup into a new `renderAssetInteraction(a)`. Add
      `refreshAssetInteraction()` which rewrites only that container's
      `innerHTML` and rebinds the buttons inside it (`want-revisions`,
      `approve-asset`, `submit-revision`, `cancel-revision`, `photo-select`,
      `[data-photo]`) — factor those bindings out of `bindClientAsset` into
      a `bindAssetInteraction()` that both callers use. Then repoint
      `want-revisions`, `submit-revision` and `cancel-revision` at
      `refreshAssetInteraction()` instead of `setState()`, and make
      `submit-revision` keep `state.revisionOpen === true` while clearing
      `state.revisionDraft` (fixes defect 2: panel stays open, playhead
      preserved, new comment appears in the log). The `<video>` and the
      `#pause-pill` must sit OUTSIDE `#asset-interaction`. `approve-asset`
      and the approve modal still go through `setState()` — they
      intentionally leave the screen. | Model: Claude Code | Effort: Medium

- [x] Slice 2: Gate the timestamp on the revision panel (defect 1). In
      `bindClientAsset`, `video.onpause` only writes `state.pausedAt` /
      reveals `#pause-pill` when `state.revisionOpen` is true. In
      `want-revisions`' handler, when opening the panel, read the live
      `video.currentTime` and set `state.pausedAt` from it (so pause-then-
      ask-for-revisions keeps the timestamp the client cares about); when
      closing/cancelling, clear `state.pausedAt` and hide the pill. Keep
      `video.onplay` clearing it as today. Video assets only — photo assets
      have no player. | Model: Claude Code | Effort: Medium

- [x] Slice 3: Hide `APPROVE CONTENT` while revising (defect 3).
      `renderAssetInteraction` omits the `#approve-asset` button from the
      markup entirely (not disabled — absent) when `state.revisionOpen`.
      Check the flex row still looks right with only `REVISION FORM OPEN` in
      it, at desktop and ≤768px. | Model: Claude Code | Effort: Low

### Part B — Photo libraries (defect 4)

- [x] Slice 4: **[API]** New `POST /hub/deliverable-folder` in
      `nas/client-hub-api/src/hubRoutes.js` (`credentialedCors` +
      `requireAdmin`, placed next to `/hub/deliverable-url`). Add
      `resolveDeliverableDir()` to `deliverables.js` — same traversal guards
      as `resolveDeliverablePath` (reject leading `/`, `\0`, anything
      resolving outside `DELIVERABLES_DIR`) but `isDirectory()`. The route
      reads the folder non-recursively, keeps only image extensions
      (`.jpg/.jpeg/.png/.webp`), sorts by filename, caps the count, and for
      each image mints both tokens via the existing
      `insertDeliverableToken`/`findDeliverableTokenByPath` (no schema
      change). Returns `{ photos:[{ name, reviewUrl, downloadUrl }] }`; 404
      for a missing/non-directory path, and a distinct error for a folder
      with no images. | Model: Claude Code | Effort: Medium

- [x] Slice 5: Editor + data model for photo folders. Add
      `hubApi.deliverableFolder(path)` (live-only, same as
      `deliverableUrl`). `newAsset('photo')` gains `photos: []`. In
      `renderEditor`, photo assets label the field "NAS SERVER PHOTO FOLDER"
      (video keeps "NAS SERVER VIDEO LINK") and show how many photos are
      currently linked. The `[data-gen-link]` handler branches on
      `asset.type`: photo → `toRelativeDeliverablePath` then
      `deliverableFolder`, writing `asset.photos` and `asset.deliverablePath`
      (leave `reviewLink`/`downloadLink` empty for photo assets); video →
      unchanged. Carry `photos` through `buildPublishedRecord` (it drops
      unnamed fields — without this the client gets nothing) and default it
      to `[]` in `loadProjects`'s asset normaliser. Errors surface via the
      existing `toast`/`reportAdminError` path. | Model: Claude Code |
      Effort: Medium

- [x] Slice 6: Real thumbnails on the client page. Rewrite
      `renderPhotoCanvas` to render `a.photos` — `<img>` per photo from
      `reviewLink` (`object-fit:cover`, `loading="lazy"`), click-to-select
      keyed to the real index, `#photo-select` options labelled with the
      real filenames, and an explicit empty state when `a.photos` is empty
      (replacing the eight hardcoded blank frames). `submit-revision` also
      stores `photoName` on the comment; the activity log shows the filename
      when present, falling back to `PHOTO #n` for older comments. Check the
      grid at ≤768px per the responsive rules in `CLAUDE.md`. | Model:
      Claude Code | Effort: Medium

- [x] Slice 7: Final delivery screen for photo libraries. In
      `renderClientFinal`, a photo asset lists a download link per photo
      (from each `downloadLink`) instead of the single `DOWNLOAD CONTENT`
      button; video assets unchanged. Handle the no-photos case without
      rendering an empty row. | Model: Claude Code | Effort: Low

- [x] Slice 8: Update the "?" SOP modal (`renderNasLinkHelpModal`) to cover
      both cases: video assets take a file path, photo libraries take a
      folder path, same copy-the-absolute-path-and-click-NAS-LINK flow.
      | Model: Claude Code | Effort: Low

### Part C — Verification

- [x] Slice 9: Full verification pass. Revision panel: no pill before
      clicking revisions; pill correct after; submit keeps the panel open,
      clears the textarea, appends to the log, and leaves the playhead
      untouched; no approve button while revising; cancel restores it and
      clears the pill. Photos: a real NAS folder yields real thumbnails,
      selection + filename-stamped revisions work, per-photo downloads work
      on the final screen, empty state shows for an unlinked photo asset,
      and bad/empty/outside-prefix folder paths toast loudly. Regression:
      video review playback, approve → agreement → final still work. Check
      desktop + 375px. Note in `scratchpad.md` anything that needs the live
      NAS (Slices 4-7 can't be fully proven in the sandbox — the folder
      endpoint is live-only, same constraint as `deliverableUrl`). | Model:
      Claude Code | Effort: Low

### Part D — Card thumbnails + icon set (added after the Part A-C review)

- [x] Slice 10: Replace the emoji glyph on each client-landing deliverable
      card with a real media preview. New `renderAssetThumb(a)` + `.asset-thumb`
      CSS (16:9, `object-fit:cover`). Video → the real file with a `#t=1`
      fragment so the browser Range-fetches just enough to paint the frame at
      1s as a still poster (`preload="metadata"`, muted, never plays). Photo →
      first three images as a filmstrip. A hairline SVG icon sits underneath as
      the fallback, so an unlinked/slow/broken thumbnail degrades to the icon
      instead of a blank box. | Model: Claude Code | Effort: Medium

- [x] Slice 11: Drop every colour emoji for a stroke-based inline SVG set
      (`ICONS` + `icon(name, size, cls)`): video, photo, doc, play, clock,
      check, download. Replaces 🎬 🖼 📄 ✅ ⏱️ across the landing cards, editor
      asset headings, invoice rows, activity-log timestamps, the pause pill,
      the approved badge, the agreement badge and the final screen. Status
      dots (🟡🟠🟢) become a `.status-dot` CSS circle that inherits each
      badge's own colour. `setPausePill` now rewrites only `#pause-pill-time`
      so the static icon survives. | Model: Claude Code | Effort: Medium

### Part E — Per-photo lightbox review + simplified review actions

- [x] Slice 12: Remove the asset-level revision feature from PHOTO libraries.
      `renderAssetInteraction` branches on `a.type`: photo assets get only
      APPROVE CONTENT + the download link, no `want-revisions` button and no
      `renderRevisionForm`. `renderRevisionForm` is now video-only (its
      photo-selection guard and the `#photo-select` dropdown are both gone).
      | Model: Claude Code | Effort: Medium

- [x] Slice 13: Photo lightbox (`renderPhotoLightbox` + `bindPhotoLightbox` +
      `refreshLightbox`). Clicking a contact-sheet frame opens a full-screen
      scrim: the photo large on the left, a notes rail on the right (stacked
      below it under 768px), hairline arrow buttons on either edge of the
      image, disabled at the ends. Escape closes; ArrowLeft/Right step
      through, but are ignored while the client is typing. Only
      `#lightbox-host` repaints on navigation, so the contact sheet and its
      thumbnails are never reloaded. | Model: Claude Code | Effort: Medium

- [x] Slice 14: Per-photo comment isolation — the correctness requirement.
      `commentsForPhoto(a,i)` filters the rail to `c.photoIdx === i`, and
      drafts live in `state.photoDrafts` keyed by `photoDraftKey()`
      (`assetId::filename`, falling back to index) instead of the single
      shared `state.revisionDraft`. Arrowing to an untouched photo therefore
      always shows an empty box and an empty note list; arrowing back
      restores that photo's own draft. Submitting clears only that photo's
      key. Commented thumbnails carry a terracotta count badge.
      | Model: Claude Code | Effort: Medium

- [x] Slice 15: Simplify the video review actions to `COMMENT REVISIONS`
      (secondary, 12px) and `APPROVE CONTENT` (primary, 16px), with a quiet
      `Download` link (10px, muted) underneath the row. Photo libraries get
      the same approve + download pair. Download renders disabled when the
      asset has no valid `downloadLink`. | Model: Claude Code | Effort: Low

- [x] Slice 16: Verify. Draft and comment isolation across photos, keyboard
      nav, approved-library lock, button hierarchy and sizes, mobile stacking
      with 44px touch targets, and no regression to the video revision flow
      (timestamp arming, playhead retention, approve hidden while revising).
      | Model: Claude Code | Effort: Low
