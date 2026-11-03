# Build Plan

## Feature: Bunny Delivery Layer — NAS → Bunny → Client Hub

Full context and decisions: `feature-spec.md`. Work strictly top-to-bottom.

Tags: **[USER]** = only the user can do it (dashboards, keys, NAS shell).
**[WEB]** = `client-hub-app/index.html`. **[API]** = `nas/client-hub-api/`
(needs a NAS redeploy, `docker compose up -d --build`, before anything
downstream can be checked live). **[DESKTOP]** = new `desktop-publisher/`.

**Player guardrail:** every [WEB] slice ends by re-running the 6-point
player contract in `feature-spec.md` (desktop Chrome, desktop Safari,
≤768px), and isn't done until it passes. The pause → timestamp → revision
field flow is the part the user cares most about.

The previous feature (Client Review-Flow Fixes, Slices 1-17) is complete and
in git history. Slice 18 (moving the DB to Bunny) was dropped: the NAS stays
the backend, and Bunny is for media delivery only.

## Task Slices

### Part A — Foundation

- [x] Slice 0: **[USER]** Bunny setup, with Claude guiding step by step. Create
      a Stream library (MP4 fallback not needed — masters download from
      Edge Storage, Slice 8; set the webhook URL to
      `https://hub-api.lsccreative.studio/hub/bunny-webhook`, leave token
      auth OFF for now), an Edge Storage zone, and a pull zone on it with
      Optimizer + Dynamic Image API enabled (token auth OFF for now). Add the
      `BUNNY_*` variables listed in `feature-spec.md` to a 1Password
      Environment and to the NAS `.env` (never to tracked files). Upload ONE
      test video by hand in the Stream dashboard and note its HLS
      `playlist.m3u8` URL for Slice 1. Also check
      `client-hub-docs/Bunny.Net Storage zone & Pull Zone Details.rtf`: if it
      contains keys or passwords, move them to 1Password, delete them from
      the file, and rotate them. | Model: Sonnet 5.5 | Effort: Low

- [x] Slice 1: **[WEB]** HLS in the existing review player. This is the riskiest
      slice and the user's top priority, so it comes first. Add hls.js (pinned exact
      version, CDN) and `attachReviewSource(video, url)`: native HLS on
      Safari/iOS, hls.js elsewhere, and a plain `src` for non-`.m3u8` links so
      NAS-linked projects still work. `renderVideoCanvas` renders
      `#asset-video` with the URL in `data-src`. `bindClientAsset`
      attaches it. Keep one module-level `Hls` instance, destroyed before
      re-attach and when leaving the asset screen. Map fatal hls errors
      (after one recovery attempt) to the existing `videoFailed` path. Leave
      `onplay`/`onpause`/`setPausePill`/`refreshAssetInteraction`
      untouched. Test with Slice 0's hand-uploaded video pasted into a test
      asset's review link. Run the full player contract, plus scrubbing,
      seeking while the revision panel is open, and submitting 3 notes in
      a row without the video reloading. | Model: Opus 5.5 | Effort: High
      _Status 2026-11-03: code done. Chromium verified (2026-10-21), real
      desktop Safari 27 passes the full contract 81/81 at 1280 + 375px, iPhone
      Simulator (iOS 27.2) 44/44 plus a real-tap run. Ticked on the Simulator
      pass with the user's OK; the physical iPhone check is in Slice 5 — see
      `scratchpad.md`._

### Part B — Video publishing

