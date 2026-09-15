# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

Slices 1-6 done. Next up is **Slice 7 [WEB]** — remove `renderAdminKeyBar`,
`ADMIN_KEY_SS`/`adminKey()`, and the `admin:true` bearer-header wiring in
`hubFetch` (`client-hub-app/index.html:652-658` pre-Slice-6 line numbers,
shifted since) — the session cookie from Slice 6 now carries all admin auth.

**Plan changed (2026-09-16, user request)**: a new **Slice 10 "PIN/code
entry — keypad to text input"** was inserted between the old Slice 9 (video
fallback) and Slice 10 (responsive pass) — old Slices 10/11/12 are now
11/12/13. User complaint: the tap-only numeric keypad is slow with a mouse
and can't be pasted into, so a saved PIN/code can't be reused. New Slice 10
replaces it with a real `<input class="field">` on both the admin PIN
screen and client login screen — full spec in `buildplan.md` and the
mirrored `.design/client-hub-nas-backend/TASKS.md` (new "UI/UX Adjustments"
section). Placed *after* Slices 7-9 (no dependency, keeps build order
top-to-bottom) but *before* the responsive/accessibility pass (old Slice 10,
now 11) so that pass audits the final input-based UI, not the keypad it's
about to replace. **Note**: `DESIGN_BRIEF.md`'s Key Interactions and
Reusable Components sections still describe the old `.pin-dot`/`.pin-key`
keypad — those are now stale as of this plan change; brief itself wasn't
edited (out of scope for this request), just flagging it here so a future
agent doesn't treat the brief as current for PIN-entry specifics once
Slice 10 lands — `buildplan.md`/`TASKS.md` are the up-to-date source for
that screen from here on.

## NAS Facts (verified 2026-09-15, trust over older notes)

- SSH: `ssh lsc-nas` (192.168.1.45, user `Lachlan`, uid 1000, gid 10/admin,
  in the `docker` group). Docker works without sudo; **`sudo` needs a
  password the agent doesn't have**.
- `/volume4` is root-owned, so new top-level dirs can't be made over plain
  SSH. Workaround used (user-approved): a throwaway root container,
  `docker run --rm -v /volume4:/v alpine:3 sh -c "mkdir … && chown 1000:10 …"`.
  Ask before reaching for this again — it's a deliberate privilege bypass.
