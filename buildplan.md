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

- [ ] Slice 2: **[API]** Publish a deliverable version's video.
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

- [ ] Slice 3: **[API]** `POST /hub/bunny-webhook` on `hub-api`, mounted in `app.js`'s
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

- [ ] Slice 4: **[ADMIN + API + PORTAL]** Publish from the Deliverables tab, play in the portal.
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

- [ ] Slice 5: Verify video end to end and deploy. **[USER]** Before deploying, check the
      NAS `.env` for the 8 `BUNNY_*` names (without them publishing answers 503; it no
      longer stops the server). Deploy to the NAS. Real deliverable on the NAS → Publish →
      Ready → client signs in on another device → full player contract on desktop Chrome,
      desktop Safari and a **physical iPhone** → notes → approve. Also check a large master
      fetches through the Cloudflare Tunnel, and that an imported NAS-linked version still
      plays. **Decide `playsinline` with the user** (today every iPhone play goes fullscreen
      and the client must exit to comment); if adopted, re-run the contract on the iPhone.
      Log results in `scratchpad.md`. | Model: Opus 5.5 | Effort: Medium

### Part C — Photos & masters (merge task B3)

- [ ] Slice 6: **[API]** Photo libraries → Edge Storage, **without Bunny Optimizer** (user,
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

- [ ] Slice 7: **[ADMIN + PORTAL]** Photos from Bunny. Admin: the same Publish action on
      photo versions with `n/total`. Portal: `photoSrc(ph, size)` picks the server-made
      size for Bunny photos (grid in the grid and landing strip, the lightbox size in the
      lightbox), and the original only for download. NAS-linked libraries render as
      today. Check the lightbox's per-photo notes, the per-photo draft isolation and
      keyboard nav. Player guardrail applies. | Model: Sonnet 5.5 | Effort: Medium

- [ ] Slice 8: **[API + ADMIN]** Video masters. Publishing a **Final** video also `PUT`s the
      untouched master to Edge Storage (`kind:'master'`, Slice 6's job pattern), so 4K
      downloads at full resolution. Draft Cuts never upload a master (they're never
      downloadable, per the brief). The reply's download for that version is the master's
      CDN URL, given only where the download gate (C4/C5 now, F3 later) allows it. Old
      versions with NAS download links still work. | Model: Sonnet 5.5 | Effort: Medium

### Part D — Lock it down (merge task B4; payment can't start until this is done)

- [ ] Slice 9: **[USER + API + PORTAL]** Signed, expiring media URLs. The user turns on
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
