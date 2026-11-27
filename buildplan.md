# Build Plan

## Feature: Bunny Delivery Layer — NAS → Bunny → Client Portal

Full context and decisions: `feature-spec.md`. Work strictly top-to-bottom.

> **Re-planned 2026-11-07 against the merged code (merge task B1).** Slices 2-12 were
> rewritten for the merged admin. The merge's task list (`.design/merged-admin/TASKS.md`,
> gitignored, in this project folder) groups them: **B2** = Slices 2-5, **B3** = 6-8,
> **B4** = 9, **B5** = 10-12. That list stays the master order.
>
> **Prerequisites.** Slice 2 can't start until merge tasks **R1** (deliverables and versions
> on the server), **R3** (the admin project page's Deliverables tab, PIN retired), **C1**
> (real client sessions) and **C2** (portal rebuilt in place) are done: Bunny attaches to
> those records and screens, not to the old hub's. In TASKS.md's order that means after C9.
> Where a slice names something R1/R3/C1-C5 builds (a table, a screen, the portal's
> project read), use the name that task actually landed with.

**What changed from the old plan, and why**

- **No more "link by NAS path".** Projects are server-side now, so a Bunny row belongs to
  one **deliverable version** (R1). The NAS path is only where the file came from.
  Publishing is a server action on that version, so nothing has to copy URLs into an asset.
- **Admin calls go through billing's login.** The admin is same-origin on
  `app.lsccreative.studio`, so publish and status routes live under `/api` behind billing's
  `requireAuth`. `/hub/publish-asset` and `/hub/publish-status` (Slice 2's first cut, in
  `admin/server/src/hub/routes.js`) lost the PIN in R3 and sit behind billing's login until
  Slice 2 moves them.
- **The server builds media URLs when it answers, it doesn't store them.** The portal's
  project reply works out each deliverable's review and download URLs from its Bunny row.
  That's what lets Slice 9 sign them and leave out locked downloads in one place.
- **Bunny paths and collections use stable ids, not folder names or UPIDs.** A UPID can be
  empty or change until invoices lock it, so the collection is named `<projectId> <name>`
  and keyed by `projects.id`. Edge Storage paths are `/<projectId>/<itemId>/<versionId>/<file>`.
- **Bunny pulls from a short-lived signed URL**, not a permanent `/hub/files/<token>`.
  Permanent public tokens are what payment (F3) has to shut, so publishing doesn't mint new ones.
- **Cleanup never touches what Past projects shows.** Slice 11's timer only removes what
  no client reply refers to any more. Taking an archived project's files offline is a
  manual, explained, reversible button.

Tags: **[USER]** = only the user can do it (dashboards, keys, NAS shell).
**[API]** = `admin/server/` (tests in `admin/server/test/`, `npm test` stays green;
going live is a NAS deploy per `admin/.design/DEPLOYMENT.md`). **[ADMIN]** = `admin/web/`
(the project page's Deliverables tab). **[PORTAL]** = `client-hub-app/index.html`.
**[DESKTOP]** = new `desktop-publisher/`.

**Player guardrail:** every [PORTAL] slice ends by re-running the 6-point player contract
in `feature-spec.md` (desktop Chrome, desktop Safari, ≤768px), and isn't done until it
passes. The pause → timestamp → revision field flow is the part the user cares most about.

**Carries over unchanged:** Slice 0 (Bunny library, storage zone, pull zone; keys in the
1Password Environment "LSC Client Hub Bunny"), Slice 1 (HLS in `#asset-video`, which C2
must keep), and from Slice 2's first cut: `admin/server/src/hub/bunny.js` (native fetch,
title-tag lookup proven against the real library on 2026-11-03), the in-flight map that
stops two publishes of one file racing, the "adopt after a crash" lookup, `sourceChanged`,
and the 503 when Bunny keys are missing (so no crash loop on deploy).

## Task Slices

### Part A — Foundation

- [x] Slice 0: **[USER]** Bunny setup. Done 2026-10-20 (see `scratchpad.md`). Optimizer
      and the Dynamic Image API were declined then, and again on 2026-11-07: no Optimizer.
      | Model: Sonnet 5.5 | Effort: Low

- [x] Slice 1: **[PORTAL]** HLS in the existing review player (`attachReviewSource`,
      hls.js 1.7.3 light, pinned + SRI, lazy-loaded). Desktop Safari 81/81, iPhone
      Simulator 44/44. The physical iPhone check is in Slice 5. | Model: Opus 5.5 | Effort: High

### Part B — Video publishing (merge task B2)

- [x] Slice 2: **[API]** Publish a deliverable version's video.
      - New numbered migration: rebuild `bunny_assets` keyed by `(version_id, kind)` with
        `project_id`, `item_id`, `source_path` (NAS relative path), `source_size`,
        `source_mtime`, `bunny_video_id`, `collection_id`, `publish_tag`, `storage_path`,
        `status`, `error`, `progress_done`, `progress_total`, timestamps. Change
        `bunny_collections` to key on `project_id`. Check first that the live tables are
        empty (no real publish has happened) and refuse to migrate if not.
      - `POST /api/projects/:id/deliverables/:itemId/versions/:versionId/publish`
        (`requireAuth`), body `{ force? }`. The version's NAS path goes through the
        existing guards in `hub/deliverables.js` (same video extensions, no root-level
        files). The source URL is a signed `/hub/source/<path>?token&expires` (6h,
        `url-signing.js`), a new read-only route on `hub-api` that streams with Range like
        `/hub/files`. Then: get or create the project's collection → Stream fetch →
        store the row. Re-publishing returns the existing row unless `force`.
      - `GET /api/projects/:id/deliverables/:itemId/versions/:versionId/publish` returns
        `{ status, error, sourceChanged, posterUrl, progress }` and adopts a video Bunny
        hasn't listed yet (the existing lookup and 30-minute limit).
      - Port the logic out of `hub/routes.js` into a `src/bunny-publish.js` that both the
        routes and later slices call, and drop those two `/hub` routes. R3 landed the publish
        route itself (`routes/deliverables.js`, sets `published_at`): this slice gives it the fetch.
      - Tests (fake Bunny from the OpenAPI shapes, as Slice 2's first cut had 57/57): guards,
        idempotency, 3 simultaneous publishes, force, failure keeps the old video, late
        listing, adoption, timeout, restart, signed source URL expires, another project's
        version id is a 404, no key in any log line. | Model: Opus 5.5 | Effort: High
      **Done 2026-11-26 (not deployed):** schema v33 (both tables rebuilt; it stops if the old ones
      hold a row, and the live ones are empty). `src/bunny-publish.js`; `GET /hub/source/<versionId>/<name>`
      signed per version for 6 hours. **One change from the plan:** R3's `…/publish` already means
      "show it to the client", so the Bunny fetch is its own pair, `POST`/`GET …/versions/:versionId/bunny`;
      Slice 4 decides how the Deliverables tab chains them. A status read also asks Bunny about a known
      video still transcoding (`getVideo`), so a row turns ready without the webhook. Rows have no foreign
      keys on purpose (they point at what Bunny bills for, so cleanup must find them). The hub import now
      skips empty hub Bunny tables and refuses a row. 16 tests in `test-bunny-publish.js` (fake Bunny in
      `test/fake-bunny.js`); code review's 7 fixed, 1129/1129. Force is refused once the client has the
      version (Slice 4: no Republish there). Not checked against real Bunny again (the 2026-11-03 live test
      still stands for the calls). The NAS `.env` has no `BUNNY_*` yet (checked 2026-11-26).

- [x] Slice 3: **[API]** `POST /hub/bunny-webhook` on `hub-api`, mounted in `app.js`'s
      raw-body slot (or above the hub router's `express.json`) with `express.raw()`, so the
      HMAC is over the exact bytes (merge safeguard **S20**). Verify
      `X-BunnyStream-Signature` (HMAC-SHA256 with `BUNNY_STREAM_READ_KEY`, constant-time),
      reject unsigned or wrong. Webhook status map: 3 → ready, 4 → playable, 5 → failed,
      0-2 → processing. That map is **not** the REST one; the 30-minute fallback keeps using
      `statusFromVideo`. An unknown id → 200, then try the tag lookup for rows still
      waiting for their id (a webhook can beat the lookup). A video turning ready or failed
      adds or clears the IA's "Publish failed" item in Needs you (R5). Tests: signed
      passes; unsigned, tampered and re-serialised bodies fail; a test that fails if a JSON
      parser is ever mounted ahead of it; unknown id; out-of-order events.
      | Model: Sonnet 5.5 | Effort: High
      **Done 2026-11-26 (not deployed):** the route sits in the hub router above its JSON parser, with
      `express.raw`. Signing per Bunny's docs: lowercase hex HMAC-SHA256 of the raw body with the
      read-only key, plus `X-BunnyStream-Signature-Version: v1` and `-Algorithm: hmac-sha256`. Codes: 0-2
      and 4 processing (never undoing ready), 3 ready, 5 failed, 32 (video deleted) failed; the rest are
      ignored. Each row keeps the newest event `Timestamp` it applied (`last_event_at`, added to v33, which
      had run nowhere), so an older event can't undo a newer one. An unknown id answers 200 and sends the
      rows still waiting for their id to look again, in the background. Needs you's **Publish failed** is
      computed: a failed row on a needed item's newest version, gone once ready or replaced. 8 tests in
      `test-bunny-webhook.js`; 1137/1137.

- [x] Slice 4: **[ADMIN + API + PORTAL]** Publish from the Deliverables tab, play in the portal.
      - Admin (R3's deliverable item): a **Publish to Bunny** action beside the version's
        file, polling status: Processing / Ready / Failed with the reason / "The NAS file
        changed since publishing" with Republish. Poster thumbnail when ready. A version
        isn't offered to the client until its publish is ready.
      - API: the portal's project reply (C1/C3's route; today's equivalent is
        `GET /hub/records/:projectId`) gives a Bunny version `review: { type:'hls', url,
        poster }`, built from the row. Versions with no Bunny row keep their NAS link, so
        old projects play unchanged.
      - Portal: the review player takes `review.url` through `attachReviewSource`; landing
        and dashboard cards use `poster` as an `<img>`. Update any publish help copy.
      - Player guardrail applies. | Model: Opus 5.5 | Effort: High
      **Done 2026-11-26 (not deployed):** two steps, not one button (Bunny takes minutes and Publish can
      email the client): the version's **Bunny Stream** block (Send to Bunny, Processing checked every 10 s,
      Ready with Bunny's thumbnail, Failed with the reason, Old cut with Republish… only before the client has
      it), then Publish, disabled until it's ready. The server holds it too: with Bunny on, a video's publish
      answers 409 `bunny_not_ready` or `bunny_stale`; photo libraries aren't held; Bunny off holds nothing.
      `reviewOf` gives `{ type:'hls', url, poster }` for a ready row only (built when the portal answers);
      no row, processing, failed or Bunny off keep the NAS link. Portal cards and `#asset-video` take the
      poster (the dashboard has no media cards). Player contract 1-6 passed on HLS in Chromium, desktop and
      375 px, against a fake Bunny and a public test stream; desktop Safari and the iPhone are Slice 5's.
      `test-bunny-review.js` (6) + a portal page check; 1149/1149.

- [x] Slice 5: Verify video end to end and deploy. **[USER]** Before deploying, check the
      NAS `.env` for the 8 `BUNNY_*` names (without them publishing answers 503; it no
      longer stops the server). Also confirm the live `bunny_assets` and `bunny_collections` are
      empty on the dry-run copy and on the live db (v33 stops on a row; DEPLOYMENT.md step 5).
      **[USER]** In Bunny, set the library's webhook URL to
      `https://hub-api.lsccreative.studio/hub/bunny-webhook` (Stream → library → Webhooks); without
      it, status still arrives through the 30-minute lookup on each status read.
      **[USER]** Bunny's HLS and poster links are public until Slice 9 signs them (the NAS
      review route needed the client's session): in the library's Security settings, set
      Allowed Referrers to `lsccreative.studio`, then check on the iPhone that playback still
      works (native HLS sends the page as referrer; if it doesn't play, clear the setting). Deploy to the NAS. Real deliverable on the NAS → Publish →
      Ready → client signs in on another device → full player contract on desktop Chrome,
      desktop Safari and a **physical iPhone** → notes → approve. Also check a large master
      fetches through the Cloudflare Tunnel, and that an imported NAS-linked version still
      plays. **Decide `playsinline` with the user** (today every iPhone play goes fullscreen
      and the client must exit to comment); if adopted, re-run the contract on the iPhone.
      Log results in `scratchpad.md`. | Model: Opus 5.5 | Effort: Medium
      **So far (2026-11-26/27):** NAS deployed at v33 with the 8 `BUNNY_*` set; webhook URL and
      Allowed domains (`lsccreative.studio`, `app.lsccreative.studio`) set; a 369 MB real file went
      through the Tunnel to Ready by the signed webhook in ~8 min; published; the live portal plays it
      as Bunny HLS. Contract: desktop Chrome passed (View as client, then the user signed in); the
      user's iPhone (Chrome for iOS, WebKit + native HLS) and Mac Chrome sent two notes on v3 as one set,
      one stamped at the exact frame. **`playsinline` adopted** (the user, 2026-11-27), in the portal page,
      so it ships with the Pages release (live 2026-11-27, `49f43fc` + the workflow fix `4b9e11a`).
      **Done 2026-11-27:** on the user's iPhone (Chrome for iOS), after choosing their 4-digit PIN, PTC9
      Video 1 v4 (Bunny, ready) played inline and a note was added and sent as a set (`cs_4702defe`, stage
      final, 1 note, no timestamp on it). **Not checked, carried to Slice 12:** desktop Safari; an imported
      NAS-linked version (none exists on the live db: PTC9's were made here).

### Part C — Photos & masters (merge task B3)

- [x] Slice 6: **[API]** Photo libraries → Edge Storage, **without Bunny Optimizer** (user,
      2026-11-07). The server makes the smaller sizes itself at publish: a grid size (~600px
      wide) and a lightbox size (~2400px), JPEG, beside the untouched original. This adds the
      `sharp` dependency; check it builds in the NAS image first, and if it won't, stop and ask
      before falling back to originals only. Publishing a photo version reuses `listDeliverableFolderImages` (same cap and extensions) and
      streams each image from the read-only mount to Edge Storage with `PUT` at
      `/<projectId>/<itemId>/<versionId>/{original,600,2400}/<file>`, 4 at a time, skipping
      files already there at the same size. A background job: the route returns at once and status reports
      `n/total`, surviving a restart (resumes from the rows). The reply gives photos as
      `{ name, grid, review, download }` built from the rows (download = original). Tests:
      partial failure, resume, a file replaced mid-job, cap, sizes made and never upscaled. | Model: Opus 5.5 | Effort: High
      **Done 2026-11-27 (not deployed):** `sharp` 0.35.5 checked in the NAS's `node:22-bookworm-slim` (x64)
      first. Schema **v36** `bunny_photo_files` (one row per photo: size, mtime, width, height, status);
      `src/bunny-photos.js` (the job), Edge Storage PUT/list/URL in `hub/bunny.js`; the existing
      `…/versions/:versionId/bunny` routes take a photo version. 600 by width, 2400 inside a 2400 box,
      JPEG, EXIF-upright, never upscaled; a .png/.webp's sizes are `<file>.jpg`. Skips a photo done and
      unchanged, and an original Bunny holds with the same SHA-256 (Checksum header on every PUT). Resumes
      at start-up. **Two changes from the plan, on purpose:** (1) originals go under `original-<tag>/`
      (a random tag per version in `publish_tag`), not `original/`: Bunny's links are public until Slice 9,
      and swapping `2400` for `original` must not reach the paid original; (2) the client's reply has
      `photos: [{ key, name, width, height, grid, review }]` beside the NAS `urls`, and **no download**: the
      reply offers none (C2) until a gate does (Slices 8-9, F3). `key` is the NAS links' photo key, so notes
      match either way. A library shows from Bunny only once every photo is there. 1171 tests
      (`test-bunny-photos.js` 7).

- [x] Slice 7: **[ADMIN + PORTAL]** Photos from Bunny. Admin: the same Publish action on
      photo versions with `n/total`. Portal: `photoSrc(ph, size)` picks the server-made
      size for Bunny photos (grid in the grid and landing strip, the lightbox size in the
      lightbox), and the original only for download. NAS-linked libraries render as
      today. Check the lightbox's per-photo notes, the per-photo draft isolation and
      keyboard nav. Player guardrail applies. | Model: Sonnet 5.5 | Effort: Medium
      **Done 2026-11-27 (not deployed):** Deliverables tab: a photo version has a **Bunny Storage** block
      (Send to Bunny, "Sending n of total", Ready · N photos, Folder changed → Send changes to Bunny… with a
      confirm), its Publish held only while Bunny has a set the folder moved on from (`bunny_stale`, server and
      tab); the folder reply carries a photo row's `progress` (delivery.js).
      Portal: `photosOf(review)` keeps each photo's NAS link as its identity (notes, drafts, the address)
      and attaches the Bunny sizes by key; `photoSrc(ph, 'grid'|'full')` picks them (contact sheet and
      landing strip: grid; lightbox: full), NAS link otherwise, and a Bunny size that won't load swaps once to
      the NAS link (`photoImg`/`photoFallback`). The reply's photos are `{ key, grid, review }` only. Review
      fixes: Stream's adopt pass (`waitingForId`) is videos only, so a webhook can't fail a long photo send.
      Checked on scratch with a fake Bunny serving its storage: sending with n/total in the tab, the strip,
      the sheet and the lightbox on Bunny sizes (never enlarged), arrow keys, Escape back to the tile, an
      old note on the right photo, a draft kept per photo, a new note saved on the right photo, 375 px.
      Not checked: desktop Safari (the video player itself is unchanged). 1172 tests.

- [x] Slice 8: **[API + ADMIN]** Video masters. Publishing a **Final** video also `PUT`s the
      untouched master to Edge Storage (`kind:'master'`, Slice 6's job pattern), so 4K
      downloads at full resolution. Draft Cuts never upload a master (they're never
      downloadable, per the brief). The reply's download for that version is the master's
      CDN URL, given only where the download gate (C4/C5 now, F3 later) allows it. Old
      versions with NAS download links still work. | Model: Sonnet 5.5 | Effort: Medium
      **Done 2026-11-27 (not deployed):** no migration (v33 already allows `kind = 'master'`).
      `src/bunny-masters.js`: Send to Bunny on a Final also sends its master to
      `/<projectId>/<itemId>/<versionId>/master-<tag>/<file>` (a random tag; a Republish takes a new one, so
      the pull zone can't serve the old file under the old address), in the background, **one at a time**,
      read once for its SHA-256 and once going up (n/total counts both), with no total time limit but ended
      after 5 minutes of no bytes moving; resumed at start-up, skipped when Bunny holds the same bytes, sent
      again once if saved over mid-send. A plain send again sends a missing or failed master and leaves
      Stream; a failed master never holds Publish or shows in Needs you. **The user's call (2026-11-27): the
      link goes only into C10's paid email**, beside the Drive link ("Each link downloads the full-quality
      file. The Google Drive copy is a backup."); **the portal reply carries no download** until F3/F5. A master
      landing calls the email's check, so one that lands after the email went sends an "Updated files" email;
      the set key gains the master's link only when there is one, so every set already sent or baselined keeps
      its key. Deliverables tab: a **Master** line under Bunny Stream on a Final (Sending n%, On Bunny, Failed
      with Send master again, and Send master for a Final sent before this). Tests: `test-bunny-masters.js` 7;
      1181. Checked on scratch with the fake Bunny at desktop and 375 px: an old Final's Send master, a new
      Final's master sending beside Stream, a refused master and its retry, focus kept on the block.
      **For Slice 9:** a link in an email can't expire in 6 hours. The paid email's master links need their
      own answer when the storage pull zone gets token auth (a long-lived signed link, or a `hub-api` route
      that checks and redirects), or every emailed master breaks.

### Part D — Lock it down (merge task B4; payment can't start until this is done)

- [x] Slice 9: **[USER + API + PORTAL]** Signed, expiring media URLs. The user turns on
      token auth for the Stream pull zone and the storage pull zone and adds
      `BUNNY_CDN_TOKEN_KEY` to 1Password and the NAS `.env`. The portal's project reply
      signs every Bunny URL as it goes out (HLS with a path token covering `/<videoId>/` so
      segments load), and **leaves out** every download the server-side gate refuses: one
      function, the same one F3 will extend, not a UI check. Unsigned URLs stay in the DB.
      TTL starts at 6h. In the player, a 403 from hls.js or the native element re-fetches
      the reply, re-attaches at the same `currentTime` and paused state, and keeps the
      revision draft and timestamp pill (`attachReviewSource` already swaps only the hls
      instance on the same element). Also: Slice 2's `/hub/source/` links expire, and NAS
      `/hub/files/` links are left for F3. Test with a forced short TTL. Player guardrail
      applies. | Model: Opus 5.5 | Effort: High
      **Code live 2026-11-27 (`46bf5f9`, NAS + Pages #7), links unsigned until the user's Bunny steps; not ticked until the live test:** signing is
      `src/hub/bunny-tokens.js` (Bunny's advanced HMAC-SHA256 token, `HS256-…`, after Bunny's Node reference),
      applied in one place, `hub/bunny.js`'s URL builders, so every reply signs as it answers and the DB keeps
      nothing signed. **Two keys, not one:** the Stream library and the storage zone are separate pull zones,
      so `BUNNY_STREAM_TOKEN_KEY` and `BUNNY_STORAGE_TOKEN_KEY` (each unset = that zone's links go unsigned,
      which works until its token auth is on). A video's playlist and poster carry a folder token
      (`token_path=/<videoId>/`) in the path (`/bcdn_token=…/<videoId>/playlist.m3u8`) so segments load;
      photos a per-file token; 6 h, rounded up to the hour so the browser's cache keeps working
      (`BUNNY_SIGNED_TTL_SECONDS` forces a short one for testing). **Emailed masters (the user's call):** the paid
      email links to `GET /hub/download/<versionId>/<name>` on hub-api, signed by `HUB_SIGNING_SECRET` for 90 days;
      each click is checked (`downloadRefusal`: a Final video, item needed, project not download-locked: the
      hook F3/F4 extend) and redirected to the master signed for 24 h. The email's set key names the upload
      (`masterKey`), never the link. Portal: a video that fails asks for the project again and, for the same
      version, puts the fresh link on the SAME `<video>` at the same time, paused or playing as it was (no
      render: pill, panel and draft untouched; once per link, then the card as before); hls.js now hands the
      playhead over instead of tearing the element down. Photos that fail still fall back to the NAS link.
      Tests: `test-bunny-signing.js` 3, page rules; 1185. Checked in the browser on scratch: a fatal 403 on
      hls.js mid-review renewed in place at 8.88 s, paused, pill 00:08, draft and focus kept. **Not checked:**
      the playing case (the pane's page is hidden, so Chromium pauses media) and Bunny accepting the tokens
      (only possible once token auth is on). `/hub/source/` links already expire (6 h, Slice 2).
      Review fixes (all 4): the open video's link is renewed 5 minutes before it runs out (an iPhone's
      own player can stall on an expired segment without an error; a phone that slept renews on waking);
      Try again reads the project first; an expired photo link is renewed once (one read for a burst of
      tiles) before the NAS copy; the paid email's key change was checked live (no master rows on the NAS,
      so nothing re-sends; still true only if no master is sent before this deploys). 1186. Checked on
      scratch: early renewal mid-note (9.96 s, paused, pill, draft kept), Try again after the card, an
      expired photo tile going fresh link then NAS.
      **Live test PASSED 2026-11-28:** both keys in the NAS `.env`, Token Authentication on in both pull zones
      (Stream 6014428, storage `lscclientmedia` 6833812; IP validation off). Stream: signed playlist, quality
      playlist and poster 200, unsigned 403. Storage (a test file uploaded, checked and deleted): signed 200,
      unsigned, wrong-token and expired 403. **Found and fixed on the way:** `BUNNY_STORAGE_PASSWORD` (NAS and
      1Password) was the OLD `clienthubdata` zone's password, so every photo/master upload to `lsc-client-media`
      would have got a 401; the user put the right one in 1Password, it's on the NAS now (backup
      `.env.pre-storagepw`) and the Sydney host takes it. **Still to see once real work goes through:** the first
      real photo send and master upload, a paid-email download redirecting, renewal while playing, desktop Safari.

### Part E — Desktop publisher (merge task B5)

- [ ] Slice 10: **[DESKTOP]** Still wanted (user, 2026-11-07). SwiftUI `MenuBarExtra` in
      `desktop-publisher/`, no third-party deps. Signs in with the **billing account**
      (`/api` login, session cookie kept by URLSession, password never stored). Pick a
      project and deliverable from `/api`, drag a file: copy it onto the mounted NAS share
      if it isn't there, add it as a new version, publish, show progress. Holds no Bunny
      key. README with build/run steps. | Model: Opus 5.5 | Effort: High

### Part F — Cost control & close-out (merge task B5)

- [ ] Slice 11: **[API + ADMIN + PORTAL]** Cleanup, plus Take offline.
      **Automatic cleanup** never removes what a client can still open. A daily
      in-process timer deletes only Bunny objects that no client reply refers to: versions
      replaced by a newer one more than `BUNNY_RETENTION_DAYS` (default 90) ago, and
      anything whose project or deliverable no longer exists. The current version of every
      deliverable stays, **including on archived projects shown under Past projects**, and
      an approval's file version is kept while that approval stands (S12). Rows become
      `expired`; the run logs what it removed; NAS copies are never touched. A dry run is
      the default on the first deploy. Tests: archived project untouched, approved version
      kept, replaced draft removed after the window.
      **Take offline** (user, 2026-11-07): a manual button on an archived project's page in
      the admin. Hovering it explains what it means, in plain words: the client's files are
      removed from Bunny to save cost, the project stays under the client's Past projects
      with its notes and approvals, the client sees "These files are offline. Ask us and
      we'll put them back", and the masters on the NAS are untouched. The same explanation
      shows on keyboard focus and is repeated in the confirmation dialog, since hover doesn't
      exist on a phone or tablet. Confirming deletes that project's Stream videos,
      collection and Edge Storage files and marks the rows `offline` (kept, not deleted).
      **Bring back online** republishes the current versions from the NAS (it says which
      files are missing from the NAS, if any). Only archived projects offer it; unarchiving
      an offline project keeps it offline until brought back. The portal shows the offline
      state wherever the files would be. Tests: only archived projects, rows kept, the
      client reply carries no Bunny URL while offline, bring back republishes, a NAS file
      gone is reported. | Model: Opus 5.5 | Effort: High

- [ ] Slice 12: Full verification + docs. Run every acceptance criterion in
      `feature-spec.md` live. Grep the repo, the portal and the widget for key-shaped
      strings. Update `client-hub-docs/NAS-DELIVERABLES.md` (publishing, the tables, the
      webhook, signed links, retention), the admin's `.design/WORKING_NOTES.md` traps and
      `ROADMAP.md`, and any help copy. | Model: Opus 5.5 | Effort: Medium
