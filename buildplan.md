# Build Plan

## Feature: Client Hub — Deliverables Sign-Off Screen

All slices run in `client-hub-app/index.html` (**[WEB]**) unless noted.
Work strictly top-to-bottom; don't skip ahead. Full context: `feature-spec.md`.

## Task Slices

- [x] Slice 1: Add a persisted `agreement` field to the project data model:
      `{ accepted: bool, signedAt, signerName, signatureDataUrl }`. Include
      it in `newProject`/project migration logic so existing projects get a
      safe default (`accepted: false`). | Model: Claude Code | Effort: Low

- [x] Slice 2 (UI design checkpoint): Build the new agreement/sign-off
      screen — agreement copy, a typed-signature generator (name input +
      cursive-font `<select>`, live preview — replaces the old draw canvas
      per user direction; see `renderAgreementScreen`/`bindAgreementScreen`
      and `SIGNATURE_FONTS`), and a confirm button — as a standalone screen
      matching existing `renderClientChrome` card styling. Run it live in
      the browser preview and share a screenshot before wiring it into the
      real approval flow; this is the review point for design changes. |
      Model: Claude Code | Effort: Medium

- [x] Slice 3: Wire the approved screen from Slice 2 into the real flow —
      replace `renderClientFinal()`'s fake invoice-reader block, gate the
      `DOWNLOAD CONTENT` / `GOOGLE DRIVE BACKUP` rows (L1029-1046) behind
      `agreement.accepted`. Also add the legal consent checkbox below the
      signature preview ("I agree that this typed signature is the legal
      equivalent of my handwritten signature and constitutes my intent to
      sign this document legally.") — `CONFIRM & SIGN` stays disabled until
      both a typed name AND the checkbox are present. | Model: Claude Code |
      Effort: Medium

- [x] Slice 4: Rasterize the typed signature — draw `#signature-preview`'s
      text onto a hidden canvas in the chosen font to produce a PNG data
      URL for `agreement.signatureDataUrl` (see the note left in
      `scratchpad.md` from Slice 2). On confirm, persist
      `agreement.accepted/signedAt/signerName/signatureDataUrl` to the
      project record (not just transient `state.signature`). Add a green
      check + "Deliverables Accepted" (+ signed date) badge to the admin
      dashboard/editor for that project. | Model: Claude Code | Effort:
      Medium

- [x] Slice 5 (legal/audit evidence — backend): Capture and persist the
      digital-evidence bundle alongside the agreement so it's available if
      ever needed as proof of consent:
      - Intent to sign: the Slice 3 consent checkbox's confirmation text +
        checked state.
      - Timestamp: precise UTC ISO string at the moment of signing.
      - User-Agent string: `navigator.userAgent`.
      - Verification token: the signed-in client's session/invite token
        (reuse the existing `CLIENT_TOKEN_SS` / auth token — don't invent a
        new identity scheme).
      - IP address: **cannot be captured client-side** — the browser has no
        trustworthy API for its own public IP, so a client-reported value
        is not legal-grade evidence. Requires a new endpoint on the Bunny
        Edge Script (`client-hub-docs/hub-edge-script.js`, e.g.
        `/hub/agreement`) that reads the real request IP server-side from
        the edge request and stamps it onto the stored record — the client
        only POSTs the rest of the payload.
      - Storage: this bundle contains PII (IP, UA) — store it in the
        **private** server-side record (same pattern as `priv` in
        `hubApi.publish`, which is edge-blocked from the public pull zone),
        not in `buildPublishedRecord`'s safe public record. No SIMULATE
        (localStorage) equivalent for the IP capture — matches the
        `deliverableUrl` pattern of being live-mode-only.
      - No automated test suite exists for the edge script — verify by
        checking the live Bunny deployment logs/response after a real
        signed test.
      | Model: Claude Code | Effort: High
      **⚠ Built against `nas/client-hub-api` instead, not the Bunny Edge
      Script** — see scratchpad.md for why; that doc file is stale and no
      longer the live backend.

- [x] Slice 6: Admin evidence viewer — let the admin open the full
      legal-evidence bundle for a signed project from the dashboard/editor
      (signer name, UTC timestamp, IP, user-agent, consent text), not just
      the green badge from Slice 4. | Model: Claude Code | Effort: Low

- [x] Slice 7: Copy pass — update the approve-modal text (L928-938,
      currently promises "final handover" via invoice) and any other UI
      text referencing a "final invoice" screen that no longer exists. |
      Model: Claude Code | Effort: Low

- [x] Slice 8: Verify — full approve → sign (incl. consent checkbox) →
      download flow at desktop and mobile widths (per `CLAUDE.md`'s
      responsive rules); confirm download buttons stay hidden
      pre-signature and appear immediately after; confirm the evidence
      bundle (Slice 5) and admin viewer (Slice 6) show correct data for a
      real signed test project. | Model: Claude Code | Effort: Low
