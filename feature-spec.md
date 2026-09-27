# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

Client review-flow fixes — make the revision panel behave like a workspace
instead of a one-shot form, and give photo libraries real thumbnails instead
of blank placeholder frames.

Four reported defects, all client-facing (`client-hub-app/index.html` for
1–3; 4 also needs a new NAS backend route).

---

## Defect 1 — Timestamp captures before the client asks for revisions

**Current behavior (read from the code, not assumed):** `bindClientAsset`
attaches `video.onpause` unconditionally (`client-hub-app/index.html`
~L1622-1638). Any pause — including an incidental one while just watching —
writes `state.pausedAt` and reveals `#pause-pill`. The client sees a
timestamp badge appear even though they never said they wanted a revision.

**Wanted:** the timestamp only exists once the client has clicked
`I WANT REVISIONS FOR THIS`. Before that, pausing is just pausing.

**Decision:** gate the `onpause` capture on `state.revisionOpen`, AND capture
`video.currentTime` at the moment the revision panel opens — otherwise the
natural flow (watch → pause on the problem → *then* click revisions) would
lose the timestamp the client actually cares about. Closing/cancelling the
panel clears `state.pausedAt` and hides the pill.

---

## Defect 2 — Submitting a revision closes the panel and restarts the video

**Current behavior:** `#submit-revision`'s handler ends with
`setState({ revisionDraft:'', revisionOpen:false })` (~L1672). Two
consequences, both reported:

1. `revisionOpen:false` collapses the panel, so a client with a second note
   has to click `I WANT REVISIONS FOR THIS` again.
2. `setState` → `render()` → `root.innerHTML = renderClientAsset()`, which
   replaces the `<video>` element wholesale. The new element starts at 0, so
   the playhead is lost. (The existing code already knows this — see the
   comment above the `video.onplay`/`onpause` handlers explaining why they
   mutate `state.pausedAt` directly instead of calling `render()`.)

**Wanted:** submitting leaves the panel open with an empty textarea and the
playhead exactly where it was, so the client can keep noting things.

**Decision — the structural fix, not a workaround:** stop re-rendering the
whole asset screen for revision interactions. Wrap the gateway buttons +
revision form + activity log in a single `<div id="asset-interaction">`,
extract its markup into `renderAssetInteraction(a)`, and add
`refreshAssetInteraction()` that rewrites only that container's `innerHTML`
and rebinds its buttons. The `<video>` element lives outside that container,
so it is never touched — no playhead save/restore hack, no reload flicker,
and it fixes every other revision interaction (open, cancel, photo select)
for free. `submit-revision`, `want-revisions` and `cancel-revision` call
`refreshAssetInteraction()` instead of `setState()`.

Rejected alternative: keep the full re-render and stash
`state.videoTime`/`state.videoPlaying` to restore afterwards. Works, but it
re-requests the video, flashes, and leaves the underlying "any state change
nukes the player" trap in place for the next feature to trip over.

---

## Defect 3 — `APPROVE CONTENT` still shown while writing a revision

**Current behavior:** `renderClientAsset`'s `gateway` renders
`#want-revisions` and `#approve-asset` side by side, then appends the
revision form below (~L1059-1066). The approve button stays visible and live
while the client is typing a revision.

**Wanted:** while the revision panel is open, `APPROVE CONTENT — I'M READY
TO RECEIVE THIS` is not on the page. A client asking for changes is not
approving.

**Decision:** `renderAssetInteraction` omits `#approve-asset` entirely (not
just disables it) when `state.revisionOpen`. `CANCEL REVISIONS` is the way
back to the approve button, and it's already blocked once comments exist —
which is correct: an asset with revisions on it shouldn't be approvable from
this screen anyway.

---

## Defect 4 — Photo libraries show blank frames on the client page

**Current behavior:** `renderPhotoCanvas` (~L1112-1125) is a hardcoded
placeholder — `Array.from({length:8})` of empty `div`s showing `#1`…`#8`.
There is no photo data anywhere in the app to render: `newAsset('photo')`
produces exactly the same shape as a video asset (`reviewLink`,
`downloadLink`, `driveLink`, `deliverablePath` — all single-file fields), and
the backend can't help either: `resolveDeliverablePath`
(`nas/client-hub-api/src/deliverables.js`) returns `null` for anything that
isn't `isFile()`, so pasting a *folder* path into the editor's NAS field and
clicking `NAS LINK` 404s. Photo libraries have never been wired to real
media — the previous feature's spec listed this as a known prototype gap.