- UGOS wraps rsync **and blocks scp/sftp** (`scp` fails with "No such file or
  directory" even though the destination dir exists). **Use `tar`/`cat` piped
  over a plain `ssh` command** for every file transfer — verified working for
  both directory trees (`tar czf - … | ssh lsc-nas 'tar xzf - -C <dest>'`) and
  single files (`… | ssh lsc-nas 'cat > <dest>'`). Set `COPYFILE_DISABLE=1` or
  sweep `._*` afterwards — Google Drive xattrs otherwise litter AppleDouble
  files across the NAS copy (harmless `tar: Ignoring unknown extended header
  keyword` warnings on the remote side are expected noise, not failures).
- Deliverables folder **already existed** as
  `/volume4/LSC Creative_Media/Client Deliverables_Media/` (contains only
  `Test Folder`). Reused it rather than making a second folder — it's already
  parallel to `LSC Creative Website_Media` and matches the `_Media` naming.
- `media_net` members: `lsc-media-server`, `lsc-billing`,
  `cloudflared-tunnel`, and now `client-hub-api`.
- `cloudflared-tunnel` is a distroless image — no `sh`, so `docker exec` into
  it fails. To test in-network reachability, use a sidecar instead:
  `docker run --rm --network media_net curlimages/curl -s http://client-hub-api:8097/health`.
- **Compose project-name trap**: `lsc-billing`'s stack lives in
  `/volume4/lsc-billing/app`, so its Compose project is literally `app`.
  `client-hub-api` deploys to `/volume4/client-hub-api/app`, which would
  collide — its compose file pins `name: client-hub-api` to prevent the two
  stacks treating each other as orphans. **Don't remove that line, and never
  run `docker compose … --remove-orphans` in either directory.**

## Slice 1 Result

- Service source of truth: [nas/client-hub-api/](nas/client-hub-api/) in this
  repo. Deployed copy: `/volume4/client-hub-api/app` (data in
  `/volume4/client-hub-api/data`).
- Node 22 + Express 5 + better-sqlite3, two-stage Dockerfile, runs as the
  unprivileged `node` user. Port **8097**, bound to `127.0.0.1` only.
- Reachable as `client-hub-api:8097` from inside `media_net`.

## Slice 2 Result

- Added via Cloudflare Zero Trust dashboard (Networks > Tunnels & Mesh >
  `deck-productions-nas` > Published application routes), not a file edit —
  tunnel is dashboard-managed, no local `config.yml` on the NAS.
- Route: `hub-api.lsccreative.studio` → `http://client-hub-api:8097` (HTTP).
- Verified over HTTPS both from inside the home LAN and (this session) via
  the same public hostname used for the Slice 3 smoke tests below — off-LAN
  cellular verification specifically is still the Slice 11 end-to-end task,
  not yet done from an actual cellular device.

## Slice 3 Result

- Schema bumped to **`2`** in [nas/client-hub-api/src/db.js](nas/client-hub-api/src/db.js):
  added `records` (safe published record per project, mirrors the old
  `records/<id>.json`), `private_auth` (mirrors `private/auth/<id>.json`,
  with `email_hash`/`invite_token` columns + indexes replacing the old
  `email-index.json`/`invite-index.json` side files), and `admin_sessions`.
- New modules: `src/crypto.js` (sha256/HMAC/timing-safe-compare helpers),
  `src/signing.js` (HMAC path-signing, self-hosted analogue of Bunny's
  `signPullUrl` — `hmac(SIGNING_SECRET, path+"|"+expires)`, 900s TTL),
  `src/cors.js` (two CORS shapes — `credentialedCors` for admin routes with
  an explicit allowed origin + `Allow-Credentials`, `openCors` with `*` for
  public no-cookie reads), `src/adminAuth.js` (PIN verify, session
  create/check, 5-attempts/15-min rate limiter keyed by IP), `src/hubRoutes.js`
  (all five routes).
- Routes, all matching `client-hub-docs/hub-edge-script.js`'s request/response
  shapes exactly (frontend `hubApi` needs no logic changes, only Slice 5's
  base-URL/credentials rewiring):
  - `POST /hub/admin-auth` (new) — email+PIN → HttpOnly session cookie
    (`hub_admin_session`; no Max-Age, so it's browser-session-lifetime like
    the old `sessionStorage` auth, with a 24h server-side expiry as a
    safety net). Rate-limited.
  - `POST /hub/publish` (admin session required) — upserts `records` +
    `private_auth`.
  - `POST /hub/auth` (public) — email+code or invite → same shape as before;
    `records[projectId]` is now a signed `GET /hub/records/:projectId` URL
    on this server instead of a Bunny pull-zone URL.
  - `GET /hub/records/:projectId` (new, backs the above) — signed, 900s TTL.
  - `POST /hub/sign` (public) — ported for shape-parity; **no current caller**
    in the frontend and no serving route yet. Signs a `/hub/files/<path>`
    URL — Slice 4 must either build that route or supersede this one with
    whatever URL scheme it picks for video specifically.
  - `POST /hub/notify` (admin session required) — same stub behavior
    (console.log + `{ok:true}`), provider TODO unchanged.
- Admin session cookie is `Secure; SameSite=None` — required because the
  client hub's origin and `hub-api.lsccreative.studio` are cross-site.
  `credentialedCors` only reflects an origin present in `CORS_ORIGIN` (env,
  default `https://lsccreative.studio`) — Slice 5's `credentials:'include'`
  fetch will only work from an allowed origin.
- Deployed + verified live over the public tunnel: wrong PIN → 401, correct
  PIN → 200 + `Set-Cookie`, `/hub/publish` 401 without a session / 200 with
  one, `/hub/auth` returns a working signed record URL, invite resolution,
  `/hub/sign` path-traversal rejection, rate limiting (4th+ attempt → 429).
  Full transcript isn't kept here — rerun is cheap via curl if it needs
  re-checking.
- **Secrets are on the NAS only**, in `/volume4/client-hub-api/app/.env`
  (mode 600, never in this repo): `ADMIN_EMAIL`, `ADMIN_PIN_HASH` (sha256 of
  the existing PIN — **unchanged**, so the admin's current PIN still works),
  `SIGNING_SECRET` (fresh random 32 bytes, generated this session, exists
  only on the NAS).
- `nas/client-hub-api/` is still **untracked in git** (was never committed in
  Slices 1-2 either) — nothing to lose by that, but flag to the user before
  the eventual commit that it hasn't been added yet.

## Slice 4 Result

- Schema bumped to **`3`**: new `deliverable_tokens` table (`token` PK,
  `relative_path` UNIQUE, `created_at`). New module
  [nas/client-hub-api/src/deliverables.js](nas/client-hub-api/src/deliverables.js)
  — path-traversal-safe resolution under `DELIVERABLES_DIR`, MIME-by-extension,
  and RFC 7233 Range-request streaming (`bytes=A-B` / `A-` / `-N`, `206` +
  `Content-Range`, `416` for out-of-bounds).
- Two new routes in `hubRoutes.js`:
  - `POST /hub/deliverable-url` (admin session required) — `{ path }` → mints
    (or returns the existing) random 16-byte-hex token for a file already
    sitting under `DELIVERABLES_DIR`, idempotent per path.
  - `GET /hub/files/:token` (public, no auth) — streams the file. The token
    **is** the access control, same trust level as a pasted Bunny Stream URL
    always was — deliberately **not** the short-lived signed pattern Slice 3
    used for `/hub/records` (see `DESIGN_BRIEF.md`'s "Obscurity is not the
    gate, verification is").
- Slice 3's `POST /hub/sign` (ported from the Edge Script, zero frontend
  callers) was **removed** — it predicted a `/hub/files/*` prefix that this
  slice's actual scheme superseded rather than extended.
- **No UI exists yet to call `/hub/deliverable-url`** — Slice 4 is NAS-only
  per the buildplan; generating a URL today is a manual `curl` (documented in
  [client-hub-docs/NAS-DELIVERABLES.md](client-hub-docs/NAS-DELIVERABLES.md)
  with the exact commands). No future slice in the current 12-slice list adds
  a "generate NAS URL" button — flag to the user if they want one added;
  don't add it unasked.
- Verified: local Range-correctness test (byte-exact against a synthetic
  1000-byte file, all three Range forms + out-of-bounds → 416), then a real
  end-to-end pass against the live NAS — dropped a real file in
  `Client Deliverables_Media/Test Folder/`, registered it over the public
  tunnel with the real admin PIN, fetched it full and range-sliced over
  `https://hub-api.lsccreative.studio`, confirmed byte-correctness, then
  deleted both the test file and its `deliverable_tokens` row (NAS is clean,
  no leftover test artifacts).

## Slice 5 Result

- `HUB_CONFIG.edgeBase` (`client-hub-app/index.html:114`) now points at
  `https://hub-api.lsccreative.studio`. `hubFetch` (`:162`) now always sends
  `credentials:'include'` — every `/hub/*` call carries cookies, not just
  admin ones. `opts.admin`'s bearer-header wiring is untouched (Slice 7's
  job); both mechanisms are live side-by-side right now, harmlessly.
- **Real bug found and fixed via actual browser testing, not just code
  review**: making `hubFetch` unconditionally credentialed broke `/hub/auth`
  — the Fetch spec forbids a wildcard `Access-Control-Allow-Origin` on any
  response to a credentialed request, even one that doesn't read a cookie.
  `/hub/auth` was still on `openCors` (Slice 3's assumption: it's a public
  route, no session involved) — flipped it to `credentialedCors` in
  `nas/client-hub-api/src/hubRoutes.js`. **Rule of thumb for future slices**:
  every route reached via `hubFetch` needs `credentialedCors` now, full stop
  — it's not about whether that route itself checks a cookie, it's about
  what the browser requires on ANY credentialed response. `GET /hub/records`
  and `GET /hub/files` stay `openCors` because `fetchRecord`/the video `<video
  src>` fetch them with plain `fetch(url)`/browser-native loading, no
  `hubFetch`, no credentials.
- Verified in-browser end to end: served `client-hub-app/index.html` locally
  (`.claude/launch.json` → `lsc-static`, port 8734), drove the real client
  login UI (email + 4-digit code), confirmed the request reached the live
  NAS with no CORS error and rendered "That email and code didn't match" —
  the correct authenticated response shape (no test project exists to
  match), not the earlier "Sign-in failed (network)" failure state. Also
  confirmed directly via `javascript_tool` fetch from the page: `200 {token:
  null, projectIds: []}`.
- Testing needed the local dev origin (`http://localhost:8734`) temporarily
  allowed in NAS `CORS_ORIGIN` — added it **on the NAS only** (SSH-edited
  `docker-compose.yml` directly, never touched the repo copy), rebuilt,
  tested, then redeployed the clean repo version to revert. Confirmed after
  revert: `OPTIONS /hub/auth` from `localhost:8734` origin no longer gets an
  `Access-Control-Allow-Origin` header back. **If a future slice needs
  local-origin testing again, repeat this SSH-only pattern — don't commit a
  dev origin into `docker-compose.yml`.**
- `nas/client-hub-api/` schema is still `3` — Slice 5 was WEB-only, no DB
  changes.

## Slice 6 Result

- `client-hub-app/index.html`: `pressKey` is now `async`, POSTs
  `{ email, pin }` to `/hub/admin-auth` via `hubFetch` on the 4th digit.
  New state fields `pinChecking` (disables email input + keypad while the
  request is in flight) and `adminLoginMsg` (the network-error line).
  Three distinct outcomes, not two: success → session set, into tracker;
  `e.status === 401` → existing red `.pin-dot.error` shake (unchanged
  behavior/timing); anything else (thrown `TypeError: Failed to fetch`,
  no `.status`) → dots reset with **no** shake, keypad re-enables, shows
  "Can't reach the server — check your connection." per `DESIGN_BRIEF.md`'s
  exact wording.
- Deleted `ADMIN_EMAIL`/`PIN` constants entirely (were at
  `client-hub-app/index.html:136-137`) — grepped the whole file afterward to
  confirm no other reference survived.
- **Verified live in-browser**, both failure paths, using the existing
  Slice-5 CORS pattern (SSH-edit NAS `docker-compose.yml`, `docker compose up
  -d --build`, test, revert):
  - 401 path: temporarily allowed `http://localhost:8734` in `CORS_ORIGIN`,
    served the app locally on port 8734, entered the real admin email with a
    wrong PIN → confirmed 401 response + red shake + dots reset, no message.
  - Network-error path: reverted `CORS_ORIGIN` back to
    `https://lsccreative.studio` (the production value) *while still testing
    from localhost* — the resulting CORS-blocked fetch throws exactly the
    "no response at all" `TypeError` the brief describes, so this doubled as
    both the network-error test AND the final revert in one rebuild. Confirmed
    the muted message appeared and the keypad accepted new input immediately
    after (no lingering disabled state).
  - Did **not** test the success path — that needs the real admin PIN, which
    only exists as a hash in the NAS's `.env` and isn't something to type into
    a scratchpad or transcript. 401 and network-error coverage plus a code
    read of the success branch (`sessionStorage.setItem` → `authed=true` →
    `screen='tracker'`, mirrors the pre-Slice-6 success path exactly) is
    the verification bar met here — flag to the user if they want the live
    success path confirmed by hand.
  - Confirmed NAS `docker-compose.yml` is byte-identical to the repo copy
    after the revert (`diff` clean) — no drift left behind.
- `nas/client-hub-api/` untouched this slice (WEB-only, per buildplan).

## State & Blockers

- **Fixed in Slice 6**: admin PIN/email are no longer hardcoded client-side —
  the constants are deleted and `/hub/admin-auth` is the real gate now. The
  session cookie mechanism from Slice 3/5 is finally exercised in practice,
  not just reachable in theory.
- **As of Slice 5, `client-hub-app/index.html` no longer calls the Bunny Edge
  Script at all** (`edgeBase` now points at the NAS) — confirmed nothing else
  in the file reads `HUB_CONFIG.pullZone`/`storageZone`/`s3Endpoint`/
  `storageHost`/`streamLibraryId` either, they're just inert now (Slice 12
  removes the dead fields). What's still genuinely "live Bunny" is data, not
  code: any already-published project record whose reviewLink/downloadLink
  is an old Bunny Stream URL keeps working until someone re-publishes it
  with a NAS URL (Slice 4's scheme) — that's a per-project migration, out of
  scope per the brief, not something to batch-fix.
- **Repo is mirrored to the public site by Bunny CI/CD.** `nas/client-hub-api/`
  is now public (source only, consistent with `nas/media-server/`). No
  secret lives in the repo copy — verified `docker-compose.yml` only holds
  non-secret config (`PUBLIC_BASE_URL`, `CORS_ORIGIN`) plus `env_file: - .env`,
  and `.env*` is gitignored repo-wide.
- `.design/` is currently **untracked**. It's internal planning content, like
  the gitignored `client-hub-docs/`, and would become publicly reachable if
  committed. Decide with the user before adding it.

## Next Agent Handoff

1. Slice 7 is `client-hub-app/index.html` only — no NAS access needed. Remove
   `renderAdminKeyBar`, the `ADMIN_KEY_SS` sessionStorage key + `adminKey()`
   helper, and `hubFetch`'s `opts.admin` bearer-header branch (`if(opts.admin)
   headers['Authorization'] = ...`). Also drop the `admin:true` option from
   every `hubFetch`/`hubApi` call site that still passes it (at least
   `hubApi.publish`'s `/hub/publish` call — grep for `admin:true` and
   `renderAdminKeyBar` to find all of them). The `hub_admin_session` HttpOnly
   cookie from Slice 6 is what actually gates `/hub/publish`/`/hub/notify`
   server-side now (`requireAdmin` in `nas/client-hub-api/src/adminAuth.js`)
   — the bearer header has done nothing real since Slice 6 landed.
2. Watch for the amber admin-key re-entry bar's other callers — line ~638
   conditionally renders `renderAdminKeyBar()` when `HUB_CONFIG.mode ===
   'live' && !adminKey()`; that gate goes too. And `reportAdminError`
   (`client-hub-app/index.html:180`) special-cases `e.status === 401` by
   clearing `ADMIN_KEY_SS` and telling the admin to "re-enter it in the bar
   above" — that message is now wrong (there's no bar), decide what a 401 on
   `/hub/publish`/`/hub/notify` should say once there's no bearer key to blame
   (likely: the session expired, send them back to the PIN screen).
3. Test in the browser before calling it done (per this repo's CLAUDE.md
   rule) — specifically exercise Publish after Slice 7's changes, logged in
   via the real Slice 6 PIN flow, to confirm `/hub/publish` still succeeds
   with only the session cookie and no bearer header. Same local-CORS-origin
   dance as Slice 6 (SSH-edit NAS `docker-compose.yml`, redeploy, test,
   revert to the production value) if testing off a local static server.
4. Before relying on the tunnel in later slices, verify
   `https://hub-api.lsccreative.studio/health` from **off** the home LAN on
   an actual cellular connection (only verified from a network path that may
   still be LAN-adjacent so far) — this is formally Slice 11's job but is
   cheap to spot-check earlier if convenient.
6. Redeploy after editing `nas/client-hub-api/`:
   `COPYFILE_DISABLE=1 tar czf - --exclude node_modules --exclude data . | ssh lsc-nas 'tar xzf - -C /volume4/client-hub-api/app'`
   then `ssh lsc-nas 'cd /volume4/client-hub-api/app && docker compose up -d --build'`.
   **`scp`/`sftp` don't work on this NAS — always pipe through `ssh … 'cat > …'`
   or `tar` for any new file, including a future `.env` edit.**
