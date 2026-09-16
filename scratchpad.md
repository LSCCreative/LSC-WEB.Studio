# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

Slices 1-11 done. Next up is **Slice 12 [WEB + NAS]** — end-to-end
verification (admin login from off-LAN, real NAS video watch/download, forced
video-load-failure → Drive fallback check). Note: buildplan.md was
renumbered since Slice 7 was written (a Slice 10 for PIN/code text-input
replacement was inserted ahead of the old responsive/polish slices) — always
re-read buildplan.md fresh rather than trusting slice numbers cached in this
file.

## Slice 11 Result

- Pure verification slice, **no code changes** — audited the Slice 10 UI
  (both login screens), the Slice 9 Drive-fallback card, and the Slice 9
  `driveLink` editor field, all still uncommitted from Slice 10 in the
  working tree.
- **Mobile (375×812, resize_window mobile preset)**: both login screens,
  the video-fallback card, and the editor's "Google Drive Backup Link" field
  all render full-width with no overflow — confirmed via screenshot. No new
  CSS was needed; the only `@media` block in the file is still the
  `(min-width: 993px)` desktop-only `.back-link` pin added earlier — nothing
  in this file uses `(max-width: 768px)` and nothing needed adding, since
  every element audited here is already `width:100%`/flex-stacked by
  default (mobile-first).
- **Keyboard operability**: tabbed through both login screens via real
  `key:"Tab"` events + `document.activeElement` checks (not just visual) —
  order is back-link → email → PIN/code input → (client: forgot-code →
  Admin link). All reachable, all natively focusable (no custom
  keydown-routing left over from the old keypad).
