# Client Hub — Build Plan (Additive Feature Sprint)

_Authored 2026-07-20. Canonical copy lives at `Client HUB /BUILD-PLAN.md`. Claude Code: read this **after** the four mandatory docs (`CLAUDE.md`, `Handoff.md`, `blueprint.md`, `INFRASTRUCTURE_REF.md`) and before writing any code._

This sprint adds four feature sets to the working `client-hub/index.html` prototype **and** upgrades it from localStorage-simulate to **real cross-device persistence on Bunny.net**. It is strictly additive: do not rewrite or delete existing core flows, layouts, or routing.

---

## 0. Guardrails (non-negotiable)

1. **Isolation.** All new code lives inside `client-hub/`. Only **two** host-site edits to root `index.html` are permitted: (a) add the `[CLIENT HUB]` nav link, and (b) relabel the existing hidden footer admin link to visible text **"admin"**. Nothing else in the host site changes.
2. **Desktop Preservation Law.** Never touch baseline (>992px) CSS to fix mobile. Every mobile/tablet rule goes in `@media (max-width:992px)` / `@media (max-width:768px)` appended to the bottom of the `<style>` block.
3. **Design tokens.** Reuse the existing `--lsc-*` tokens and `.badge-*` classes. Headings = Delight; body/meta = mono. No new colour system.
4. **Secret handling (critical).** The Storage write/read keys and Stream token key **never** appear in `client-hub/` or any browser JS, and **never** get committed. They exist only as **Bunny Edge Script environment variables**. Do not paste the RTF's secret values into any tracked file (this plan included). Do not commit `Client HUB /Bunny.Net Storage zone & Pull Zone Details.rtf`.
5. **Simulate → real, gated.** Build each feature's UI in simulate first (localStorage), then wire it to the real endpoints behind a `HUB_CONFIG.mode` flag (`'simulate' | 'live'`). Pause for human confirmation at each milestone gate (§7).
6. **Delta output.** Per repo rule, edit surgically — no full-file dumps for small changes.

---

## 1. Baseline (current architecture)

- Single file `client-hub/index.html` (~800 lines), vanilla JS + Tailwind CDN. One `state` object → `render()` swaps `#app` innerHTML.
- **Data:** `projects[]` in `localStorage['lsc_hub_projects_v1']`.
  - `project = {id, upid, name, clientName, clientEmail, message, invoiceName, assets[]}`
  - `asset = {id, type:'video'|'photo', title, reviewLink, downloadLink, driveLink, status:'reviewing'|'changes'|'approved', comments[]}`
- **Admin auth:** hard-coded PIN `1234` → `sessionStorage['lsc_hub_auth_v1']`.
- **Client access (today):** `?project=<id>` link, bypasses PIN via `guard()`. Reads admin's localStorage → does **not** work cross-device (known blocker).
- **Status engine:** `projectStatusOf()` rolls asset statuses into reviewing/changes/approved. `statusMeta` maps to badge classes.
- **Entry point:** hidden `·` footer link (`index.html:640`) → hub. Nav (`index.html:200-204`) = WORK/ABOUT/CONTACT.
- `invoiceName` stores a filename string only; no file is uploaded.

---

## 2. Target architecture (real Bunny.net)

```
ADMIN browser (behind PIN + admin key)                 CLIENT browser (email + 4-digit code)
        |                                                       |
        | writes: save/publish project, upload files            | reads: published record JSON, file downloads
        v                                                       v
  Bunny EDGE SCRIPT  /hub/*   <----- verifies 4-digit code ----- (POST email+code)
   (holds secrets as env vars)                                   |
        | S3 PUT / GET (server-side only)                        | GET (signed)
        v                                                       v
  Bunny STORAGE  zone: clienthubdata  <====== served publicly ==>  Bunny PULL ZONE
  (de-s3.storage.bunnycdn.com)                                     client-hub-pullzone.b-cdn.net
                                                                   (Token-Auth Edge Rule ON)
```

