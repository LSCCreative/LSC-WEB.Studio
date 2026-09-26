# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

Slices 1, 2, and 3 done. `renderNasLinkHelpModal` (`client-hub-app/index.html`,
~L901-929) now describes the one-box paste-and-convert flow: paste the full
absolute NAS path into the NAS Server Video Link field, click NAS LINK beside
it, done — old copy about "two boxes"/copying a bare relative path is gone.
Verified in browser (admin editor, `?admin=1` + `lsc_hub_auth_v1` bypass): "?"
opens the modal, new copy renders correctly at both desktop and mobile (375px)
width with no overflow, scrolls cleanly.

Slices 1 and 2 done previously. `renderEditor` (`client-hub-app/index.html`) now shows,
per asset: a bold "VIDEO ASSET #1"/"PHOTO LIBRARY #1" title, a persistent
"NAS SERVER VIDEO LINK" label + single input + `NAS LINK` button (no
placeholder text), and a persistent "GOOGLE DRIVE BACKUP LINK" label + input
below it (also no placeholder — these two label tweaks were ad-hoc polish
requests during the session, not separate buildplan slices, but they're
part of the same UI now).

`NAS LINK` no longer opens a `prompt()` — it reads `asset.deliverablePath`
(kept live by the existing generic `data-field`+`data-asset` input binding)
directly. `toRelativeDeliverablePath()` (new helper, next to `newAsset()`)
strips the hardcoded absolute prefix `NAS_PATH_PREFIX =
'/volume4/LSC Creative_Media/Client Deliverables_Media'` when present, passes
already-relative text through unchanged, and returns `null` for a
`/`-prefixed path that doesn't match — which the click handler turns into a
loud `toast()` instead of silently registering the wrong file. On success it
fires both `hubApi.deliverableUrl()` calls and overwrites
`asset.deliverablePath` with the derived relative path; on failure (or the
prefix-mismatch case) the field is left as-is so the admin can fix and retry.
Re-arming is implicit: the button always reads whatever is currently in
`asset.deliverablePath` at click time, so editing the field after a
successful conversion naturally requires clicking `NAS LINK` again — no
extra state needed.

Verified in browser via `?admin=1` + `sessionStorage.lsc_hub_auth_v1='true'`
bypass (no live NAS reachable from this sandbox):
- Merged box renders correctly, one per asset.
- A `/`-prefixed mismatched path → clear toast, field untouched.
- A well-formed absolute path → prefix stripped, real
  `POST /hub/deliverable-url` request attempted (confirmed via console/
  network — blocked only by CORS/no backend in this sandbox, which is
  expected here and not a code issue).

Not yet verified live end-to-end against a real NAS path (needs the actual
backend) — flag this for Slice 4's live verification pass.

Key facts confirmed during planning (don't re-derive — see `feature-spec.md`
for full detail):
- `reviewLink`/`downloadLink` are NOT the same URL even though they're the
  same file — the backend mints separate tokens per `(path, downloadable)`
  pair because `Content-Disposition` differs (inline vs attachment). The
  merge is UI-only; both fields must keep being populated internally.
- The admin copies an **absolute NAS host path** out of the UGREEN app,
  e.g. `/volume4/LSC Creative_Media/Client Deliverables_Media/<project>/
  <file>` — confirmed directly by the admin, not assumed.
- The backend (`resolveDeliverablePath` in `nas/client-hub-api/src/
  deliverables.js`) rejects any path starting with `/` — conversion to a
  relative path happens client-side before calling `hubApi.deliverableUrl()`.

No open questions blocking Slice 4.

## Next

**Slice 4 | Model: Claude Code | Effort: Low** — full browser verification
pass: one box+button per asset; pasting a real absolute NAS-style path and
converting populates both the review canvas (video plays) and the
final-delivery download button; an unresolvable path fails visibly; a
prefix mismatch is a clear error; editing after conversion re-arms the
button; updated SOP modal reads correctly at mobile width (already
spot-checked during Slice 3, but Slice 4 owns the full pass, including
against a real/live NAS path if reachable).

## Slice 4 result (2026-09-21)

Verified in browser: one input + one NAS LINK button per asset, old Review/Download boxes gone; prefix stripping correct; `/volume2/...` mismatch → clear toast, field untouched; unresolvable path → visible "Generate NAS link failed" toast. Re-arming is implicit (button reads the field at click time). SOP modal checked at 375px in Slice 3.
NOT verified: real end-to-end against the live NAS (video playback in review canvas, forced download on final screen) — sandbox can't reach the backend. Do this manually once on the real site.
All slices complete; feature ready to commit/merge.
