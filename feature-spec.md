# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

Client Hub editor — collapse the redundant Review/Download link boxes into
one NAS link field per asset, and replace the popup-prompt path entry with
a paste-then-convert-in-place flow.

### Current behavior (confirmed by reading the code, not assumed)

- `client-hub-app/index.html`'s editor renders **two** link inputs per asset
  — "Review link" (`a.reviewLink`) and "Download link" (`a.downloadLink`) —
  each with its own `NAS LINK` button (`renderEditor`, ~L825-832).
- Both buttons run the same handler (`data-gen-link` click binding,
  ~L1532-1549): it opens a JS `prompt()` asking for a path *relative to*
  `Client Deliverables_Media`, then calls `hubApi.deliverableUrl(path,
  downloadable)` — a live-only NAS API call — and drops the returned URL
  into `reviewLink` or `downloadLink` depending on which button was clicked.
- **The two fields are NOT interchangeable under the hood**, even though
  they point at the same source file: `POST /hub/deliverable-url`
  (`nas/client-hub-api/src/hubRoutes.js`) mints a **separate token** per
  `(relative_path, downloadable)` pair (see `deliverable_tokens`'s
  `UNIQUE(relative_path, downloadable)` in `db.js`), because the server
  streams the *same* file with a different `Content-Disposition` depending
  on which token is hit (`streamFile`, `deliverables.js`) — `inline` for
  review (so `<video src>` at L1096 can play/scrub it in the asset canvas)
  vs. `attachment` for download (so the client's browser saves a copy,
  `renderClientFinal` L1152). One raw source path always needs **two**
  generated URLs, one per mode.
- `resolveDeliverablePath` (`nas/client-hub-api/src/deliverables.js`)
  rejects any path starting with `/` — the backend only ever accepts a path
  *relative to* `DELIVERABLES_DIR`. On the NAS host that directory is
  `/volume4/LSC Creative_Media/Client Deliverables_Media` (see
  `docker-compose.yml`'s volume mount), read-only-mounted into the
  container at `/srv/deliverables`.
- The admin confirmed (2026-09-18) that what they actually copy out of the
  UGREEN NAS app's file manager is the **absolute NAS host path**, e.g.
  `/volume4/LSC Creative_Media/Client Deliverables_Media/Acme Co
  Promo/final-cut.mp4` — not a share URL, not an SMB path. Today's `prompt()`
  makes them retype/trim that down to the relative tail by hand
  (`Acme Co Promo/final-cut.mp4`), which is the friction being removed.

### What the admin wants instead

1. **One box per asset**, not two — "NAS Server Video Link" (or similar),
   since both existing boxes are fed from the same source file and having
   two side-by-side is redundant from the admin's point of view.
2. **Paste the raw absolute NAS path directly into that box**, then press a
   `NAS LINK` button *to the right of that same field* (no popup, no
   separate prompt) to convert it in place.
3. The site must still work exactly as before for the client-facing pages —
   the review/asset canvas still needs an inline-playable URL, the final
   delivery screen still needs a forced-download URL. This is a UI/workflow
   consolidation for the admin, **not** a change to what gets served to
   clients.

### Decisions made this planning pass

- Internal data model is unchanged: `asset.reviewLink` and
  `asset.downloadLink` keep existing separately, populated from the same
  source path by two `hubApi.deliverableUrl()` calls (`downloadable:false`
  and `downloadable:true`) fired together from one click. Nothing
  downstream (`renderVideoCanvas`, `renderClientFinal`, `smartBadges`,
  the editor's `badLink` validation) needs to change.
- The merged field's value is the **admin-facing string** (raw pasted path,
  then the derived relative path once converted) — not either generated hub
  URL, which are opaque tokens with no debugging value to look at. A new
  `asset.deliverablePath` field stores the last-converted relative path so
  the admin can see what's linked without re-pasting, and so re-opening the
  editor doesn't show a blank/confusing box for an asset that already has
  working links.
- Conversion strips a known, hardcoded absolute prefix
  (`/volume4/LSC Creative_Media/Client Deliverables_Media`, matching
  `docker-compose.yml`'s volume source exactly) from the pasted text. If the
  pasted text doesn't start with that prefix, treat it as already-relative
  and pass it through unchanged (covers copy/paste of a previously-converted
  value, or an admin who already knows the relative path) — but if it starts
  with `/` and doesn't match the known prefix, that's a real, loud error (a
  different volume/share, a typo, a path copied from the wrong app) rather
  than a silent wrong-file registration.
- Editing the field after a successful conversion re-arms it (must click
  `NAS LINK` again before the new text takes effect) — the field always
  reflects either "not yet converted for this text" or "linked as of this
  exact text", never a stale mix.
- The existing "?" SOP modal (client-hub-app/index.html, added for the
  previous feature) documents the *old* two-box/prompt flow and will be
  wrong the moment this ships — updating it is in scope as part of this
  feature, not a follow-up.

## Acceptance Criteria

- Each asset in the editor shows exactly one NAS link input + one `NAS
  LINK` button (no separate Review/Download boxes).
- Pasting an absolute NAS path and clicking `NAS LINK` populates both
  `reviewLink` and `downloadLink` correctly (verified against a real NAS
  path) with no popup/prompt involved.
- The asset review canvas (video playback) and the final delivery screen
  (forced download) both continue to work off the two internally-generated
  URLs — regression-checked, since this touches the one code path both
  screens depend on.
- Pasting a path that doesn't resolve to a real file on the NAS fails
  loudly (existing `file not found` 404 behavior, surfaced clearly in the
  UI) rather than silently linking nothing.
- The SOP help modal reflects the new one-box paste-and-convert flow.

## Out of Scope

- Any change to `driveLink` (Google Drive backup) — untouched, unrelated.
- Any change to the photo-library review canvas (`renderPhotoCanvas`) — it's
  a static placeholder gallery not wired to `reviewLink` at all; a
  pre-existing prototype gap, not something this feature touches.
- Re-architecting the backend token scheme (still two tokens per file, one
  per `downloadable` mode) — out of scope; this feature is admin-UI-only.
