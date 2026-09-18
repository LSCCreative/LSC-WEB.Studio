# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

All 8 slices done — feature complete. Ready to merge to main.

### What changed for Slice 8 (live end-to-end verification)

Ran a full real browser test — not just curl — against a locally-running
`nas/client-hub-api` (temp `DATA_DIR`, test `ADMIN_PIN_HASH`/`ADMIN_EMAIL`,
`CORS_ORIGIN` set to the static preview origin) with `client-hub-app/index.html`
served statically and `HUB_CONFIG.edgeBase` monkey-patched at runtime (via
console) to point at the local API instead of production — no source change,
config override only for the test session.

Flow driven in the browser pane (369px mobile-emulated viewport, then the
pane's native ~738px width standing in for "desktop" — this app is a
Tailwind-responsive single-file app, not the marketing site's two-genre
desktop/mobile CSS split from `CLAUDE.md`, so one consistent breakpoint
check across both pane widths was the meaningful test):
- Created a fresh project, added a video asset with review/download/drive
  links, published it. ✓
- Impersonated the client, opened the asset, approved it — confirmed the
  Slice 7 "Final check" copy now correctly describes signing off before
  download links unlock (no more stale "final handover" wording). ✓
- Landed on the agreement/sign-off screen (not the old invoice screen) —
  confirmed download links are NOT reachable at this point (no final-delivery
  screen exists yet). ✓
- Typed a name → live cursive signature preview rendered, "CONFIRM & SIGN"
  stayed disabled until the consent checkbox was also checked. ✓
- Signed → `POST /hub/agreement` returned 200 (checked via
  read_network_requests) → immediately landed on Final Delivery with
  DOWNLOAD CONTENT / GOOGLE DRIVE BACKUP buttons live (not disabled). ✓
- Exited impersonation → tracker card showed the green "✅ Deliverables
  Accepted · 18 Sept 2026" badge with a "View evidence" link (Slice 6). ✓
- Opened evidence from BOTH the tracker card and the editor header — both
  fetched `GET /hub/agreement/:id` and rendered signer name, UTC timestamp,
  server-stamped IP (`::1`, never sent by the client), full user-agent,
  verification token, consent text, and the rasterized signature PNG,
  identically in both places. ✓

### Bug found and fixed during Slice 8

Opening "View evidence" for a project with no evidence row (e.g. a stale
local project id the current backend has never seen) threw a generic
"⚠ Load evidence failed" toast + "Could not load evidence — see console."
— alarming wording for what is really just an empty state, not a failure.
Fixed in `openEvidenceModal()` (`client-hub-app/index.html`): a 404 now
short-circuits to the existing "No evidence on file for this project."
message with no console error/toast; only non-404 failures (network error,
expired admin session via the existing 401 branch) still surface as a real
error.

### Feature status

Feature spec (`feature-spec.md`) acceptance criteria all verified:
- ✓ Client who approves all assets lands on the agreement screen, not the
  old invoice screen.
- ✓ Download links inaccessible until signed.
- ✓ Signature + timestamp persist server-side (`agreement_evidence` table).
- ✓ Client cannot confirm without the consent checkbox.
- ✓ Evidence bundle (timestamp, server-stamped IP, user-agent, verification
  token, consent text) captured and stored privately.
- ✓ Admin sees at-a-glance acceptance status and can open the full evidence
  bundle.

Not tested: the actual deployed NAS box (`nas/client-hub-api`'s
Dockerfile/compose was never run there from this environment) — every
slice's verification ran against a local instance of the same source. The
user should redeploy before relying on this in production, then this
scratchpad can be cleared on merge per the Handoff Protocol.

### What changed for Slice 7

**Frontend — `client-hub-app/index.html`**: only one stale reference found.
The approve-modal's "Final check" copy (in `renderVideoCanvas`/asset screen,
around the `approve-modal-backdrop` block) said "you will be sent to
download a copy as final handover" — leftover from before Slices 2-4
replaced the fake invoice-reader final screen with the agreement/sign-off
screen. Reworded to: "This will finalise this content production. Once
every asset is approved you'll be asked to sign off before your download
links are unlocked."