**Read/write split (the security spine):**
- **Reads = Pull Zone, no secret.** Client fetches its published record + downloads approved files from `https://client-hub-pullzone.b-cdn.net/...`. This is what makes a client link work on *their own device*.
- **Writes + auth = Edge Script, secret server-side.** Admin uploads and "publish project" go through the Edge Script, which holds the Storage write key as an env var and does the S3 PUT. The 4-digit code is verified inside the Edge Script — codes never live in public JSON.
- **Pull Zone is public by default** — anything in `clienthubdata` is readable by URL. Therefore: enable **Token Authentication** on the pull zone (Edge Rule) so reads require a short-lived token the Edge Script signs after a successful code check; and keep private auth data under a `/private/` prefix that an Edge Rule blocks from the pull zone entirely (403), reachable only server-side by the Edge Script.

**Non-secret config (safe to hard-code in `HUB_CONFIG`):**
| Key | Value |
|---|---|
| Storage zone / bucket | `clienthubdata` |
| S3 endpoint | `https://de-s3.storage.bunnycdn.com` |
| Native storage host | `https://storage.bunnycdn.com/clienthubdata/` |
| Pull zone | `https://client-hub-pullzone.b-cdn.net/` |
| Pull zone ID | `6182913` |
| Stream library ID | `683470` |

**Secrets (Edge Script env vars ONLY — never in repo):**
`STORAGE_WRITE_KEY`, `STORAGE_READ_KEY`, `STREAM_TOKEN_KEY`, `ADMIN_API_KEY` (new — authorises admin write calls; admin pastes it once after PIN, held in `sessionStorage`, sent as `Authorization: Bearer`).

---

## 3. Data model changes

### 3.1 Admin project record (full — stays admin-side / private)
Add to `project`:
```
invoices: [ { id, type:'deposit'|'final', name, url } ]   // replaces single invoiceName
clientCode: '####'          // 4-digit, generated on invite
inviteToken: '<random>'     // for ?invite= onboarding link
clientStatus: 'invited'|'active'
delivered: false            // admin "Mark Delivered" toggle → drives [Project Complete]
publishedAt: null           // ISO when last pushed to Bunny
```
- **Migration (in `loadProjects()` normalisation, ~line 122):** if `p.invoiceName` and no `p.invoices` → `invoices:[{id, type:'final', name:p.invoiceName, url:''}]`. Always coerce `invoices` to an array. Default new fields when absent. Never wipe unknown fields.

### 3.2 Published client record (public via pull zone — SAFE SUBSET)
Written to `clienthubdata/records/<projectId>.json`. Contains **only** what the client may see:
```
{ id, upid, name, message, invoices:[{type,name,url}], delivered,
  assets:[{ id, type, title, status, comments, streamPath, downloadPath, drivePath }] }
```
**Excludes:** `clientCode`, `inviteToken`, `clientEmail`, `ADMIN_API_KEY`, raw write URLs. Codes/emails live only in the private auth record.

