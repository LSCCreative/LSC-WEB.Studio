# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

Client Hub admin login: email + PIN gate.

Require an admin email (`lachlan@creativelsc.com`) alongside the 4-digit PIN
to unlock `client-hub-app/index.html`, instead of PIN alone.

## Acceptance Criteria

- [ ] Login screen shows an email field above the PIN pad.
- [ ] Unlock requires the email to match `ADMIN_EMAIL` (case-insensitive) AND
      the correct PIN.
- [ ] Footer copy reflects mode (`live` vs `simulate`) instead of leaking the
      demo PIN.
- [ ] Typing in the email field never triggers the numeric keypad handler.
- [ ] Re-rendering the lock screen doesn't stack duplicate `keydown` listeners.
- [ ] Manually verified in a browser at both desktop and mobile widths.

## Out of Scope

- No real backend/auth service — this stays a client-side gate for a static
  demo/internal tool, not a security boundary.
- No password reset, multi-user accounts, or session expiry changes.
- No changes to the main marketing site (`index.html`, `css/`, `js/`).
