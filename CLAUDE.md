## 📱 CROSS-DEVICE RESPONSIVE ARCHITECTURE & VIEWPORT LOCKS

You must treat desktop viewports and mobile screens as two entirely distinct visual mediums. Never write blended CSS rules that compromise one device for the sake of another. 

### 1. The Desktop Preservation Law (Immutable)
- All baseline CSS selectors must remain strictly reserved for the locked desktop experience (viewports > 992px).
- You are absolutely prohibited from altering, refactoring, or deleting existing desktop styles or absolute animation variables when adjusting mobile layouts.
- Every single mobile or tablet adjustment must be exclusively corralled inside explicit media queries (`@media (max-width: 992px)` or `@media (max-width: 768px)`) appended cleanly to the absolute bottom of the global stylesheet.

### 2. Navigation & Header Screen Optimization
- **Computer Screens (> 768px):** The navbar must display full text links inline (`WORK`, `ABOUT`, `CONTACT`) across the top utility area, keeping spatial hierarchy wide and editorial.
- **Phone Screens (≤ 768px):** Inline text links are prohibited due to horizontal spatial crowding. They must cleanly collapse into a modern, minimal `<button class="mobile-menu-toggle">` element containing a hairline SVG icon. The navigation drawer itself must leverage an active toggle state (`.is-active`) to gracefully reveal links via a slide-down or full-screen glassmorphic overlay.

### 3. Structural Component Adaptation (Horizontal vs. Vertical)
- **The Touch Gesture Paradigm:** Desktop hover triggers do not exist on touch screens. Any interaction model relying on hover states (`:hover`) must automatically fallback to a native touch gesture or become permanently visible on phone viewports.
- **Portfolio Layout Realignment:** Complex horizontal scrolling pinning mechanisms must be completely dismantled on mobile screens to prevent frozen layout bugs. 
  * Transform heavy horizontal tracks (`.horizontal-gallery`, `.film-frames-grid`) into a clean, magazine-style **Cinematic Vertical Feed** or an optimized horizontal touch track using `overflow-x: auto !important; -webkit-overflow-scrolling: touch;`.
  * Ensure child elements (`.project-tile`, `.project-info-overlay`) reset from absolute positioning to relative layouts on phone screens, stacking perfectly down the page with strict, bounded widths (`max-width: 100%`) so they never break the viewport edge.

### 4. Typography & Modal Scaling Matrix
- All massive desktop typography (`.display-title`, `.contact-headline`) must drop their hardcoded sizes on small viewports. Implement aggressive mobile font reductions using responsive `clamp()` architectures or explicit mobile size overrides.
- Modals, pop-ups, and embedded forms must scale fluidly to `100vw` and `100vh` boundaries on mobile. If internal copy or structural columns exceed vertical screen height, the modal must seamlessly switch to inner scrolling (`overflow-y: auto`).