### 3.3 Private auth record (server-side only — Edge Rule blocked from pull zone)
`clienthubdata/private/auth/<projectId>.json`: `{ projectId, clientEmail, codeHash, delivered }`. `codeHash` = SHA-256 of the 4-digit code (don't store plaintext).

---

## 4. Features

### F1 — Entry point & subdomain-ready routing
- **Two doors, explicit & cleanly split:**
  - **CLIENT door → top pinned nav.** Add `[CLIENT HUB]` as the last item in the nav so the menu reads **WORK · ABOUT · CONTACT · CLIENT HUB**. Insert after CONTACT in `index.html:203`:
    `<li><a href="client-hub/index.html">CLIENT HUB</a></li>` — matches existing `.nav-links` styling; add mobile treatment in the existing mobile-nav `@media` block. This link opens the **client login** (email + 4-digit code, §F3).
  - **ADMIN door → footer.** Change the existing hidden footer link (`index.html:640`, currently `·` with `opacity:.35; font-size:.7em`) to visible text **"admin"** using the **same font/formatting as the sibling footer text** (match the "Contact" link at `index.html:639` — drop the low-opacity/small-size inline styling). Point it at **`client-hub/index.html?admin=1`**.
  - **Which door opens (guard logic):** both links load the same `client-hub/index.html`; `guard()` decides the screen — `?admin=1` → **admin PIN**; `?invite=<token>` → onboarding; `?project=<id>` → legacy client link (kept); **default (no param) → client login**. So the nav link (no param) lands on the client login; the footer `?admin=1` lands on the PIN.
- **`HUB_CONFIG` block** at the very top of the script (per CLAUDE.md "config at top"): `{ mode, mainSiteUrl, assetBase, basePath, storageZone, s3Endpoint, pullZone, streamLibraryId, edgeBase }`. Refactor the hard-coded `../index.html` back-links and the `@font-face` `../assets/fonts/...` paths to derive from `HUB_CONFIG` — these are exactly what break on a subdomain. Flipping to `hub.lsccreative.*` then = change `basePath`/`assetBase` only.
- **Domain note (pre-launch, not a blocker):** brief says `hub.lsccreative.com`; live `CNAME` is `lsccreative.studio`. Decide `.studio` vs `.com` and one-Pages-site-per-CNAME before any real subdomain cutover. Path deployment needs no change now.

### F2 — Paid Deposit Invoice (`invoices[]`)
- **Editor** (`renderEditor`, ~line 364): replace the single invoice drop-zone with two labelled zones — "Upload Paid Deposit Invoice" and "Upload Final Invoice" — each writing an `invoices[]` entry by `type`. Simulate: store filename. Live: POST file to `/hub/upload` → returns `url` under `clienthubdata/invoices/...`.
- **Client landing** (`renderClientLanding`): add an **Invoices** block. Deposit invoice shows immediately (it's paid upfront); final invoice stays gated until delivery. If `invoices` empty → hide the block (graceful empty state, no error).
- **Client final** (`renderClientFinal`, ~line 561): iterate `p.invoices` and render each as an embedded reader row (deposit + final).

### F3 — Auth, modular email & admin failsafes
- **`client-hub/emailService.js`** (new file, loaded via `<script src>` before the main script). Well-commented placeholder module:
  - `sendInvitation(project)` → builds `?invite=<inviteToken>` URL + 4-digit code, `console.log`s a clean payload, returns `{to,url,code}`. Live seam: `TODO: POST to /hub/notify`.
  - `sendCodeReset(project)` → same shape for reset.
  - No real provider yet; logging to console is the deliverable so it's trivially wired later.
- **Client login screen** (new render fn): email + 4-digit keypad (reuse `.pin-*` styles). Submit → simulate: match against project `clientCode`; live: POST `email+code` to `/hub/auth` → token + projectId(s) → fetch published record from pull zone. "Forgot your code?" → `sendCodeReset()`.
- **Invite onboarding:** extend `guard()` to also handle `?invite=<token>`: resolve token → project → show welcome + reveal/confirm code → drop into portal, set `clientStatus:'active'`.
- **Admin Master Reset:** context-menu action on a project (`renderTracker` menu) → confirm modal → regenerate `clientCode` (+ rehash private record) → `sendCodeReset()` → surface new code to admin.
- **Impersonate Client:** formalise existing "View as Client" into a true impersonation mode. New flag `state.impersonating`. Renders the real client portal (no admin chrome) with ONE persistent bar: "Impersonating <client> · Exit impersonation". Admin-only (behind PIN); never reachable from a client session.

### F4 — Smart State Badges
Extend the status layer (keep the existing health dot). Compute admin-driven badges:
- `[Deposit Paid]` — `invoices.some(i => i.type==='deposit')`.
- `[Ready to Review]` — `assets.some(a => isValidUrl(a.reviewLink))` (media published for proofing).
- `[Project Complete]` — `project.delivered === true` OR all assets approved. **Terminal — overrides the others.**
- **Precedence:** if Complete → show only `[Project Complete]`. Else `[Deposit Paid]` and `[Ready to Review]` may co-show, alongside the health dot.
- Add an admin **"Mark Delivered"** toggle (project context menu) setting `project.delivered`.
- Render badges in **both** the admin tracker cards and the client landing header. Reuse `.badge-*` classes; add `.badge-deposit` / `.badge-ready` / `.badge-complete` variants using existing tokens.

---

## 5. Bunny backend contract (Edge Script)

Single Edge Script, routed by path. Base URL → `HUB_CONFIG.edgeBase` (e.g. an edge-script route on the pull zone or a dedicated script host).

| Route | Method | Auth | Does |
|---|---|---|---|
| `/hub/publish` | POST | admin `Bearer ADMIN_API_KEY` | writes safe published record → `records/<id>.json`; writes/updates private auth record; S3 PUT via `STORAGE_WRITE_KEY` |
| `/hub/upload` | POST (multipart) | admin bearer | stores invoice/media file → returns pull-zone URL |
| `/hub/auth` | POST | none (rate-limited) | body `{email,code}` → SHA-256 compare vs private record → returns short-lived signed token + `projectId(s)` |
| `/hub/sign` | POST | valid client token | signs a pull-zone / Stream URL (TTL) for a download the client is entitled to |
| `/hub/notify` | POST | admin bearer | dispatches invitation / reset / delivery emails (wire real provider later) |

**Storage layout in `clienthubdata`:**
```
records/<projectId>.json        (public via pull zone, token-gated)
invoices/<projectId>/<file>     (public via pull zone, token-gated)
media/<projectId>/<file>        (masters — token-gated; previews via Bunny Stream)
private/auth/<projectId>.json   (Edge-Rule BLOCKED from pull zone; server-side only)
```

**Edge Rules to set (via Chrome, during build):**
1. **Token Authentication ON** for the pull zone (so `records/`, `invoices/`, `media/` require a signed token).
2. **Block `/private/*`** at the pull zone → return 403 (auth data never leaves the edge).
3. **CORS** allow-origin = the hub origin(s) for the record/sign endpoints.

Reference pattern for token signing already exists in `INFRASTRUCTURE_REF.md` (`/sign-stream`) — reuse it.

---

## 6. Security checklist (must all be true before "live")

- [ ] No secret value appears in any file under `client-hub/`, root, or this plan — env vars only.
- [ ] `Client HUB /Bunny.Net Storage zone & Pull Zone Details.rtf` is **not** committed to either repo.
- [ ] Stream token key rotation (still open from prior Handoff) done; new key only as Edge Script env var.
- [ ] Consider rotating the Storage write key if it may have been shared; store new value only in Bunny.
- [ ] Published records contain **no** codes/emails; private auth path is Edge-Rule blocked.
- [ ] Pull zone Token Authentication enabled; download/sign URLs are short-lived.
- [ ] Admin write endpoints reject calls without a valid `ADMIN_API_KEY`.
- [ ] 4-digit codes stored only as SHA-256 hashes.

---

## 7. Sprint sequence & milestone gates

**Sprint A — Routing & config (simulate).** `HUB_CONFIG` block; refactor asset/back-link paths; add nav link; split admin-PIN vs client-login doors (login UI shell). → _Gate: confirm nav + both doors before wiring._

**Sprint B — Invoices (simulate → live files).** `invoices[]` migration; dual upload UI; client Invoices block + final-delivery rows. Wire real file upload via `/hub/upload`. → _Gate._

**Sprint C — Accounts, email & failsafes.** `emailService.js`; invite/onboarding flow; client login → `/hub/auth`; publish records via `/hub/publish`; Admin Master Reset; Impersonate mode. Set Edge Rules (token auth, `/private` block, CORS) via Chrome. → _Gate: verify a client link opens on a second device._

**Sprint D — Smart badges.** Badge engine + `delivered` toggle + variants, admin + client views. → _Final gate + full regression of the existing review/approve/delivery flow._

Each sprint: build in `mode:'simulate'` first, then flip relevant paths to `mode:'live'`. Update `Handoff.md` at the end of every turn.

---

## 8. Open items / values still needed

1. **`ADMIN_API_KEY`** — generate a strong value; add as Edge Script env var (Claude can propose one; human sets it in Bunny).
2. **`edgeBase`** — decide where the Edge Script is deployed / its public route.
3. **Email provider** — still stubbed; `emailService.js` + `/hub/notify` are the wiring points.
4. **Domain** — `.studio` vs `.com` for the eventual `hub.` subdomain.
5. **Stream key rotation** — carried over from prior Handoff; blocks a fully-secure "live".
