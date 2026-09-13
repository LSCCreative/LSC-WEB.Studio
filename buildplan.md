# Build Plan

## Feature: Self-hosted NAS video streaming (replaces Bunny Stream)

Slices marked **[NAS]** run on the NAS itself (Docker, files, Cloudflare) —
the executing agent needs full NAS access, not just this repo. Slices marked
**[WEB]** run in this repo. Work strictly top-to-bottom; don't skip ahead.

## Task Slices

- [x] Slice 1 **[NAS]**: The user is dropping video folders into
      `LSC Creative_Media/LSC Website_Media`, each named after the video
      (not necessarily matching the slugs below) and — for videos that were
      previously hosted on Bunny — already containing a full Bunny HLS
      export (`master.m3u8`/`playlist.m3u8`, `240p/ 360p/ 480p/ 720p/
      1080p/` folders of `.ts` segments, `play_*.mp4` progressive
      fallbacks, `original/` master, thumbnails/previews). Your job:
      rename/reorganise those folders to fit the site's convention — one
      folder per project using the slugs `hero/`, `marine-vitalities/`,
      `bnb-autohaus/`, `bakehouse/`, `illawarra-hawks/`, `cinematic-strip/`
      (match by content/filename to figure out which dropped folder is
      which project; ask the user if a match is ambiguous), each split into
      `source/` (the `original/` master only) and `hls/` (everything else
      from the Bunny export — `master.m3u8`/`playlist.m3u8`, the resolution
      folders, progressive `play_*.mp4`, thumbnails/previews — used as-is,
      no re-transcoding). For any project with no pre-existing Bunny export
      (raw source file only), just place it in `source/` and leave `hls/`
      empty for Slice 2. | Model: Claude Code | Effort: Low

- [x] Slice 2 **[NAS]**: For any project whose `hls/` folder is still empty
      after Slice 1 (no pre-existing Bunny export was available), stand up
      an `ffmpeg`-based transcode step (Docker container or script) to
      package its `source/` master into multi-bitrate HLS in the matching
      `hls/` folder — matching the Bunny export structure/renditions already
      used by the other projects. Then, regardless of how each `hls/`
      folder was populated, add a web server container (Caddy or Nginx)
      serving `LSC Website_Media/**/hls/` with correct MIME types
      (`application/vnd.apple.mpegurl`, `video/mp2t` or `video/mp4` for
      fMP4 segments), HTTP range-request support, and
      `Access-Control-Allow-Origin: https://lsccreative.studio`. | Model:
      Claude Code | Effort: Medium

- [x] Slice 3 **[NAS]**: Add a `cloudflared` container to the compose stack,
      authenticate it against the Cloudflare account that owns the
      `lsccreative.studio` zone, and add a Tunnel public hostname
      (`media.lsccreative.studio`, or confirm final choice with the user)
      routing to the web server container. Verify the hostname resolves and
      serves an HLS manifest from a network outside the home LAN. | Model:
      Claude Code | Effort: Medium

- [x] Slice 4 **[NAS]**: Transcode and publish the 5 required assets (hero
      showreel, cinematic strip video, Marine Vitalities, BNB AutoHaus,
      BakeHouse, Illawarra Hawks — 6 total) into their `hls/` folders and
      confirm each manifest URL loads over the public tunnel hostname. Note
      the final manifest path/slug for each in `scratchpad.md` for the
      **[WEB]** slices to consume. | Model: Claude Code | Effort: Low

- [x] Slice 5 **[WEB]**: Add `js/media-config.js` (or a top-of-file const
      block in `js/main.js`) mapping project slug → HLS manifest URL under
      the confirmed NAS base URL, replacing the Bunny library ID (`662936`)
      + GUID scheme. Load hls.js from a CDN `<script>` tag (or vendor it
      into `js/`) in `index.html`. | Model: Claude Code | Effort: Low

- [x] Slice 6 **[WEB]**: Replace the hero showreel Bunny `<iframe>`
      ([index.html:225](index.html:225)) with a native `<video autoplay
      muted loop playsinline>` wired to hls.js (native HLS fallback via
      `canPlayType('application/vnd.apple.mpegurl')` for Safari/iOS),
      preserving current autoplay/loop/muted/no-controls behaviour and
      layering (`.hero-video-mask`). | Model: Claude Code | Effort: Medium

- [x] Slice 7 **[WEB]**: Replace the works-grid hover-preview background
      iframe ([index.html:364-371](index.html:364), wired in
      [js/main.js:358-380](js/main.js:358)) with a native `<video>` +
      hls.js, keeping the existing hover-to-show / mouse-only / touch-skips
      behaviour and the `loadVideo(videoId)` de-dupe-on-same-tile logic. |
      Model: Claude Code | Effort: Medium

- [x] Slice 8 **[WEB]**: Replace the video modal iframe
      ([index.html:143](index.html:143), wired in
      [js/main.js:303-328](js/main.js:303)) with a native `<video controls
      autoplay>` + hls.js, keeping the instant-stop-on-close behaviour (swap
      `iframe.src = ''` for pausing + detaching the hls.js instance/removing
      the `<source>`). | Model: Claude Code | Effort: Medium

- [x] Slice 9 **[WEB]**: Replace the cinematic video strip iframe
      ([index.html:630](index.html:630)) with the same native
      `<video>` + hls.js pattern. | Model: Claude Code | Effort: Low

- [x] Slice 10 **[WEB]**: Add graceful-degradation handling: if an HLS
      manifest fails to load (NAS/tunnel down or slow), fall back to a
      static poster/last-frame image for the hero and cinematic strip, and
      silently skip the hover preview (no broken video box, no console-error
      spam surfaced to the user). | Model: Claude Code | Effort: Medium

- [x] Slice 11 **[WEB]**: Manually verify in a browser — desktop and mobile
      widths, hero autoplay, works-grid hover preview (desktop) and tap-to-
      modal (touch), video modal open/close/instant-stop, cinematic strip
      playback — first on local network, then from a connection outside the
      NAS's LAN to prove the tunnel path. Confirm no Cross-Device
      Responsive Architecture regressions per `CLAUDE.md`. | Model: Claude
      Code | Effort: Low

- [x] Slice 12 **[WEB]**: Remove all remaining `player.mediadelivery.net`
      references, the Bunny library ID, and now-unused `data-video-id`
      wiring left over from the old scheme; confirm Bunny Stream can be
      cancelled/downgraded. Commit. | Model: Claude Code | Effort: Low
