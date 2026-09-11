# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

Self-hosted NAS video streaming: replace Bunny Stream (`player.mediadelivery.net`)
with video served directly from the user's always-on NAS.

Source media lives on a dedicated NVMe pool (**Storage Pool 4**) at
`LSC Creative_Media / LSC Website_Media` (with subfolders per project/section
for organisation). The NAS runs Docker and will host: an HLS
transcode/packaging pipeline, a web server for the packaged output, and a
Cloudflare Tunnel container to expose that server publicly without port-
forwarding. The static site (GitHub Pages, domain `lsccreative.studio`) then
plays video from that NAS origin instead of Bunny.

This spec covers the full slice end-to-end: NAS-side Docker/media setup AND
the website-side player changes. A later agent with full NAS access executes
the NAS-side slices; slices in this repo are executed here.

### Decisions already made (do not re-litigate without user sign-off)

- **Exposure:** Cloudflare Tunnel (`cloudflared` container on the NAS) — no
  router port-forwarding, no exposed home IP, free TLS via Cloudflare.
- **Format:** Adaptive multi-bitrate HLS (`.m3u8` + segments), produced by an
  `ffmpeg`-based transcode step in Docker. Matches the quality-switching
  behaviour Bunny Stream currently provides.
- **Cutover:** Full retirement of Bunny Stream once the NAS path is verified
  working end-to-end — no CDN pass-through, no dual-running fallback kept
  long-term.
- **Public hostname (assumed, confirm before DNS slice):** `media.lsccreative.studio`,
  a Cloudflare Tunnel hostname added under the existing `lsccreative.studio`
  domain/zone.

### Current state (Bunny-based, being replaced)

- Hero showreel: `<iframe src="https://player.mediadelivery.net/embed/662936/<guid>?...">`
  in [index.html:225](index.html:225).
- Works grid hover-preview background iframe, built at runtime from
  `data-video-id` in [js/main.js:358-370](js/main.js:358).
- Video modal (click a work card → full film), built from `data-video-id` in
  [js/main.js:303-328](js/main.js:303).
- Cinematic video strip interstitial iframe in [index.html:630](index.html:630).
- Bunny library ID `662936`; four project video GUIDs in the works grid
  ([index.html:386,419,452,485](index.html:386)).

## Acceptance Criteria

**NAS / infrastructure**
- [ ] `LSC Website_Media` has a clear, documented subfolder convention (one
      folder per project/section, raw source separated from packaged HLS
      output) that the media-organising agent will populate.
- [ ] Docker Compose stack on the NAS runs: transcode pipeline, HLS web
      server (correct MIME types, byte-range/CORS support), and `cloudflared`
      tunnel — documented as a compose file checked into this repo for
      reference even though it's deployed on the NAS.
- [ ] Web server sends `Access-Control-Allow-Origin` permitting
      `https://lsccreative.studio` (and any preview/staging origins in use)
      so the browser can fetch HLS manifests/segments cross-origin.
- [ ] `media.lsccreative.studio` (or confirmed final hostname) resolves via
      Cloudflare Tunnel to the NAS web server, over HTTPS, reachable from
      outside the home network (tested off local Wi-Fi).
- [ ] At least the 4 existing works videos + hero showreel + cinematic strip
      video are transcoded to HLS and reachable at stable manifest URLs.

**Website (this repo)**
- [ ] Bunny iframe embeds (hero, works grid preview, video modal, cinematic
      strip) are replaced with native `<video>` elements driven by hls.js
      (with native HLS fallback for Safari/iOS via `canPlayType`).
- [ ] A single config point (e.g. `js/media-config.js` or a const at the top
      of `main.js`) holds the NAS media base URL and the per-project
      manifest path/slug, replacing the Bunny library ID + GUID scheme.
- [ ] Autoplay/loop/muted hero and hover-preview behaviour is preserved
      exactly as it is today.
- [ ] If the NAS origin is unreachable or slow (unlike a CDN, a home NAS can
      go offline), the hero section degrades gracefully to its poster/last
      frame image rather than showing a broken video box; a failed hover
      preview simply doesn't show rather than erroring visibly.
- [ ] No regressions to the Cross-Device Responsive Architecture rules in
      `CLAUDE.md` — desktop CSS untouched, mobile/touch fallbacks for the
      hover-preview behaviour still work.
- [ ] Manually verified in a browser at desktop and mobile widths, and
      verified from a network that is NOT on the same LAN as the NAS (to
      prove the tunnel path, not just local access).
- [ ] Bunny `<iframe>` markup, `player.mediadelivery.net` URLs, and the
      Bunny library ID are fully removed from `index.html`/`js/main.js` once
      cutover is verified.

## Out of Scope

- Migrating `client-hub-app/index.html` or any other consumer of Bunny (none
  currently exist outside `index.html`/`js/main.js`).
- Building a custom transcode UI/automation for future uploads — this pass
  only needs the existing 4 works films + hero showreel + cinematic strip
  video moved over. A repeatable "drop a new file in, get an HLS folder out"
  script is a nice-to-have, not required for this feature to ship.
- NAS-wide Docker/network hardening beyond what's needed to safely expose
  this one media service (no VPN redesign, no unrelated container migrations).
- Changing the domain/DNS provider — assumes `lsccreative.studio` DNS is
  already on/movable to Cloudflare for the Tunnel to attach a hostname.