- [ ] Slice 2: **[API]** `src/bunny.js` (the only Bunny caller, native
      `fetch`, reads `BUNNY_*` env, fails loudly at boot if they're missing)
      + `bunny_assets` and `bunny_collections` tables in `db.js` + `POST
      /hub/publish-asset` (`credentialedCors` + `requireAdmin`) taking
      `{ path, kind:'video' }`. Steps: resolve the path with the existing
      guards → reuse/mint the `/hub/files/<token>` URL → get or create the
      Stream collection for the top-level project folder → Stream
      fetch-from-URL into it → store the row. Idempotent per path. Re-publishing
      returns the existing row, unless `force:true` is passed. Returns
      `{ status, videoId, hlsUrl, posterUrl }`. Plus `GET
      /hub/publish-status?path=` (admin). First confirm fetch's
      parameters against Bunny's OpenAPI. Never log keys.
      | Model: Opus 5.5 | Effort: High

- [ ] Slice 3: **[API]** `POST /hub/bunny-webhook`, mounted with
      `express.raw()` so the HMAC is computed over the exact bytes. Verify
      `X-BunnyStream-Signature` (HMAC-SHA256, library read-only key,
      `safeEqual`), reject anything unsigned. Then map the status onto
      `bunny_assets`: 3 → ready, 4 → playable, 5 → failed with an error,
      0-2 → processing. Unknown video ids → 200 and ignore. Add a
      `/hub/publish-status` fallback that asks Stream directly when a row
      has been "processing" for over 30 min (in case a webhook was missed).
      | Model: Sonnet 5.5 | Effort: Medium

- [ ] Slice 4: **[WEB]** Editor + data model. For video assets, add a `PUBLISH
      TO BUNNY` button next to `NAS LINK`, using the same path field and the
      same `toRelativeDeliverablePath`. It calls `/hub/publish-asset`, then
      polls `/hub/publish-status` and shows Processing / Ready / Failed
      (with the reason). On Ready it fills `reviewLink` (HLS),
      `posterLink`, `bunnyVideoId` and `publishStatus`. Carry the new fields
      through `buildPublishedRecord` and the `loadProjects` normaliser. The
      landing-card thumbnail uses `posterLink` as an `<img>` when present,
      and keeps the old `#t=1` `<video>` for NAS links. Update the `?` SOP
      modal (`renderNasLinkHelpModal`) for the new button. Player guardrail
      applies. | Model: Sonnet 5.5 | Effort: Medium

- [ ] Slice 5: Verify video end to end and deploy. Deploy the API to the
      NAS. Drop a real deliverable on the NAS → PUBLISH → Ready → publish
      the project → client logs in on another device → full player contract
      on desktop Chrome, desktop Safari and a real iPhone → approve →
      agreement → final screen. Also check that an old NAS-linked project
      still plays. Log the results in `scratchpad.md`.
      | Model: Opus 5.5 | Effort: Medium

### Part C — Photos & masters

- [ ] Slice 6: **[API]** Photo folders → Edge Storage. `POST
      /hub/publish-asset` with `kind:'photo'` reuses
      `listDeliverableFolderImages` (same cap and extensions), then streams
      each image from the read-only mount to Edge Storage with `PUT` at
      `/<project folder>/<asset folder>/<file>`, 4 at a time. It skips files
      already there at the same size, and runs as a background job, so the
      route returns at once and `/hub/publish-status` reports `n/total`. When
      done it returns `photos:[{ name, reviewLink, downloadLink }]` (CDN
      URLs, no size params). Re-running only uploads new or changed files.
      | Model: Opus 5.5 | Effort: Medium

- [ ] Slice 7: **[WEB]** Photos from Bunny. The editor's photo assets get the
      same PUBLISH button with progress (`n/total`). Add a `photoSrc(ph,
      width)` helper that appends Optimizer params only to Bunny CDN URLs.
      Grid `?width=600`, lightbox `?width=2400`, and the landing-card strip
      uses the grid size. Downloads stay the original. NAS-linked photo
      libraries render exactly as today. Check the lightbox per-photo
      comments and keyboard nav still work.
      | Model: Sonnet 5.5 | Effort: Medium

- [ ] Slice 8: **[API + WEB]** Video master downloads. Publishing a video also
      `PUT`s the untouched master to Edge Storage (`kind:'master'` row,
      same background-job pattern as Slice 6), and `downloadLink` becomes
      that CDN URL, so 4K masters download at full resolution. The final
      screen and the ungated review-screen download use it. NAS
      `downloadLink`s on old projects still work.
      | Model: Sonnet 5.5 | Effort: Medium

### Part D — Lock it down

- [ ] Slice 9: **[USER + API + WEB]** Signed, expiring media URLs. The user
      turns on token auth for the Stream pull zone and the storage pull zone,
      and adds `BUNNY_CDN_TOKEN_KEY`. `GET /hub/records/:projectId` signs every Bunny URL in
      the record on the way out (HLS uses a path token covering
      `/<videoId>/` so segments load), and **omits** `downloadLink`s of
      gated assets until the agreement is signed. Unsigned URLs stay stored
      in the DB. TTL is long enough for a review session (start at 6h). In
      the player, a 403 from hls.js re-fetches the record, re-attaches at the same
      `currentTime` and paused state, and keeps the revision draft and pill.
      Test by forcing a short TTL. The player guardrail applies.
      | Model: Opus 5.5 | Effort: High

### Part E — Desktop widget

- [ ] Slice 10: **[DESKTOP]** macOS menu-bar publisher in `desktop-publisher/`
      (SwiftUI `MenuBarExtra`, no third-party deps). Sign in with the admin
      email + PIN through `/hub/admin-auth`; the session cookie is kept by
      URLSession, the PIN is never stored, and the app sends the
      `Origin` header that `credentialedCors` expects. Drag a file or folder
      onto it. If it's already under the mounted NAS share, convert the path
      (same prefix rule as `toRelativeDeliverablePath`). If not, pick a
      project folder and copy it in first. Call `/hub/publish-asset`, show
      live progress, and copy the NAS path to the clipboard for the editor.
      It holds no Bunny key. Add a README with build/run steps.
      | Model: Opus 5.5 | Effort: High

### Part F — Cost control & close-out

- [ ] Slice 11: **[API]** Cleanup. Record `delivered_at` when a publish
      first flips `delivered` on. A daily in-process timer deletes that
      project's Stream videos, collection and Edge Storage files after
      `BUNNY_RETENTION_DAYS` (default 90), marks the rows `expired`, and
      logs what it removed. The NAS copies are never touched. Add a
      dry-run flag for the first deploy.
      | Model: Sonnet 5.5 | Effort: Medium

- [ ] Slice 12: Full verification + docs. Run every acceptance criterion in
      `feature-spec.md` live. Grep the repo, the client app and the widget
      for key-shaped strings. Update `client-hub-docs/NAS-DELIVERABLES.md`
      ("No upload path exists" no longer holds; document the publish flow,
      the tables, the webhook and the retention) and the SOP modal copy.
      | Model: Opus 5.5 | Effort: Medium