- **Focus visibility**: links/buttons keep the browser's default focus
  ring (confirmed visible amber outline via screenshot on both
  "← BACK TO SITE" and the Drive-fallback "VIEW ON GOOGLE DRIVE" link — the
  latter was this slice's specific ask). The `.field:focus` rule
  (`outline:none` + `border-color:var(--lsc-sage)`) is a color-only
  indicator — high contrast against the black `.field` background (~10:1)
  but only a 1px border, so it's easy to miss at a glance. Not changed
  (in-scope work was auditing, not redesigning existing tokens) but flag to
  the user if they want a stronger focus ring (e.g. add a `box-shadow`) on
  `.field:focus` — would apply everywhere `.field` is used, not just these
  screens.
- **State-change verification**: confirmed via injected-mock `hubFetch`
  (same technique as Slices 6/9/10 — no live NAS needed) that wrong-PIN
  submission actually applies `.invalid`+`.shake` classes to `#pin-input`
  (`el.className` checked directly, since the 500ms-then-clear cycle is too
  fast to reliably catch in a screenshot given tool round-trip latency).
  Checking/error/network-error messages are all plain visible text (no
  `aria-live` regions anywhere in the file, for any state message in the
  app — not just these screens). Screen-reader users get no automatic
  announcement of a state change unless they're already focused on the
  element; a sighted user gets the message immediately. This is a
  pre-existing app-wide pattern (not introduced by Slice 9/10), and adding
  `aria-live` was not requested — flagging as a possible follow-up, not
  something fixed in this slice.
- **No regressions**: reloaded the file fresh at default desktop width
  after all the mobile/console testing — `.back-link` still pinned
  top-left, both login screens render identically to before this slice.
- **buildplan.md**: Slice 11 checked off `[x]`.

## Slice 10 Result

- `client-hub-app/index.html`: both the admin PIN screen (`renderLock`) and
  client login screen (`renderClientLogin`) now use a real `<input>`
  instead of the 12-button circular keypad + dot indicators.
  - Admin: `<input id="pin-input" type="password" inputmode="numeric"
    pattern="[0-9]*" maxlength="4" autocomplete="current-password">` —
    masked so a password manager offers to fill/paste a saved PIN.
  - Client: `<input id="client-code-input" type="tel" inputmode="numeric"
    pattern="[0-9]*" maxlength="4">` — unmasked, it's a code not a secret.
  - Both: on `input`, strip non-digits + cap at 4 chars, write into
    `state.pinInput`/`state.clientCodeInput` **without** calling `render()`
    (mirrors the existing email-field pattern — avoids the
    `render()`-wipes-focus bug). At length 4, auto-submit
    (`submitPin()`/`submitClientLogin()`). Also submit on `Enter` keydown
    when already at 4 digits, for autofill flows that set `.value` without
    reliably firing `input`.
  - Checking: `disabled` on the input (was: disabled keypad). Wrong-PIN/401:
    `.invalid`+`.shake` added directly to the input (was: `#pin-dots`/
    `#client-code-dots` element), cleared+refocused after the existing
    500ms timeout. Network error: unchanged muted message line, input
    re-enabled and cleared, no shake.
  - `pressKey`/`pressClientKey` (keypad button handlers) renamed/replaced by
    `submitPin`/existing `submitClientLogin` called directly from the input
    listener — no more per-digit dispatch functions needed.
  - Deleted: `.pin-dot`/`.pin-key` CSS (kept `.shake`, still used),
    `#pin-dots`/`#client-code-dots` markup, all `data-key`/`data-ckey`
    buttons, and the `lockKeyHandler`/`clientLoginKeyHandler` document-level
    keydown listeners (now redundant — real `<input>`s are natively
    focusable/typable). Grepped afterward for `pin-dot`, `pin-key`,
    `data-key`, `data-ckey`, `pressKey`, `pressClientKey`,
    `lockKeyHandler`, `clientLoginKeyHandler` — all clean.
  - No `@media` block existed in this file before or after this slice — the
    old fixed 64px circular keys were the only thing needing mobile-specific
    rules, and a `.field`-styled text input is already responsive via the
    existing `width:100%` rule, so nothing was added (confirmed by
    screenshotting both screens at 375px).
- **Verified in-browser** (local `python3 -m http.server`, real DOM
  interaction + `javascript_tool` for scripted event dispatch since the NAS
  isn't reachable from this dev origin — same CORS situation as prior
  slices):
  - Typing strips non-digits and caps at 4 (`"12ab34"` → `"12"` once
    `maxlength` truncates the raw keystroke count; a scripted paste of
    `"1a2b3c4d"` correctly yields `"1234"`).
  - A 4-digit paste-style `input` event auto-triggers submission
    (`pinChecking`/`clientCodeInput` confirmed transitioning correctly).
  - Network-error path (cross-origin fetch blocked from localhost, same as
    Slices 5/6/7's testing pattern): both screens show the correct muted
    message, input re-enables and clears.
  - Wrong-PIN/401 path (admin only — mocked `hubFetch` to throw a
    `{status:401}` error since the real PIN isn't available here): `.invalid`
    + `.shake` applied to `#pin-input`, then cleared + refocused after
    500ms — confirmed via `document.activeElement`.
  - Admin↔client `data-admin-link`/`?admin=1` navigation still works
    (Slice 8, untouched by this slice) — spot-checked via click.
  - Both screens screenshotted at 375×812 (mobile preset) — full-width
    inputs, no overflow, layout clean. Did **not** test an actual OS
    password-manager autofill popup (Chrome DevTools/automated browser
    doesn't have one wired up) — the `autocomplete="current-password"`
    attribute is the standard hook for that and was verified present, but
    the literal "does Chrome/1Password's fill UI appear" behavior is
    unverified. Flag to the user if they want that spot-checked by hand in
    a real browser profile with a saved credential.
  - Did not re-test the *success* path (same limitation as Slice 6 — needs
    the real admin PIN, which isn't available in this session) or the
    client-side wrong-code path specifically (client login has no
    dedicated 401 status the same way — `submitClientLogin`'s
    `failClientLogin` branch is exercised by the network-error test above,
    same code path as a "no match" response).

## Slice 9 Result

- **Scope gap found and resolved with the user**: the buildplan assumed a
  real `<video>` element already existed with an `onerror` handler to hook
  into. It didn't — `renderVideoCanvas` (`client-hub-app/index.html`) was a
  fully static SIMULATE-era mockup (fake ▶/⏸ buttons, a decorative `#scrub`
  bar, no `<video>` tag anywhere in the file, `a.reviewLink` never read).
  Flagged this via AskUserQuestion; user chose "wire up a real `<video>`
  element first" and supplied a real NAS test file
  (`Sample Media/Test Media.mp4`) + its Google Drive mirror for testing.
  This made Slice 9 bigger than its "Medium" label — it now includes a real
  player, not just a fallback card.
- `a.driveLink` was **already** a field on every asset (editor input at
  `:774`, persisted through `buildPublishedRecord` at `:193`) from earlier
  work — nothing to add there. Only the "swap to fallback on video error"
  half was actually new.
- `renderVideoCanvas` (`client-hub-app/index.html:985`) now renders a real
  `<video id="asset-video" controls preload="metadata" src="${a.reviewLink}">`
  in the success case, or (when `state.videoFailed`) a `.card` with "This
  video couldn't be loaded." + a `.btn-sage` "VIEW ON GOOGLE DRIVE" link —
  **only** rendered when `a.driveLink && isValidUrl(a.driveLink)`, confirmed
  hidden otherwise.
- Deleted the fake `#video-play`/`#video-pause`/`#scrub` markup and bindings
  entirely (grepped afterward, clean).
- **Real bug caught before it shipped**: my first pass wired `video.onpause`
  to call `setState(...)` to update the pause-timestamp pill. `setState`
  does a full `root.innerHTML` replace, which would have destroyed and
  recreated the `<video>` element on every pause — resetting playback to 0
  every time (same class of bug flagged for Slice 10's text-input gotcha,
  just discovered here instead via manual testing rather than reading it in
  the buildplan first). Fixed by mutating `state.pausedAt` directly and
  updating a stable `#pause-pill` element's `textContent`/`display` in
  place, no `render()` call — mirrors the existing `input`-without-`render()`
  pattern already used for the email fields. The revision-comment
  timestamp feature (attaches `state.pausedAt` to a submitted revision) is
  unchanged and still reads the same state field.
- **Verified in-browser** (console-injected a synthetic project/asset into
  `state`, bypassing login — no live admin PIN needed for this UI-only
  check): real playback of a public test MP4 with working native controls;
  paused mid-playback → confirmed `state.pausedAt` set correctly (`"00:04"`)
  AND the `<video>` element/its `currentTime` survived (not remounted) —
  proves the setState fix actually works; swapped in a broken URL →
  fallback card + working "VIEW ON GOOGLE DRIVE" link (href matched exactly,
  opens the real Drive URL the user gave); cleared `driveLink` → confirmed
  the button disappears, just the "couldn't be loaded" text remains. No
  unexpected console errors (the one error logged was the intentional bad
  test URL).
- **Not yet done**: an end-to-end test against the actual NAS-hosted file
  (`Sample Media/Test Media.mp4` → registered via `/hub/deliverable-url` →
  real `hub-api.lsccreative.studio/hub/files/<token>` URL). Needs the real
  admin PIN to register the deliverable, which wasn't available this
  session — asked the user to run the two curl commands from
  `client-hub-docs/NAS-DELIVERABLES.md` themselves and hadn't gotten a
  response by session end. The public-test-MP4 verification above proves
  the player/fallback mechanism works; only the specific NAS URL + Range
  streaming behavior is unconfirmed for this slice (Slice 12 covers NAS
  video delivery end-to-end anyway, so this isn't blocking).

## Slice 8 Result

- `client-hub-app/index.html`: added `<button id="client-admin-link">Admin</button>`
  to `renderClientLogin`'s footer (right after the existing SIMULATE MODE
  caption, `:501`), styled the same mono/opacity-50 way but smaller
  (`text-[10px]`) and with a hover-to-full-opacity transition so it reads as
  secondary. Click handler in `bindClientLogin` just does
  `state.entry = 'admin'; render();` — the exact same state transition the
  `?admin=1` guard already sets on load, no URL navigation or history entry
  added.
- `?admin=1` deep link path is untouched (guard() logic wasn't touched at
  all) — verified separately, still lands on the PIN screen.
- **Verified in-browser**: served the app on a scratch port (8734 was held
  by another session), loaded the client login screen, found and clicked
  the new "Admin" link → confirmed it landed on the real PIN screen
  ("CLIENT HUB · ADMIN ACCESS" / "Enter PIN"). Separately loaded
  `?admin=1` directly → same PIN screen. No console errors either way.

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

## Slice 7 Result

- `client-hub-app/index.html`: removed `ADMIN_KEY_SS`/`adminKey()`,
  `renderAdminKeyBar()`, its `HUB_CONFIG.mode === 'live' && !adminKey()`
  render gate, its `#admin-key-save`/`#admin-key-input` click handler, and
  `hubFetch`'s `opts.admin` bearer-header branch. Dropped the `admin:true`
  option from `hubApi.publish`'s `/hub/publish` call (its only call site) —
  grepped afterward for `renderAdminKeyBar`/`ADMIN_KEY_SS`/`adminKey(`/
  `admin-key-input`/`admin-key-save`/`admin:true`, all clean.
- Updated `reportAdminError`'s 401 branch (previously: clear the bearer key,
  tell the admin to re-enter it "in the bar above"): now clears the
  session-derived `AUTH_KEY` sessionStorage flag and sends the admin back to
  the login screen (`setState({ authed:false, pinInput:'', screen:'tracker' })`,
  matching the existing logout button's exact reset shape) with the message
  "Admin session expired — please sign in again." This only fires for
  `/hub/publish`/`/hub/notify`/invite/reset 401s — `pressKey`'s own
  admin-auth 401 handling (wrong PIN → shake) is separate code, untouched.
- **Verified in-browser**: served the app locally (plain `python3 -m http.server`
  on a scratch port — port 8734 from `.claude/launch.json` was held by another
  session), loaded both the client login screen and `?admin=1` PIN screen with
  zero console errors, clicked a PIN digit to confirm the keypad still
  responds. Did **not** re-verify a full live Publish round-trip against the
  NAS with the real PIN (would need the Slice 5/6 SSH-CORS-origin dance) —
  the change is a pure removal of now-dead code paths (`opts.admin` was never
  read by the server after Slice 6; the session cookie was already sole
  gatekeeper), so this is lower-risk than Slices 5/6's live-auth changes.
  Flag to the user if they want the live Publish path re-confirmed by hand.

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

1. Slice 8 is `client-hub-app/index.html` only — no NAS access needed. Add a
   small low-emphasis "Admin" text link at the bottom of the client login
   screen (`renderClientLogin` — grep for the existing "SIMULATE MODE" footer
   caption near `client-hub-app/index.html:428` for the styling to match),
   navigating to the admin PIN screen (same transition `?admin=1` already
   triggers — check how that query param is read on load and reuse/trigger
   the same state change on click rather than a real navigation). `?admin=1`
   itself must keep working unchanged as a direct deep link.
2. Recommend a live Publish re-verification is still owed from Slice 7 (not
   blocking, just not yet done): logged in via the real PIN, confirm
   `/hub/publish` succeeds with only the session cookie now that the
   `admin:true` bearer option is gone. Same local-CORS-origin dance as
   Slices 5/6 (SSH-edit NAS `docker-compose.yml` to allow the local dev
   origin, redeploy, test, revert to the production value) if testing off a
   local static server.
3. Before relying on the tunnel in later slices, verify
   `https://hub-api.lsccreative.studio/health` from **off** the home LAN on
   an actual cellular connection (only verified from a network path that may
   still be LAN-adjacent so far) — this is formally the end-to-end
   verification slice's job (currently Slice 12, per the latest buildplan.md
   renumbering) but is cheap to spot-check earlier if convenient.
4. Redeploy after editing `nas/client-hub-api/`:
   `COPYFILE_DISABLE=1 tar czf - --exclude node_modules --exclude data . | ssh lsc-nas 'tar xzf - -C /volume4/client-hub-api/app'`
   then `ssh lsc-nas 'cd /volume4/client-hub-api/app && docker compose up -d --build'`.
   **`scp`/`sftp` don't work on this NAS — always pipe through `ssh … 'cat > …'`
   or `tar` for any new file, including a future `.env` edit.**
