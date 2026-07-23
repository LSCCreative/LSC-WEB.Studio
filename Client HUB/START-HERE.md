# START HERE — LSC Client Hub

**New session? Read this file, then `Handoff.md`. That's it — ~5 min of context.**
Everything else below is reference: open it only when the task actually needs it.

---

## 1. What this is (30 seconds)
A serverless client proofing & delivery portal bolted onto the existing LSC site.
Clients sign in with **email + a 4-digit code**, review video/photo deliverables, approve
them, then get invoices + download links. Admin side is behind a PIN.

**Status: 🟢 LIVE and working.** All four planned sprints are delivered, the Bunny backend
is deployed and verified against real storage. One thing remains unproven — see Handoff.

## 2. Where the code lives
| Path | What |
|---|---|
| `client-hub/index.html` | **The whole app.** Single file: `HUB_CONFIG` at top, then state → `render()` → bind functions. ~1340 lines. |
| `client-hub/emailService.js` | Email stub module (logs payloads; live path POSTs `/hub/notify`). |
| `Client HUB/hub-edge-script.js` | **The deployed Bunny Edge Script** (source of truth for what's on the edge). |
| `index.html` (root) | The host site. **Only 3 lines were ever changed** — see §4. |

## 3. Read order (don't read more than you need)
1. **`Handoff.md`** ← current state, what was proven, what's next. **Always read this.**
2. `CLAUDE.md` + `AI.md` — working rules (token discipline, isolation, update Handoff before finishing).
3. `BUNNY-SETUP.md` — the Bunny runbook. Read **only** if touching infrastructure.
4. `INFRASTRUCTURE_REF.md` — Bunny token-signing reference + the outstanding Stream key rotation.
5. `blueprint.md` — the original product vision. Read **only** if building a *new* feature; it
   describes the intended UX in full, but most of it is already implemented.
6. `_archive/` — historical. `BUILD-PLAN.md` is the delivered 4-sprint spec (useful for "why is
   it built this way"); the Reference Templates are **superseded and one is actively wrong**
   (it shows the standalone `serve()` model — the real script is middleware).

## 4. Hard rules (violating these breaks things)
- **The repo is mirrored to the LIVE PUBLIC SITE by Bunny CI/CD.** Anything committed becomes
  publicly reachable. `Client HUB/` (this folder) is gitignored for exactly that reason — it holds
  planning docs *and* Bunny credentials. Never commit it, never move a secret out of it.
- **Secrets live only as Bunny Edge Script *Secrets*** (Environment → Secrets, read via
  `process.env.*`). Never in `client-hub/`, never in browser JS, never in a tracked file.
- **Host-site isolation.** Exactly **3** lines of root `index.html` have been touched, all approved:
  the `CLIENT HUB` nav `<li>`, its matching `ghost-label` in the nav goo layer, and the footer
  `admin` link. Adding a nav item *requires* adding its ghost-label too, or the pill breaks.
- **Desktop Preservation Law.** Never edit baseline (>992px) CSS to fix mobile; mobile rules go in
  `@media` blocks at the bottom of the stylesheet.
- **Update `Handoff.md` before ending any session.** It is the only reliable memory between sessions.

## 5. Running it
```bash
# static server from the repo root (or use .claude/launch.json → "lsc-static")
python3 -m http.server 8734
```
- Client door: `http://localhost:8734/client-hub/index.html`
- Admin door: `…/client-hub/index.html?admin=1` → PIN `1234` → paste `ADMIN_API_KEY` in the amber bar
- Syntax check before any push:
  ```bash
  node -e 'const fs=require("fs");const h=fs.readFileSync("client-hub/index.html","utf8");
  const m=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  new Function(m[m.length-1][1]); console.log("JS parse OK")'
  ```

## 6. Live infrastructure (non-secret facts)
| Thing | Value |
|---|---|
| Storage zone | `clienthubdata` |
| Pull zone | `client-hub-pullzone.b-cdn.net` (ID `6182913`) |
| Edge Script | `client-hub-api`, Bunny script **#82483**, type **Middleware** |
| `HUB_CONFIG.mode` | `live` |
| Stream library | `683470` ("Client Deliverables") |

**Two non-obvious gotchas already solved — don't rediscover them:**
1. Enabling pull-zone Token Authentication gates the **whole hostname**, including the login
   endpoint. The Edge Rule `HubApiBypassTokenAuth` (*Disable Token Authentication* where URL
   matches `*/hub/*`) is what makes login possible. Don't delete it.
2. Bunny middleware reads env via **`process.env`**, not `Bunny.env`, and only runs
   `onOriginRequest` on a **cache miss** — hence `Cache-Control: no-store` on every API response.

## 7. Git state you'll inherit
- `client-hub/` is **untracked** — the app has never been committed.
- Root `index.html` is **modified** (the 3 approved lines).
- ~58 stale deletions sit in the tree (macOS `._*`, `desktop.ini`, an old `01 SECTION ASSETS/`
  folder). They're junk; `.gitignore` now prevents recurrence. Committing the deletions would
  tidy the repo, but it's a separate decision from shipping the hub.
- `Client HUB/` contains a vestigial `.git` (no remote, tracks one file). Harmless but confusing;
  safe to delete if it ever gets in the way — `.gitignore` is what protects the secrets now.
