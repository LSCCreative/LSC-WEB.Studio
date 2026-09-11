# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

Slice 5: manually verify the admin email+PIN login in-browser (desktop +
mobile), then Slice 6: commit.

## State & Blockers

- Modified file: `client-hub-app/index.html` (uncommitted, staged nowhere).
- Code changes for Slices 1-4 are already in the working tree:
  - `ADMIN_EMAIL = 'lachlan@creativelsc.com'`, `PIN = '2803'`
  - Email input `#admin-login-email` added above the PIN dots
  - `pressKey()` now checks `emailOk && state.pinInput === PIN`
  - Footer copy switched to `HUB_CONFIG.mode === 'live' ? 'SECURE ADMIN ACCESS' : 'SIMULATE MODE'`
  - `lockKeyHandler` ignores keydown when target is INPUT/TEXTAREA
  - `bindLock()` removes then re-adds the `keydown` listener to avoid stacking
- Not yet verified in an actual browser. No test suite exists for this project.
- Not yet committed — no commit has been made for this change.

## Next Agent Handoff

1. Open `client-hub-app/index.html` in a browser (or via a static server).
2. Confirm the lock screen shows the email field + PIN pad correctly at
   desktop and mobile (≤768px) widths.
3. Test: wrong email + right PIN → rejected. Right email + wrong PIN →
   rejected. Right email + right PIN → unlocks. Typing in the email field
   does not trigger PIN digit entry.
4. If all pass, check off Slice 5 in `buildplan.md`, then commit
   `client-hub-app/index.html` with a descriptive message and check off
   Slice 6.
5. After merge to main, wipe this file back to the template state.
