# Bunny Infrastructure — AS BUILT
_Configured and verified 2026-07-21. This is the working state, not a to-do list._
_Read this only if you're touching infrastructure. For app work, `START-HERE.md` + `Handoff.md` is enough._

## Live configuration

| Component | Setting |
|---|---|
| Storage zone | `clienthubdata` (Frankfurt, `https://storage.bunnycdn.com/clienthubdata/`) |
| Pull zone | `Client-Hub-PULLZONE.b-cdn.net` (ID `6182913`), origin = the storage zone |
| Edge Script | `client-hub-api` — Bunny script **#82483**, type **Middleware**, connected to the pull zone |
| Token Authentication | **ON**. Token IP validation **OFF** (signing isn't IP-bound; mobile IPs change) |
| Edge Rule | `HubApiBypassTokenAuth` — *Disable Token Authentication* where Request URL matches `*/hub/*` |
| Stream library | `683470` ("Client Deliverables") |

### Secrets (Environment → **Secrets**, Variables tab is empty)
`ADMIN_API_KEY` · `STORAGE_WRITE_KEY` · `STORAGE_READ_KEY` · `PULLZONE_TOKEN_KEY` · `STREAM_TOKEN_KEY`

- Read in code via **`process.env.X`** (with `import process from "node:process"`) — *not* `Bunny.env`.
- Use **Secrets**, not Variables: Variables display their value in plaintext in the dashboard, and a
  Variable and a Secret **cannot share a name** (Bunny rejects it).
- `STREAM_TOKEN_KEY` is set but **not read by current code** — reserved for future Stream previews.
- Values live only here and in `Bunny.Net Storage zone & Pull Zone Details.rtf` (gitignored, never commit).

## Storage layout
```
records/<projectId>.json        public via pull zone, token-gated  (safe subset — no codes/emails)
private/auth/<projectId>.json   BLOCKED (403)                      (SHA-256 codeHash)
private/email-index.json        BLOCKED — emailHash → [projectId]  (lets /hub/auth find candidates)
private/invite-index.json       BLOCKED — inviteToken → projectId
invoices/ · media/              token-gated
```

## The four runtime gotchas (already solved — do not rediscover)
1. **Middleware, not standalone.** The script is `servePullZone().onOriginRequest()`. Returning a
   Response short-circuits and serves it; returning nothing falls through to origin. The archived
   `Reference Template (Bunny.net Standalone Edge Script).js` shows the **wrong** `serve()` model.
2. **`process.env.*`, not `Bunny.env.*`** for both Variables and Secrets.
3. **Import URL** must be `https://esm.sh/@bunny.net/edgescript-sdk@0.11.2`.
4. **`onOriginRequest` only fires on a cache miss** — so every API response sets
   `Cache-Control: no-store`, or a cached reply would shadow the script.

## Two design decisions that look wrong but aren't
- **`/hub/*` is exempt from token auth.** Enabling Token Authentication gates the *entire hostname*,
  including the login endpoint — a client can't call `/hub/auth` to *get* a token if it already needs
  one. Security lives inside the script instead: `/hub/publish` and `/hub/notify` require the admin
  bearer, `/hub/auth` requires a correct email + 4-digit code, `/private/*` is hard-blocked in code.
  Reads (`records/`, `invoices/`, `media/`) stay fully token-gated. **Deleting this rule breaks login.**
- **CORS is handled in code**, via `onOriginResponse` setting `Access-Control-Allow-Origin`. Storage
  responses carry no CORS header, so the client's cross-origin fetch of a signed `records/*.json`
  would otherwise be blocked. No separate Edge Rule to maintain. Currently `*` — tighten later.

## Deploying a change to the Edge Script
1. Edit `Client HUB/hub-edge-script.js` (the source of truth).
2. Bunny → Compute → Edge Scripting → `client-hub-api` → **Code**, paste the whole file.
3. **Save**, then **Publish** (Publish creates the release; Save alone does nothing at the edge).
4. Smoke-test — these need no secrets and confirm routing is live:
   ```bash
   curl -s -X POST https://client-hub-pullzone.b-cdn.net/hub/auth \
     -H "Content-Type: application/json" -d '{"email":"","code":""}'      # → 400 bad request
   curl -s -o /dev/null -w "%{http_code}\n" \
     https://client-hub-pullzone.b-cdn.net/private/auth/x.json             # → 403
   ```
   A `404`/HTML means the code isn't deployed. Bunny's **HTML** 403 page (vs the script's JSON)
   means token auth is rejecting the request before the script runs — check the bypass Edge Rule.

## Troubleshooting map
| Symptom | Cause |
|---|---|
| Bunny HTML `403` on `/hub/*` | Bypass Edge Rule missing/broken — token auth is eating the API |
| `/hub/publish → 401` in browser console | Pasted `ADMIN_API_KEY` ≠ the Secret. The UI now says so and re-shows the amber bar |
| `500 storage GET … → 401` | `STORAGE_READ_KEY` wrong (a *correct* key returns 404 for a missing file) |
| `500 storage PUT … → 401` | `STORAGE_WRITE_KEY` wrong, or the read-only password was used |
| Client signs in, record won't load | CORS, or the signed-URL token format — see `signPullUrl()` |
| POSTs suddenly 405 | Someone enabled **Block POST requests** under Security → General. Leave it off |