Everything else matching `/invoice/i` (`renderInvoicesBlock`, the editor's
`INVOICES` upload zones, `p.delivered` gating "final invoice unlocked for
the client" toast, etc.) is the pre-existing, unrelated deposit/final
invoice billing feature on the landing screen — explicitly out of scope per
`feature-spec.md`'s Resolved Decisions, left untouched. `renderClientFinal()`
and `renderAgreementScreen()` were already clean (rewritten in Slice 3),
nothing to change there.

`node --check` on the extracted `<script>` block — no syntax errors. No
functional/UI-visible behavior changed, copy-only.

### What changed for Slice 6

**Backend — `nas/client-hub-api/src/hubRoutes.js`**: new `GET
/hub/agreement/:projectId` route, `requireAdmin` + `credentialedCors` (same
CORS mount already registered for the Slice 5 POST route — reused, not
duplicated). Reads straight from the `agreement_evidence` table via a new
`getAgreementEvidence` prepared statement; 404s if the project never signed
(no row). Returns the full bundle: signerName, signedAt, signatureDataUrl,
consentText, consentChecked, userAgent, verificationToken, ipAddress,
receivedAt.

**Frontend — `client-hub-app/index.html`**: new `hubApi.fetchAgreement(projectId)`
(GET, live-mode-only, same no-SIMULATE pattern as `deliverableUrl`/
`submitAgreement`). `agreementBadgeHtml()` now renders a "View evidence"
button next to the badge (unchanged badge text/date). New `openEvidenceModal()`
opens `state.evidenceProjectId`/`evidenceLoading`/`evidenceResult` and fetches
in the background; `renderEvidenceModal()` shows signer/timestamp/IP/UA/
verification token/consent text/signature image, or a 404 "no evidence on
file" message. Wired into both `bindTracker()` (dashboard cards) and
`bindEditor()` (editor header) since `agreementBadgeHtml()` renders in both
places already (Slice 4).

### Verification performed (no automated test suite for this backend)

Ran `nas/client-hub-api` locally the same way as Slice 5 (temp `DATA_DIR`,
`SIGNING_SECRET`, `ADMIN_PIN_HASH`+`ADMIN_EMAIL` for a test PIN), drove it
with `curl`:
- `GET /hub/agreement/proj1` with no cookie → `401`. ✓
- Signed in as admin, published `proj1`, POSTed a full `/hub/agreement`
  payload, then `GET /hub/agreement/proj1` with the admin session cookie →
  `200` with all fields matching what was POSTed, `ipAddress` stamped
  server-side. ✓
- `GET /hub/agreement/unknown` (admin cookie, no evidence row) → `404`. ✓
- `node --check` on `hubRoutes.js`, and on the extracted `<script>` block of
  `client-hub-app/index.html` — no syntax errors.

Did NOT test the admin UI in a real browser (no NAS API reachable from this
environment to drive `hubApi.fetchAgreement` against) or the deployed NAS
box — same caveat as Slice 5. Folds into Slice 8's verification pass.

### ⚠ Important correction to buildplan.md's Slice 5 instructions

The buildplan told this slice to add the new endpoint to the **Bunny Edge
Script** (`client-hub-docs/hub-edge-script.js`). That file is stale: the
project migrated the live backend to a self-hosted Express + SQLite service
at **`nas/client-hub-api/`** before this feature started (see its
`hubRoutes.js` header comment: "Reimplements client-hub-docs/hub-edge-script.js's
four /hub/* routes against SQLite instead of flat Bunny Storage JSON blobs").
`HUB_CONFIG.edgeBase` in `client-hub-app/index.html` already points at
`https://hub-api.lsccreative.studio` (the NAS API), not a Bunny pull zone.
The doc copy under `client-hub-docs/` is untracked/never updated and is
missing routes (`/hub/admin-auth`, `/hub/deliverable-url`, `/hub/files/*`)
that have existed in the real backend since Slices 6/14/15. **Any future
slice that touches the backend should go straight to `nas/client-hub-api/`
and treat `client-hub-docs/hub-edge-script.js` as historical reference
only** — worth flagging to the user that this doc should either be deleted
or refreshed to stop misleading future agents.

### What changed for Slice 5

**Backend — `nas/client-hub-api/src/db.js`**: new `agreement_evidence` table
(schema_version bumped 4→5), one row per project (`project_id` is the
PRIMARY KEY, `ON DELETE CASCADE` off `records`), columns: `signer_name,
signed_at, signature_data_url, consent_text, consent_checked, user_agent,
verification_token, ip_address, received_at`. Holds the *entire* signed
agreement (not just the extra evidence fields) so Slice 6's viewer has one
place to read signer name + timestamp + signature + consent + UA + IP from
— it doesn't rely on the admin's own `state.projects` ever syncing back
from a real cross-device client (a separate, pre-existing, out-of-scope gap
— see `persistViewProject()`'s comment about the missing `/hub/feedback`
write path for client-authored changes in live mode).

**Backend — `nas/client-hub-api/src/hubRoutes.js`**: new `POST /hub/agreement`
route (client-facing, no `requireAdmin` — same trust level as `/hub/auth`).
Uses `credentialedCors` (not `openCors`) because `hubFetch` always sends
`credentials:'include'`, and per the existing `/hub/auth` comment, browsers
require a non-wildcard CORS response on any credentialed fetch regardless of
whether the route reads the cookie. Validates all string fields are
non-empty, rejects `consentChecked !== true` (400 "consent required" —
refuses to record evidence for an unchecked box), and 404s if `projectId`
doesn't match an existing `records` row. **`ip_address` is read from `req.ip`
server-side** (Express `trust proxy` is already set to `1` in `index.js`,
correct for the single Cloudflare Tunnel hop) — the client never sends an
IP. Upserts on `project_id` so re-signing updates in place rather than
accumulating rows.

**Frontend — `client-hub-app/index.html`**: new `hubApi.submitAgreement(payload)`
(next to `deliverableUrl`) — live-mode-only no-op in SIMULATE, same pattern
as `deliverableUrl`, since there's no trustworthy IP to capture locally.
`bindAgreementScreen()`'s `confirm-agreement` handler now also calls it
right after `persistViewProject()`, wrapped in try/catch — a network hiccup
on the evidence write does NOT block the client from reaching the download
screen (they've already signed; this is best-effort audit-trail capture,
not a gate). Payload: `projectId, signerName, signedAt, signatureDataUrl,
consentText (= AGREEMENT_CONSENT_TEXT), consentChecked, userAgent
(navigator.userAgent), verificationToken (sessionStorage[CLIENT_TOKEN_SS] ||
'')`. Note: `verificationToken` will be `''` for the legacy `?project=`
link path and for admin-impersonated sessions, since those never call
`authClient()` — that's expected, not a bug.

### Verification performed (no automated test suite for this backend)

Ran `nas/client-hub-api` locally (`node src/index.js` with a temp
`DATA_DIR`, `SIGNING_SECRET`, `ADMIN_PIN_HASH` for PIN `1234`) and drove it
with `curl`:
- `POST /hub/admin-auth` → session cookie → `POST /hub/publish` to seed a
  `records` row for `proj1`.
- `POST /hub/agreement` with `consentChecked:false` → `400 consent required`. ✓
- `POST /hub/agreement` for an unknown `projectId` → `404 not found`. ✓
- `POST /hub/agreement` with a full valid payload → `200 {ok:true}`, correct
  CORS headers echoed for `Origin: https://lsccreative.studio`. ✓
- Read `agreement_evidence` directly via `better-sqlite3` — confirmed
  `ip_address: '::1'` was stamped server-side (never sent by the curl
  payload) and all other fields matched. ✓
- Re-submitted for the same `projectId` with different values — confirmed
  the row count stayed at 1 and the fields updated in place (upsert works). ✓
- `node --check` on both edited backend files, and on the extracted
  `<script>` block of `client-hub-app/index.html` — no syntax errors.

Did NOT test against the actual deployed NAS box (no access from here) —
this was a local run of the same source. The user should redeploy
`nas/client-hub-api` (its Dockerfile/compose) to the real NAS to pick this
up, then do one real signed test as final confirmation (folds into Slice 8's
verification pass anyway).

## Next

No slices remain — all 8 are done and the feature is verified end-to-end.
Nothing blocking. Next step is for the user to redeploy
`nas/client-hub-api` to the real NAS (this feature's backend changes have
only run locally) and merge to main.
