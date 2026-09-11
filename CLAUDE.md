## Tech Stack

Static site: plain HTML/CSS/JS, no build step, no package manager. `index.html` +
`css/` + `js/` is the main marketing site. `client-hub-app/index.html` is a
single-file JS app (inline `<script>`, Tailwind via CDN, local state) for the
client project tracker. `CNAME` implies GitHub Pages hosting.

## Build / Run / Test

- No build step. Open `index.html` or `client-hub-app/index.html` directly in
  a browser, or serve the repo root with any static file server.
- No automated test suite. Verify changes by loading the page and checking
  the relevant viewport(s) manually (desktop + mobile — see below).

## Coding Standards

- Follow the Cross-Device Responsive Architecture rules below for all CSS/layout work.
- Keep the client-hub-app as a single self-contained HTML file unless asked to split it.
- Don't touch `_archive/` unless a task explicitly needs something from it (see below).

## 📱 Cross-Device Responsive Architecture & Viewport Locks

Treat desktop and mobile as two distinct visual mediums. Never write blended
CSS that compromises one device for the other.

1. **Desktop Preservation Law (Immutable)** — baseline selectors stay reserved
   for the locked desktop experience (>992px). Never alter, refactor, or
   delete existing desktop styles or animation variables when adjusting
   mobile layouts. Every mobile/tablet adjustment goes exclusively inside
   `@media (max-width: 992px)` / `@media (max-width: 768px)` blocks appended
   to the bottom of the stylesheet.
2. **Nav** — desktop (>768px): full inline text links (`WORK`, `ABOUT`,
   `CONTACT`). Mobile (≤768px): collapse into `<button class="mobile-menu-toggle">`
   with a hairline SVG icon, toggled via `.is-active`, revealing a slide-down
   or full-screen glassmorphic overlay.
3. **Structural adaptation** — `:hover`-only interactions need a touch
   fallback or must become permanently visible on phones. Horizontal
   scroll/pinning tracks (`.horizontal-gallery`, `.film-frames-grid`) must be
   dismantled on mobile into a vertical feed or `overflow-x: auto !important;
   -webkit-overflow-scrolling: touch;`. Absolutely-positioned children
   (`.project-tile`, `.project-info-overlay`) reset to relative, stacked,
   `max-width: 100%` on phones.
4. **Typography & modals** — large desktop type (`.display-title`,
   `.contact-headline`) must shrink on small viewports via `clamp()` or
   explicit overrides. Modals/forms scale to `100vw`/`100vh` on mobile with
   `overflow-y: auto` if content overflows.

## 🗃️ `_archive/` Folder

Gitignored, never published, not referenced by `index.html`/`css/`/`js/`.
Holds superseded assets and stale docs. Don't read or search it by default —
only look inside if something needed for the current task is missing from
the active project.

## Agent Handoff Protocol

- On session start, read `feature-spec.md`, `buildplan.md`, and
  `scratchpad.md` before doing anything else.
- Work strictly on the first unchecked task (`[ ]`) in `buildplan.md`. Don't
  jump ahead to later slices.
- Log active progress, test failures, and execution state in `scratchpad.md`
  as you go.
- Before session end or a context wipe: update `scratchpad.md` with handoff
  notes for the next agent, and mark finished items `[x]` in `buildplan.md`.
