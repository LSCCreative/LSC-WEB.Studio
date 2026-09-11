# Build Plan

## Feature: Client Hub admin login (email + PIN gate)

## Task Slices

- [x] Slice 1: Add `ADMIN_EMAIL` const, email input field on lock screen, and
      `adminEmailInput` state | Model: Claude Code | Effort: Low
- [x] Slice 2: Gate unlock on email match AND PIN match in `pressKey()` |
      Model: Claude Code | Effort: Low
- [x] Slice 3: Fix footer copy to stop leaking demo PIN; show mode-based
      message | Model: Claude Code | Effort: Low
- [x] Slice 4: Prevent numeric keydown handler from hijacking the email input;
      de-dupe `keydown` listener on re-render | Model: Claude Code | Effort: Low
- [ ] Slice 5: Manually verify in browser — desktop width and mobile width,
      wrong email, wrong PIN, correct combo, keyboard entry into email field |
      Model: Claude Code | Effort: Low
- [ ] Slice 6: Commit the change (currently uncommitted in working tree) |
      Model: Claude Code | Effort: Low
