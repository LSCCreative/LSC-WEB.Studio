# Deployment runbook

Read this only when deploying or redoing infrastructure. Logins and keys: `.credentials.local.md`
(gitignored; the repo is public). The long original with the 2026-09-22 incident write-up is in
`Project build archive/tracks/nas-hosted-billing/DEPLOYMENT_full.md`.

## What is live (since the M6 cutover, 2026-11-07; the merged admin and new portal since C9, 2026-11-26; schema v33 and Bunny video since B2, 2026-11-27)

The NAS is at **192.168.1.46** on the LAN since 2026-11-26 (it was .45; same host keys). Until the router reserves it and
`~/.ssh/config` says so: `ssh -o HostName=192.168.1.46 -o HostKeyAlias=192.168.1.45 lsc-nas`. A rebuild takes ~10 minutes
(npm on the NAS); the old container serves until the new one starts.

| Part | Where |
|---|---|
| Admin + API + portal API | One container, `lsc-admin` (image `lsc-admin:latest`), on the NAS at `/volume4/lsc-admin/app` (`server/` + `web/` + the NAS's own `docker-compose.yml` and `.env`), data `/volume4/lsc-admin/data`, bound to `127.0.0.1:8098`, on network `media_net`. The deliverables share is mounted read-only at `/srv/deliverables`. The server serves `web/` itself (`server/src/web.js`). |
| Tunnel | Cloudflare Tunnel `deck-productions-nas` (container `cloudflared-tunnel`, token mode): `app`, `billing` and `hub-api.lsccreative.studio` all → `http://lsc-admin:8080`. Routes are edited in the dashboard under Networking → Tunnels → Routes. `app` is a tunnel route (proxied CNAME), no longer GitHub Pages. |
| Hostnames | `app`: the admin and client pages (`/c/`). `billing`: the same server, kept for old links. `hub-api`: the portal's `/hub/*` and `/health` only (`/api` answers 404 there). |
| Retired, kept for rollback | `lsc-billing` (`/volume4/lsc-billing`) and `client-hub-api` (`/volume4/client-hub-api`), stopped, data untouched (billing.db v20); `client-hub-api` set to `--restart=no`. The billing repo's Pages workflow is disabled; its last published site is the rollback target. Rollback steps: the merge plan's `CUTOVER.md`. |

## Deploying

Ask the user first. `git fetch` and diff `origin/main` before any copy or push. Pushing `main` here
deploys the marketing site (its allow-list), never the admin. A failed Pages run is retried with a
fresh run (`gh workflow run deploy-pages.yml --ref main`), not "Re-run": a re-run uploads a second
artifact into the same run and deploy refuses two.

**NAS (the admin):**
1. Back up the live DB: `sqlite3 -readonly /volume4/lsc-admin/data/billing.db ".backup <dest>"`.
2. `git archive` the commit's `admin/` (`docker-compose.yml .dockerignore server web`), send it through
   `ssh lsc-nas` (`cat` over ssh; scp and rsync are refused), checksum both ends, unpack into a fresh
   `/volume4/lsc-admin/app.new`, rename its `docker-compose.yml` to `docker-compose.repo.yml`, copy the
   NAS's `docker-compose.yml` and `.env` in, then swap the folders. Never unpack over the live folder.
3. `cd /volume4/lsc-admin/app && docker compose up -d --build`. **Not `restart`**: restart keeps the old
   env, so an edited `.env` is silently ignored.
4. `sh /volume4/lsc-admin/m6-checks.sh /volume4/lsc-admin/data` must print ALL PASS; check the boot log's
   migration line. An open admin tab offers a reload when the version changes.
5. If a migration ships, run it on a copy of the backup first.
   **v33 (Bunny Slice 2) refuses to run if `bunny_assets` or `bunny_collections` holds a row**, and a server
   that won't migrate crash-loops under `restart: always`. Before that deploy, on the live db:
   `sqlite3 -readonly …/billing.db "SELECT COUNT(*) FROM bunny_assets; SELECT COUNT(*) FROM bunny_collections;"`
   must print `0` twice (it did on 2026-11-26). Not zero: stop and ask; don't deploy.

## NAS `.env` (`/volume4/lsc-admin/app/.env`, mode 600; names in `server/.env.example`)

```
SESSION_SECRET=  ADMIN_USERNAME=  COOKIE_SECURE=1   # cookie SameSite defaults to lax (one origin)
APP_URL=https://app.lsccreative.studio/
MAIL_FROM=admin@lsccreative.studio     # + SMTP_HOST/PORT/USER/PASS (Resend key "LSC Billing App (NAS)"), MAIL_REPLY_TO
GOOGLE_MAPS_SERVER_KEY=               # "LSC Billing — server" key, Maps Static only
LSC_MAPS_KEY=  LSC_MAPS_ID=           # "LSC Billing — browser" key + Map ID, written into config.js
GOOGLE_OAUTH_CLIENT_ID=               # client "LSC Billing — NAS calendar"
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://app.lsccreative.studio/api/google/oauth/callback
ZAPIER_CREDENTIALS_CLIENT_ID=         # Hnry: 1Password Environment "ZAPIER_CREDENTIALS"
ZAPIER_CREDENTIALS_CLIENT_SECRET=
HUB_SIGNING_SECRET=
HUB_CORS_ORIGINS=https://lsccreative.studio
CORS_ORIGINS=https://app.lsccreative.studio   # only until 2026-11-14 (the switch from Pages), then remove
```

`DATA_DIR`, `PORT`, `DELIVERABLES_DIR` and `IMPORT_PROBE_HOSTS` are set in the compose file. `APP_ORIGIN`
stays unset. **Never set `GOOGLE_CALENDAR_WRITE=0` on the NAS**: that is the dev-server switch and would
stop live bookings writing to Google. A missing Google or mail value only disables that one feature.

## Hnry through Zapier (hnry-invoicing)

- **The credential:** a Zapier SDK credential (Zapier → Connections → SDK credentials; its secret is
  shown once), kept in the 1Password Environment **ZAPIER_CREDENTIALS** as
  `ZAPIER_CREDENTIALS_CLIENT_ID` and `_SECRET`. The Hnry connection itself is made once in Zapier.
- **NAS:** the user types both into the NAS `server/.env` (never through chat or a tracked file), then
  `docker compose up -d --build` (not `restart`). Empty = Hnry "not set up": nothing is pushed and the
  app sends invoices itself as before.
- **Check:** Settings → Hnry says **Connected** (`GET /api/hnry/check`: a Zapier sign-in and connection
  lookup, nothing read or made in Hnry). "Not connected" quotes Zapier's reason; a 401 on the
  credentials exchange is a wrong ID/secret pair.
- **Order:** schema v20 and the `/api/hnry/*` routes ship on the NAS **before** Pages, with the
  credential already in `.env`. After deploy accept nothing real; the user does one real project when
  ready (H12). A live push makes real Hnry drafts: test only with the user's own client record.
- **Local:** launch config `api-scratch-hnry-live` (the `/tmp/lsc-billing-hnry` scratch DB) reads the
  Environment mounted at `~/.config/lsc-billing/hnry.env` with the 1Password MCP `create_local_env_file`.
  It must sit outside the Drive folder, and only `grep` gets its contents (sh and awk read nothing), so
  the config loads it through `grep`. `api-scratch-hnry` is the pretend Hnry, no credential.

## Pages secrets (Settings → Secrets and variables → Actions)

`LSC_API_BASE` = `https://billing.lsccreative.studio` (no trailing slash), `LSC_MAPS_KEY` = the
**LSC Billing — browser** key, `LSC_MAPS_ID` = Map ID **LSC Billing — trip planner**. Without the Maps
ones the travel view says Maps isn't set up; the build still deploys.

## Google Cloud (project "LSC Production Decks"), checked 2026-10-13

- Browser key website restrictions: `https://app.lsccreative.studio/*`,
  `https://lsccreative.github.io/*`, `http://localhost:5173/*` (the console refuses a wildcard
  port; a preview on another port needs a row). 4 APIs.
- Server key: Maps Static API only.
- OAuth client "LSC Billing — NAS calendar": redirect URIs `https://billing.lsccreative.studio/api/
  google/oauth/callback` and `http://localhost:8080/api/google/oauth/callback`; no JS origins. The
  consent screen is Internal (Workspace only): no verification, no 7-day token expiry.
- A $1 budget alert on the billing account is still the user's to set.

## After a trip-planner/Google deploy (user, in this order)

Settings → Google Calendar → Connect → switch on calendars → **Sync existing bookings** once → check
a trip routes (browser key + Map ID) and a call sheet shows its route map (server key).

## Local verification after any change

Sign in (proves the cookie round-trips cross-origin), create/edit/reload an estimate (proves the save
reaches SQLite), and `LSCCalc.computeTotals.length === 4` in devtools (the page isn't running a stale
cached `calc.js`).
