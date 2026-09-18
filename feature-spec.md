# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

Client Hub — replace the final "invoice" screen with a deliverables
sign-off screen. Today, once a client approves every asset, `renderClientFinal()`
(`client-hub-app/index.html`) shows a fake invoice-PDF viewer, per-asset
download rows, and a cosmetic signature canvas that's never persisted.

Instead: the client should see an agreement ("I confirm I'm happy with the
final version of this media"), sign it, and only then see the download
link(s) for whatever's been submitted on that project. On acceptance, the
admin dashboard/editor should show a green check + "Deliverables Accepted"
badge with the signed date, on that project.

### Decisions already made (do not re-litigate without user sign-off)

- New persisted field on the project record: `agreement { accepted, signedAt,
  signerName, signatureDataUrl }`.
- Download buttons (`DOWNLOAD CONTENT` / `GOOGLE DRIVE BACKUP`) are hidden
  until `agreement.accepted` is true.
- Admin sees a green checkmark + "Deliverables Accepted" (+ signed date)
  badge on the project once accepted — visible on the dashboard/editor, not
  buried.
- A UI-design checkpoint slice runs before the new screen is wired into the
  real approval flow, so the user can review/adjust the look before it's
  live.
- Signature capture is a **typed-signature generator** (name input + choice
  of cursive Google Fonts, live preview), not a hand-drawn canvas — changed
  from the original canvas approach after Slice 2 review.
- The signed agreement must persist server-side ("to the database"), not
  just in the client's local project record, so it's retrievable later —
  and must carry a legal/audit evidence bundle alongside it: intent-to-sign
  checkbox text + checked state, UTC timestamp, `navigator.userAgent`, the
  signer's session/verification token, and their IP address. See
  `buildplan.md` Slices 5-6.
- The IP address in that bundle must be captured **server-side** (stamped
  by the Bunny Edge Script from the real request, not reported by the
  client) to be trustworthy as evidence — this needs a new `/hub/agreement`
  -style endpoint, live-mode only, no SIMULATE equivalent (same shape as
  `hubApi.deliverableUrl`).
- The evidence bundle contains PII (IP, user-agent) and belongs in the
  **private** server-side record (same gating as `priv` in
  `hubApi.publish`), never in `buildPublishedRecord`'s safe public record.

### Resolved decisions

- Invoice display: dropped entirely from the client-hub final screen, no
  Billing-tab replacement (user decision, 2026-09-18). Only the fake
  invoice-reader block inside `renderClientFinal()` was removed — the
  existing, unrelated `renderInvoicesBlock()` on the landing screen (paid
  deposit badge / gated final invoice) is untouched and out of scope for
  this feature.

## Acceptance Criteria

- Client who approves all assets lands on the new agreement screen, not the
  old invoice screen.
- Download links are inaccessible until the client signs.
- Signature + acceptance timestamp persist on the project record server-side
  (not just transient `state` or the client's local storage).
- The client cannot reach the confirm step without checking the legal
  intent-to-sign checkbox.
- The legal evidence bundle (timestamp, IP, user-agent, verification token,
  consent text) is captured and stored alongside the agreement, with the IP
  address stamped server-side rather than client-reported.
- Admin can see, at a glance, whether a project's deliverables have been
  accepted, and can open the full evidence bundle for a signed project.

## Out of Scope

- Any change to the per-asset approval flow itself (`a.status`, the
  approve-modal at L928-938) beyond copy tweaks if it still references
  "final invoice."
- Invoice PDF generation/line-items — invoices remain filename-only uploads;
  this feature only changes where/whether they're shown to the client.
