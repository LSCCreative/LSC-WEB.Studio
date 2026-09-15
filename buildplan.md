# Build Plan

## Feature: Client Hub v2 — Self-Hosted NAS Backend & Video Delivery

Slices marked **[NAS]** run on the NAS itself (Docker, files, Cloudflare
Tunnel dashboard) — the executing agent needs full NAS access, not just
this repo. Slices marked **[WEB]** run in `client-hub-app/index.html` in
this repo. Work strictly top-to-bottom; don't skip ahead.

Full context: [.design/client-hub-nas-backend/DESIGN_BRIEF.md](.design/client-hub-nas-backend/DESIGN_BRIEF.md)
and [.design/client-hub-nas-backend/TASKS.md](.design/client-hub-nas-backend/TASKS.md)
(this file mirrors that task list in the repo's own execution-tracking
format — keep both in sync if either changes).

## Task Slices

- [x] Slice 1 **[NAS]**: Add a new `client-hub-api` service (Node +
      Express + SQLite) to the NAS Docker Compose setup, on the same
      `media_net` network as `lsc-media-server`
      ([nas/media-server/docker-compose.yml](nas/media-server/docker-compose.yml)).
      Persistent volume for the SQLite DB. Create a new client deliverables
      folder on Storage Pool 4, parallel to `LSC Website_Media` (e.g.
      `LSC Creative_Media/Client Deliverables/`, one subfolder per
      project), and mount it read-only into the container. | Model: Claude
      Code | Effort: Medium

- [x] Slice 2 **[NAS]**: Add a new public hostname (e.g.
      `hub-api.lsccreative.studio`) to the same Cloudflare Tunnel used for
      `media.lsccreative.studio`, routed to the `client-hub-api`
      container's port. Verify it resolves over HTTPS from outside the
      home LAN. | Model: Claude Code | Effort: Low

- [x] Slice 3 **[NAS]**: Reimplement the four data routes from
      [client-hub-docs/hub-edge-script.js](client-hub-docs/hub-edge-script.js)
      (`/hub/publish`, `/hub/auth`, `/hub/sign`, `/hub/notify`) in
      Express against SQLite tables instead of flat Bunny Storage JSON
      blobs — same request/response shapes, same email-hash/code-hash/
      invite-token indexing logic. Add a new `POST /hub/admin-auth` route
      that checks email + PIN against a server-only value (env var or DB
      row — never shipped to the client) and issues an HttpOnly session
      cookie/token on success. Add session-check middleware gating
      `/hub/publish` and `/hub/notify`. | Model: Claude Code | Effort: High

- [x] Slice 4 **[NAS]**: Implement the NAS video URL scheme — each file in
      the client deliverables folder gets a stable, unguessable URL
      (random path segment or long-lived query token), served by
      `client-hub-api` with HTTP Range support for MP4 scrubbing/resuming.
      No expiring-signature system for video specifically (record/auth
      data already gets real access control via `/hub/auth`; video links
      keep the same trust level as today's pasted Bunny Stream URLs).
      Document the admin's actual workflow (where to drop a file, what URL
      to paste into the asset editor) in `client-hub-docs/`. | Model:
      Claude Code | Effort: Medium

- [x] Slice 5 **[WEB]**: Point `HUB_CONFIG.edgeBase` at the new
      `hub-api.lsccreative.studio` hostname; update `hubFetch`/`hubApi` to
      send `credentials:'include'` so the session cookie flows
      automatically instead of the old `Authorization: Bearer
      ADMIN_API_KEY` header. | Model: Claude Code | Effort: Low

- [x] Slice 6 **[WEB]**: Admin PIN screen
      ([client-hub-app/index.html:433-448](client-hub-app/index.html:433)):
      replace the client-side `emailOk && pinInput === PIN` compare with an
      async POST to `/hub/admin-auth`. Add checking (disable keypad,
      existing pin-dot fill animation), wrong-PIN (existing red
      `.pin-dot.error` shake, unchanged), and network/NAS-unreachable
      (small `text-[var(--lsc-mid)]` mono message below the dots, keypad
      re-enables) states. Remove the hardcoded `ADMIN_EMAIL`/`PIN`
      constants ([client-hub-app/index.html:136-137](client-hub-app/index.html:136))
      from the shipped file entirely. | Model: Claude Code | Effort: Medium

- [ ] Slice 7 **[WEB]**: Remove `renderAdminKeyBar`,
      `ADMIN_KEY_SS`/`adminKey()`, and the `admin:true` bearer-header
      wiring in `hubFetch`
      ([client-hub-app/index.html:652-658](client-hub-app/index.html:652))
      — the session cookie from Slice 6 now carries all admin auth. | Model:
      Claude Code | Effort: Low

- [ ] Slice 8 **[WEB]**: Add a small low-emphasis "Admin" text link at the
      bottom of the client login screen, styled like the existing
      "SIMULATE MODE" footer caption
      ([client-hub-app/index.html:428](client-hub-app/index.html:428)),
      navigating to the admin PIN screen. `?admin=1` keeps working as a
      direct deep link. | Model: Claude Code | Effort: Low

- [ ] Slice 9 **[WEB]**: Add an optional "Backup link (Google Drive)"
      `.field` to each asset row in the admin editor, alongside the
      existing reviewLink/downloadLink/driveLink inputs, and persist it
      through `buildPublishedRecord`
      ([client-hub-app/index.html:189-200](client-hub-app/index.html:189)).
      In the client asset view, on video load error, swap the player for a
      `.card` with a short unavailable message and — only if a backup link
      is set for that asset — a `.btn-sage` "View on Google Drive" button
      opening it in a new tab. | Model: Claude Code | Effort: Medium

- [ ] Slice 10 **[WEB]**: Responsive pass — confirm the new login link,
      checking/error states, fallback card, and editor field all work at
      mobile widths using existing responsive components only; any new
      rules go in the existing `@media (max-width: 768px)` block per
      `CLAUDE.md`'s Cross-Device Responsive Architecture rules. Then an
      accessibility pass: keyboard operability of PIN keypad/login form,
      visible-text state announcements, visible focus state on the Drive
      fallback button. | Model: Claude Code | Effort: Low

- [ ] Slice 11 **[WEB + NAS]**: End-to-end verification — admin logs in
      live against the NAS from a network outside the house (proves the
      tunnel path, mirrors the marketing-site feature's Slice 11); client
      watches/downloads a NAS-hosted video; force a video load failure and
      confirm the Drive fallback appears correctly (and stays hidden when
      no backup link is set). | Model: Claude Code | Effort: Low

- [ ] Slice 12 **[WEB]**: Once the NAS path is verified working end-to-end,
      drop the now-unused `HUB_CONFIG` Bunny fields
      (`storageZone`/`s3Endpoint`/`storageHost`/`pullZone`/`pullZoneId`/
      `streamLibraryId`), decide with the user whether
      `client-hub-docs/hub-edge-script.js` is kept for reference or
      deleted, and confirm the Bunny plan covering the client hub can be
      downgraded/cancelled (mirrors the marketing-site feature's Slice 12).
      Commit. | Model: Claude Code | Effort: Low
