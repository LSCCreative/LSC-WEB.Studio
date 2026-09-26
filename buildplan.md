# Build Plan

## Feature: NAS Deliverable Link — Merge Boxes + Paste-and-Convert

All slices in `client-hub-app/index.html` (**[WEB]**) unless noted. Work
strictly top-to-bottom; don't skip ahead. Full context: `feature-spec.md`.

## Task Slices

- [x] Slice 1: Merge the editor's per-asset Review/Download link inputs into
      one field + one `NAS LINK` button labeled "NAS Server Video Link"
      (`renderEditor`, currently ~L825-834). Add `asset.deliverablePath`
      (new field, `newAsset()`/project migration in `loadProjects()`) to
      hold the last-converted relative path, so a re-opened editor shows
      what's linked instead of a blank box. Keep the *existing* prompt()
      flow underneath for now (this slice is the box merge only — one
      click still fires two `hubApi.deliverableUrl()` calls,
      `downloadable:false` → `reviewLink` and `downloadable:true` →
      `downloadLink`, from the one path). Don't touch client-facing
      screens — `renderVideoCanvas`/`renderClientFinal` keep reading
      `reviewLink`/`downloadLink` exactly as today. | Model: Claude Code |
      Effort: Medium

- [x] Slice 2: Replace the `prompt()` with paste-in-field-then-convert.
      `NAS LINK` reads the field's current typed value directly (no popup),
      strips the hardcoded absolute prefix `/volume4/LSC
      Creative_Media/Client Deliverables_Media` if present (pass through
      unchanged if the text doesn't have that prefix — could already be a
      bare relative path), then runs the same two `deliverableUrl()` calls
      from Slice 1. A path that starts with `/` but doesn't match the known
      prefix is a hard, visible error (wrong volume/share/app — don't
      silently register the wrong file). On success, the field shows the
      derived relative path (`asset.deliverablePath`) so the admin can see
      what's linked; editing the field afterward must re-arm the button
      (typed text no longer matches what's linked until `NAS LINK` runs
      again). | Model: Claude Code | Effort: Medium

- [x] Slice 3: Update the "?" SOP modal (`renderNasLinkHelpModal`, added
      last feature) to describe the new one-box flow: paste the absolute
      NAS path copied from the UGREEN app directly into the field, click
      `NAS LINK` beside it, done — no more "two boxes" or "relative path"
      instructions. | Model: Claude Code | Effort: Low

- [x] Slice 4: Verify — in the browser, confirm: one box+button per asset;
      pasting a real absolute NAS-style path and converting populates both
      the review canvas (video plays) and the final-delivery download
      button correctly; an unresolvable path fails visibly; a prefix
      mismatch is a clear error, not a silent bad link; editing after
      conversion re-arms the button; updated SOP modal reads correctly at
      mobile width. | Model: Claude Code | Effort: Low
