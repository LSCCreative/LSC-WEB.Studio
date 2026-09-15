# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

Client Hub v2: self-hosted NAS backend. Fix the broken admin login, remove
the manual `ADMIN_API_KEY` paste step, and migrate `client-hub-app`'s data
layer + video delivery off Bunny (Storage, Edge Script, Stream) onto the
user's Ugreen NAS — reusing the Docker/Cloudflare Tunnel pattern already
proven by the (completed) marketing-site video migration in
`buildplan.md`'s history.

Full context: [.design/client-hub-nas-backend/DESIGN_BRIEF.md](.design/client-hub-nas-backend/DESIGN_BRIEF.md)
and [.design/client-hub-nas-backend/TASKS.md](.design/client-hub-nas-backend/TASKS.md).

### Decisions already made (do not re-litigate without user sign-off)

- **Admin auth**: email + PIN is the entire security boundary. PIN check
  moves server-side (NAS API) — no more hardcoded PIN/email in shipped JS,
  no `ADMIN_API_KEY` paste. Server issues a session cookie/token on success.
- **Admin entry point**: dedicated login screen (the existing `renderLock`
  PIN screen, reused), reached via a visible low-emphasis link at the
  bottom of the client login screen — not just the hidden `?admin=1` URL
  param (which keeps working as a direct link).
- **Backend**: Node + Express + SQLite in Docker on the NAS, on the same
  `media_net` network as the existing `lsc-media-server` container, exposed
  via a new Cloudflare Tunnel public hostname (not raw port-forwarding).
- **Video**: MP4 progressive download/playback only. No HLS/transcoding for
  client deliverables (unlike the marketing site's video, which does use
  HLS).
- **Video URL scheme**: stable, unguessable per-file URL (matches today's
  "admin pastes a URL into the asset field" workflow) — not a short-lived
  signed-URL system. Record/auth data gets real server-side access control;
  individual video links keep the same trust level as the current Bunny
  Stream links.
- **Resilience**: NAS is primary and considered reliable. Per-deliverable
  optional Google Drive backup link; if the NAS video fails to load client-
  side, show a fallback card with that link instead of a broken player.
- **Cutover**: full retirement of Bunny for the client hub once verified —
  no long-term dual-running, mirrors the marketing site's Slice 12.

### Current state (Bunny-based, being replaced)

- `client-hub-app/index.html` — single-file app, `HUB_CONFIG.mode='live'`
  talks to a Bunny Edge Script via `hubFetch`/`hubApi`.
- `client-hub-docs/hub-edge-script.js` — the Edge Script: `/hub/publish`,
  `/hub/auth`, `/hub/sign`, `/hub/notify`, backed by Bunny Storage JSON
  blobs and a Bunny CDN pull-zone token-auth scheme.
- Admin auth today: hardcoded `ADMIN_EMAIL`/`PIN` client-side
  ([client-hub-app/index.html:136-137](client-hub-app/index.html:136)),
  plus a manually-pasted `ADMIN_API_KEY` bearer token stored in
  `sessionStorage` after PIN entry.
- Reference precedent: `nas/media-server/docker-compose.yml` + `Caddyfile`
  — Caddy container on `media_net`, Cloudflare Tunnel to
  `media.lsccreative.studio`, already live for the marketing site's video
  (unrelated to this feature but the infra pattern to follow).

## Acceptance Criteria

See the per-task checklist in
[.design/client-hub-nas-backend/TASKS.md](.design/client-hub-nas-backend/TASKS.md)
— that file is the authoritative task breakdown; `buildplan.md` mirrors it
in this repo's own slice format for session-to-session execution tracking.

## Out of Scope

- Migrating the main marketing site's video (already done, see
  `buildplan.md` history / git log "Close out Slice 12").
- Adaptive bitrate/HLS for client deliverables.
- Multi-admin accounts, roles, or password reset flows.
- Migrating existing Bunny-hosted client records/videos to the NAS (a
  one-time data migration pass, follow-up task, not part of this build).
- NAS-wide hardening/redundancy beyond what this one additional Docker
  service needs.