So this is not a rendering bug with a CSS fix; it's a missing vertical
feature. Scoped deliberately below.

**Decisions:**

- **A photo library is a NAS *folder*, not a file.** The admin pastes the
  absolute folder path (same UGREEN copy/paste habit, same
  `NAS_PATH_PREFIX` stripping via the existing `toRelativeDeliverablePath`)
  and `NAS LINK` enumerates it.
- **New backend route `POST /hub/deliverable-folder`** (admin-only,
  `credentialedCors` + `requireAdmin`, mirroring `/hub/deliverable-url`):
  resolves the relative path as a *directory* under `DELIVERABLES_DIR`,
  lists image files only (by extension, from the existing `MIME_TYPES`
  image entries — `.jpg/.jpeg/.png/.webp`), sorts by filename, and mints
  the usual **two** tokens per image (`downloadable:0` inline for the
  thumbnail/lightbox, `downloadable:1` attachment for the download).
  Returns `{ photos: [{ name, reviewUrl, downloadUrl }] }`.
  - Reuses `insertDeliverableToken` / `findDeliverableTokenByPath` and the
    existing `deliverable_tokens` table unchanged — no schema migration.
    Each image is just an ordinary deliverable file; the folder is only an
    admin-side convenience for registering many of them at once.
  - Needs a new `resolveDeliverableDir()` next to `resolveDeliverablePath`
    (same traversal guards — reject leading `/`, `\0`, anything resolving
    outside the tree — but `isDirectory()` instead of `isFile()`). Not a
    relaxation of the existing guard; a sibling with identical rules.
  - Non-recursive (top level of the folder only), and capped at a sane
    number of images per folder so a mis-pasted path can't mint thousands
    of tokens in one click.
- **Client data model:** `asset.photos = [{ name, reviewLink, downloadLink }]`,
  populated by the editor, carried through `buildPublishedRecord` (currently
  drops any field it doesn't name explicitly, so this is required — without
  it the client record has no photos at all) and defaulted to `[]` in
  `loadProjects`'s normaliser for existing stored projects.
- **`renderPhotoCanvas` renders the real list** — `<img>` thumbnails from
  each `reviewLink`, click-to-select and the `#photo-select` dropdown keyed
  to the real indices with the real filenames as labels. A photo asset with
  no `photos` yet gets an explicit empty state ("no photos linked yet"), not
  eight blank squares.
- **Per-photo feedback:** comments already store `photoIdx`; also store
  `photoName` so the activity log (and the admin) can name the file instead
  of relying on an index that shifts if the folder changes.
- **Final delivery screen:** a photo library has no single `downloadLink`, so
  `renderClientFinal` lists per-photo download links for photo assets
  instead of one `DOWNLOAD CONTENT` button.
- The editor's field label and the `?` SOP modal both say "VIDEO LINK" /
  describe a file — both must read correctly for the folder case too.

---

## Acceptance Criteria

1. Pausing the review video before clicking `I WANT REVISIONS FOR THIS`
   shows no timestamp pill. After clicking it, the pill shows the playhead
   position; pausing again while the panel is open updates it; cancelling
   the panel clears it.
2. Clicking `SUBMIT REVISION` leaves the panel open with an empty textarea,
   appends the note to the activity log, and the video keeps playing/stays
   paused at the same position — it does not jump to 0.
3. While the revision panel is open, no `APPROVE CONTENT` button is present
   in the DOM.
4. A photo library asset with a linked NAS folder shows real image
   thumbnails on the client page; selecting one and submitting a revision
   records the photo's filename; the final delivery screen offers a download
   per photo. A photo asset with no folder linked shows a clear empty state.
5. Pasting a folder path that doesn't exist, contains no images, or sits
   outside `NAS_PATH_PREFIX` fails loudly (toast), consistent with the
   existing single-file behavior.
6. No regression to video assets: review playback, approve flow, agreement
   screen, and the final-screen download button all behave as before.

## Out of Scope

- Zipping a photo library into one download — per-photo links only.
- Server-side thumbnail generation / resizing. Thumbnails are the full
  images scaled by CSS (`object-fit: cover`); fine for the current library
  sizes, and a real thumbnailer is its own feature if it becomes a problem.
- A lightbox / full-size photo viewer. Grid + selection only, matching what
  the placeholder implied.
- Recursive folder walking, or non-image files in a photo folder (ignored).
- `driveLink` (Google Drive backup) — untouched.
- The `/hub/feedback` write endpoint (client revisions still don't reach the
  studio cross-device in live mode — pre-existing, logged seam in
  `persistViewProject`, unchanged by this feature).
