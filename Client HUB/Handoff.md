## ⏱ 2026-07-23 — Working-folder cleanup (298MB → 88MB)
**Removed (all verified unreferenced first):**
- `.claude/worktrees/nervous-cannon-5c03a1` — 132MB prunable git worktree (worktree pruned, dir gone).
- 6 loose root images (`bakehouse/bnb-autohaus/illawarra-hawks/marine-vitalities-thumb.png`, `lsc-logo.png`, `favicon.png`) — exact md5 dupes of the `assets/` copies the site actually loads.
- `_ARCHIVE-UNUSED/` (52MB, untracked) + unreferenced source folders: `assets/01 SECTION ASSETS`, `assets/Example work to build website`, `assets/Film Contact-sheet-mockup…`, `assets/LSC Logo [Transparent]`.
- Orphaned code: `css/style.css` (superseded — main.css ported its rules), `css/quote.css`, `js/app.js` (not linked by any HTML).
**Verified after:** all `index.html`/`client-hub` references still resolve (0 broken refs), `index.html` JS parses, `git worktree list` shows only main. Root is now clean of loose images.
**Untouched:** live site files (`index.html`, `css/main.css`, `js/{main,device-context,scroll-animations}.js`, `assets/{sections,branding,fonts,LSC Fonts,favicon.png,LSC Logo Type 3.png}`), `client-hub/` app, this `Client HUB/` docs folder.

---

## ⏱ 2026-07-23 — Main-site hero video swap (outside Client Hub scope)
**Done & verified:** `index.html` line 226 — hero iframe `src` GUID changed `6c906ad4-9642-4b1e-9a56-51500020b81f` → `98328538-1852-4541-9b49-4b5625ad5d8e` (Bunny library `662936`). Source given as `/play/662936/98328538-…`; converted to `/embed/` form and kept existing hero params (`autoplay/loop/muted/preload/responsive&controls=false`). Only the hero was touched — secondary embed (`bd34bf23-…`, ~line 569) untouched. `node -e` parse check passed.
**Next:** confirm loop/autoplay on live Bunny deploy after push.

---

# Handoff — Client Hub
_Last updated: 2026-07-21 · **🟢 LIVE.** Feature scope complete, Bunny deployed, publish path verified against real storage._
_(Read `START-HERE.md` first — it has the map, the hard rules, and the infra gotchas.)_

## Current state
`HUB_CONFIG.mode = 'live'` · `edgeBase = https://client-hub-pullzone.b-cdn.net`
Admin writes need `ADMIN_API_KEY` pasted into the amber bar after PIN (kept in sessionStorage).

## What's built (all delivered & browser-verified)
1. **Routing & config** — `HUB_CONFIG` block; fonts + back-links derive from it (subdomain-ready).
   Two doors: `?admin=1` → PIN; no param → client login; `?invite=<token>` → onboarding;
   `?project=<id>` → legacy link (kept).
2. **Invoices** — `invoices[]` (deposit + final) with migration from the old single `invoiceName`.
   Deposit shows on the client landing immediately; final is gated until `delivered`.
3. **Accounts** — email + 4-digit code login, `emailService.js` stub, invite onboarding,
   **Admin Master Reset**, **Impersonate Client** (one persistent bar, no admin chrome).
4. **Smart badges** — `[Deposit Paid]` / `[Ready to Review]` / `[Project Complete]`
   (terminal, overrides the others) + a **Mark Delivered** toggle.

**Security spine (verified, not assumed):** the published record contains **no** code, email or
invite token; the private auth record stores a **SHA-256 hash**, never the plaintext code.

## Proven live (curl + Bunny dashboard, not just the UI)
| Check | Result |
|---|---|
| `/private/*` | `403` |
| `records/*.json` unsigned | `403` (token auth holding) |
| `/hub/publish` no / wrong bearer | `401` |
| `/hub/auth` well-formed | `200` → proves `STORAGE_READ_KEY` |
| **Real invite → `/hub/publish`** | **`records/` + `private/` confirmed written in `clienthubdata`** → proves `ADMIN_API_KEY` + `STORAGE_WRITE_KEY` |

## ▶ Next step — the 2-device test (the last unproven thing)
The app currently runs from `localhost`, which a phone can't reach. The cross-device path is the
entire point of the architecture and has **not** been demonstrated yet.
1. **Commit + push** — `client-hub/` is untracked and root `index.html` is modified.
   `.gitignore` now keeps `Client HUB/` and all credentials out; check `git status` before pushing.
2. On the live site: footer **admin** → PIN → paste `ADMIN_API_KEY` → new project → **Invite Client**.
3. Open the client login **on a phone**, enter email + 4-digit code → the delivery should load.

## Open items
| # | Item | Notes |
|---|---|---|
| 1 | 🔴 **Stream key rotation** | Carried from the first handoff — the old key was committed to git history, so treat it as burned. Rotate in Stream → library `683470`; store only as an Edge Script Secret. |
| 2 | 🟡 **Email provider** | `/hub/notify` only `console.log`s. Codes currently reach the client **only** by you reading them off the invite modal. Wire a real provider (key from `process.env`) to make invites self-serve. |
| 3 | 🟡 **Client write-back** | Client approvals/revisions persist locally but never reach the studio cross-device. Needs a `/hub/feedback` write endpoint — the natural next feature. |
| 4 | 🟡 **CORS is `*`** | Fine for testing; tighten `Access-Control-Allow-Origin` to the hub origin once the domain is settled. |
| 5 | 🟡 **Domain** | `.studio` vs `.com` for an eventual `hub.` subdomain. Path deploy needs no change; flipping = edit `basePath`/`assetBase`/`mainSiteUrl` only. |
| 6 | ⚪ **Invoice upload** | Editor stores the *filename* only. `/hub/upload` is speced but not wired. |

## Decisions worth not re-litigating
- **Secrets live in Bunny → Environment → *Secrets*** (not Variables — Variables render the value
  in plaintext in the dashboard, and a Variable and a Secret cannot share a name).
- **`STREAM_TOKEN_KEY` is set but unused** by current code; it's there for future Stream previews.
- **Host-site edits total 3 lines** (nav link, nav ghost-label, footer admin link). The ghost-label
  is load-bearing: the nav pill is sized from those transparent mirrors, so a new nav item needs one.
- **A 401 from any admin call** now clears the stored key, says "Admin key rejected — re-enter it",
  and rolls back the local mutation, so a failed invite never leaves an undelivered code behind.
