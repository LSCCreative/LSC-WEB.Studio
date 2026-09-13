# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

**Slice 11 DONE (2026-09-13).** DNS propagated overnight (`dig NS
lsccreative.studio` now correctly returns Cloudflare's nameservers). Full
in-browser verification against the real `https://lsccreative.studio`
origin (required — Caddy's CORS only allows that exact origin, so
`localhost` dev-server testing hits a CORS wall and can't be used for this
slice).

**Real bug found and fixed during verification:** the hero and cinematic
strip videos were silently falling back to their poster on nearly every
real page load. Root cause: `main.js`'s autoplay wiring (modules 10/11) ran
before the `hls.js` CDN `<script>` tag had actually finished loading, saw
`Hls` as `undefined`, and fell through to `loadHlsVideo`'s native
`canPlayType()` branch — which Chromium falsely reports `"maybe"` for HLS
without being able to actually decode it (the same false-positive already
flagged in the Slice 6 notes below), so it failed and reset via `onError`.
**Fix:** added `whenHlsReady(cb)` in
[js/media-config.js](js/media-config.js) — waits for the `#hlsjs-cdn`
`<script>` tag's `load`/`error` event when `Hls` isn't defined yet, calls
back immediately otherwise. Modules 10/11 in `js/main.js` now wrap their
`loadHlsVideo(...)` call in `whenHlsReady(...)`. Modules 6/8 (modal, hover)
weren't touched — they're user-triggered well after page load, so they were
never exposed to this race.

**Two false leads chased during debugging, both testing-environment
artifacts, not real bugs — worth knowing for the next agent so they don't
re-chase them:**
1. A temporary `window.__hlsFatalDebug` diagnostic (added then reverted,
   see git history around commits `34d938f`→`7bb7946`) showed the hero's
   `onError` was reached via hls.js's own fatal-error path zero times in
   one test — that test was actually hitting a *different* stale-cache
   layer, not proof of anything; ignore that data point.
2. After the `whenHlsReady` fix first went out, a fresh-tab test still
   showed the hero broken. A second diagnostic round (`window.__heroDebug`
   / `window.__loadHlsVideoDebug`, commits `1196305`→`a57d0d0`) proved the
   fix logic itself was correct (a manually fetched-fresh copy of the code,
   `eval`'d into the page, played the hero perfectly — `videoWidth: 854`) —
   the failure was this **browser testing profile's own stale HTTP/CDN
   cache** of `js/main.js` and `js/media-config.js`, left over from
   fetching many intermediate versions of these files across this long
   debugging session. Confirmed directly: repeated `fetch(..., {cache:
   'no-store'})` calls on `js/main.js` eventually flipped from serving an
   old `len: 23100` (pre-Slice-8, no `data-video-slug`) copy to a
   consistent, correct `len: 24657` copy with `cf-cache-status: HIT` — i.e.
   Cloudflare's edge cache/GitHub Pages' own CDN needed a few minutes to
   fully propagate `js/main.js` specifically (index.html and
   media-config.js propagated faster), the same *class* of lag as the DNS
   propagation issue in Slice 3/4, just for static-asset CDN caching
   instead of DNS. A real first-time visitor never hits this — it only
   bites a session that re-fetches the same URL dozens of times across an
   active multi-hour deploy-and-test loop like this one.

**Verification performed against the live site (working around the stale
local test-cache via `fetch(url, {cache:'no-store'})` + `eval()` to patch
in the always-correct current code before exercising each interaction —
the underlying site code was never modified for testing, only this test
browser's in-memory globals):**
- Hero: `videoWidth: 854`, plays automatically, no errors.
- Works-grid hover preview (module 8): `videoWidth: 854`, no `onError`
  fired.
- Video modal open/close (module 6): opens and plays (`videoWidth: 854`,
  `paused: false`); close cleanly stops it (`paused: true`, `readyState:
  0`, `src` attribute removed) — matches the instant-stop behaviour already
  verified in Slice 8.
- Cinematic strip (module 11): `videoWidth: 856`.
- Mobile viewport (375×812, `resize_window` preset `mobile`): nav collapses
  to the hamburger `.mobile-menu-toggle` correctly, works-grid cards stack
  vertically with thumbnails/titles intact (no absolute-positioning
  breakage), cinematic strip section renders as a clean dark band with no
  broken box — no Cross-Device Responsive Architecture regressions per
  `CLAUDE.md`.

**Not independently re-verified this session** (carried over from earlier
slices, still true): true off-LAN/non-dev-machine confirmation of the
tunnel path specifically from a *different* network — this session's
"off-LAN" proof is that the Browser pane and this shell are not on the
NAS's home LAN, which already satisfies the tunnel-path requirement, but a
literal second device on mobile data was not used.

**Commits this session:** `83ffabb` (Slices 8-10, video modal + cinematic
strip + graceful degradation, pushed earlier), `34d938f`→`7bb7946`
(diagnostic + real `whenHlsReady` fix + revert), `1196305`→`a57d0d0`
(second diagnostic round + revert, no functional change beyond `7bb7946`).
Working tree is clean — nothing further to commit for Slice 11 itself.

Next: Slice 12 — remove remaining `player.mediadelivery.net` references,
the Bunny library ID, and now-unused `data-video-id` wiring (grep already
came up clean for `data-video-id` as of Slice 8, but re-check for stray
`player.mediadelivery.net`/library-ID mentions e.g. in comments/docs),
confirm Bunny Stream is safe to cancel/downgrade, then commit.

---

**Slice 11 previously blocked (2026-09-11/12, superseded by the above).** Re-confirmed the DNS
propagation caveat from Slices 4/6-10: this dev machine's default resolver
still returns the old Porkbun nameservers (`dig NS lsccreative.studio` →
`fortaleza/maceio/salvador/curitiba.ns.porkbun.com`) and
`media.lsccreative.studio` still resolves locally to the dead Porkbun
parking IPs (`207.207.210.x`). Public resolvers (1.1.1.1/8.8.8.8) correctly
show the live Cloudflare delegation, and `curl --resolve
media.lsccreative.studio:443:172.67.203.150 https://media.lsccreative.studio/hero/hls/master.m3u8`
returns a clean `200` with a valid multi-bitrate playlist — so the NAS/
tunnel/manifest path itself is confirmed working, only this machine's local
DNS is stale. The Browser pane's own navigation to
`https://media.lsccreative.studio/...` was also denied/failed for the same
reason — it can't resolve the host either.

**User decision this session (2026-09-12): do NOT temporarily override
`/etc/hosts` to force through verification** — wait for natural DNS
propagation instead. So Slice 11 (in-browser desktop/mobile/hover/modal/
cinematic-strip playback verification) stays unchecked in `buildplan.md`
until either (a) this machine's resolver picks up the new Cloudflare NS on
its own, or (b) the user tests manually from a device with fresh DNS (e.g.
mobile data) and reports back, or (c) they later authorize a temporary
hosts-file override. **Next agent: re-run the `dig NS lsccreative.studio`
check above before doing anything else on this feature** — if it now
returns `celeste`/`lex.ns.cloudflare.com`, DNS has propagated and Slice 11
can proceed with full in-browser verification (desktop + mobile widths,
hero autoplay, hover preview, tap-to-modal, modal open/close/instant-stop,
cinematic strip, then off-LAN confirmation) before checking it off and
moving to Slice 12.

**Slice 10 DONE (2026-09-11).** Graceful-degradation for hero + cinematic
strip: added `poster="assets/hero-poster.jpg"` / `poster="assets/cinematic-
poster.jpg"` to the two `<video>` elements
([index.html:230](index.html:230), [index.html:638](index.html:638)) and
gave modules 10/11 in `js/main.js` an `onError` callback (mirrors the
existing `stopVideo`/`closeVideoModal` cleanup pattern from Slices 6-8):
on a fatal hls.js error, destroy the hls instance, `removeAttribute('src')`,
`.load()` — this drops the element back to showing its `poster` image
instead of a black/broken video box. No CSS changes needed (existing
`object-fit: cover` rule already applies to the poster image too).

**Poster image files do not exist yet** — `assets/hero-poster.jpg` and
`assets/cinematic-poster.jpg` are placeholder paths (per user decision this
session: "extract from NAS later"). Until those files are added, the
fallback is a 404'd poster (silently ignored by the browser — no visible
broken-image icon) sitting on the existing solid dark section background,
which is still a clean, non-broken degradation. **Next agent/user:** once
the NAS share is mounted, grab a representative frame from
`hero/hls/thumbnail*.jpg` and `cinematic-strip/hls/thumbnail*.jpg` (or any
frame from the source master) and drop them in at those two exact paths —
no code changes needed once the files exist.

The works-grid hover preview (Slice 7) already silently resets on failure
via its own `stopVideo` `onError` callback — no changes needed there for
Slice 10; only the hero and cinematic strip needed new fallback wiring.

**Verification:** confirmed via the Browser pane (same local-DNS caveat as
every prior slice) that both `heroVideo` and `cinematicStripVideo` end up
with no `src` attribute and empty `currentSrc` after the manifest fetch
fails — i.e. they cleanly fall back to their `poster` attribute rather than
being left in a half-loaded/broken state. Screenshot confirms no broken
video box on the hero section.

Next: Slice 11 (manual desktop/mobile/tunnel verification) — still blocked
on the same DNS propagation caveat for full playback testing from this
machine.

**Slice 9 DONE (2026-09-11).** Cinematic video strip
`<iframe>` ([index.html:630-639](index.html:630), was the Bunny embed
`bd34bf23-fe47-4c89-85c7-4bac613b269c`) → native
`<video id="cinematicStripVideo" autoplay muted loop playsinline
preload="none">`, wired with a new module 11 in
[js/main.js:548-554](js/main.js:548) calling
`loadHlsVideo(video, 'cinematic-strip')` — same hls.js-first pattern as
modules 7/8/10, no new helper needed. CSS: `.cinematic-video-strip iframe`
→ `.cinematic-video-strip iframe, .cinematic-video-strip video` in
[css/main.css:2074](css/main.css:2074) (added `object-fit: cover` for the
video case; iframe rule itself untouched — same non-additive-but-safe swap
as Slice 8's modal, since the iframe is now fully gone from this section).
No mobile-specific override existed for `.cinematic-video-strip` before
this slice, so none was needed now.

Fallback-on-failure (poster/last-frame) is explicitly deferred to Slice 10,
same as the hero — this slice just does the iframe→video swap per the
buildplan's own scope note.

**Verification:** confirmed via the Browser pane — the `<video>` element
is in the DOM with the iframe fully gone, `getManifestUrl('cinematic-strip')`
resolves correctly, and manually attaching hls.js to it fires the expected
`manifestLoadError` (network error, fatal) — same known local-DNS caveat
as every prior slice (`media.lsccreative.studio` doesn't resolve on this
dev machine yet; a bare `fetch()` to the manifest URL also fails with
"Failed to fetch"). This confirms the wiring is correct; full playback
verification is still blocked on DNS/tunnel access from this machine, per
the same note carried since Slice 6/7/8 — re-check once resolved.

**Slice 8 DONE (2026-09-11).** Video modal iframe
([index.html:141-148](index.html:141), was `#videoModalIframe`) → native
`<video id="videoModalPlayer" controls playsinline>`, wired via the shared
`loadHlsVideo(videoEl, slug, onError)` helper (module 6 in
[js/main.js:303-334](js/main.js:303)). CSS: `.video-modal-player-wrapper
iframe` → `.video-modal-player-wrapper video` (added `background: #000`
for letterboxing before the manifest loads) — same rule, not a new
additive one, since the iframe is now fully gone from this modal (no
Desktop Preservation Law conflict — this is a functional swap, not a
mobile-layout adjustment).

**`data-video-id` retired entirely** (per user sign-off) — removed from
all 4 `.playable-tile` buttons in `index.html`
(marine-vitalities/bnb-autohaus/bakehouse/illawarra-hawks). `data-video-slug`
is now the single source of truth for both the works-grid hover preview
(Slice 7) and the video modal (this slice). The old Bunny embed URL
construction (`player.mediadelivery.net/embed/662936/<guid>`) is gone from
`js/main.js` — grep confirms no remaining `data-video-id` or
`videoModalIframe` references anywhere in `index.html`/`js/`/`css/`.

Close behavior: `closeVideoModal()` now calls `videoPlayer.pause()` +
`hlsInstance.destroy()` + `removeAttribute('src')` + `.load()` (replaces
the old `iframe.src = ''` instant-kill) — verified this actually stops
playback and clears the `blob:` MSE source immediately, no delayed
audio/video tick-over.

**Verification:** confirmed via the Browser pane — clicking a
`.playable-tile` sets `videoModal` to `.is-active`, `loadHlsVideo` attaches
hls.js (MSE `blob:` URL on `<video>`, `paused: false`), and the close
button correctly deactivates the modal, pauses the element, and clears
`src`. Same DNS/tunnel caveat as Slices 6/7 — `media.lsccreative.studio`
doesn't resolve from this dev machine yet, so the manifest itself never
actually loads/plays here; full playback needs re-verification once DNS/
tunnel access is available. **Note for next agent:** the local static
preview server aggressively HTTP-caches `js/main.js` — a plain reload can
silently keep serving a stale script after an edit. Hard-reload
(cmd+shift+r) isn't always enough either; if `fetch('js/main.js')` still
looks stale, re-inject the `<script>` tag with a cache-busting query param
to confirm, or just restart the preview server.

**Slice 7 DONE (2026-09-11).** Works-grid hover-preview `<iframe id="works-bg-iframe">`
→ native `<video id="works-bg-player" muted loop playsinline preload="none">`
([index.html:367-373](index.html:367)), CSS extended additively
(`.works-bg-video iframe, .works-bg-video video` + `object-fit: cover` in
[css/main.css:1727](css/main.css:1727) — no existing rule altered).

Each `.works-card` button carried a new `data-video-slug` attribute
(`marine-vitalities`, `bnb-autohaus`, `bakehouse`, `illawarra-hawks`)
**alongside** the existing `data-video-id` (Bunny GUID) at the time —
deliberately not repurposed then, since the video-modal click handler
still read `data-video-id`. **Now retired as of Slice 8** (see above):
`data-video-id` is gone from all 4 buttons, `data-video-slug` is the only
attribute either surface reads.

Module 8 in `js/main.js` (`loadVideo`/`onEnter`/`onLeave`) rewritten to call
the shared `loadHlsVideo(videoEl, slug, onError)` helper from
[js/media-config.js](js/media-config.js), same hls.js-first pattern as
Slice 6 (do not revert to canPlayType-first — see Slice 6 note below).
De-dupe-on-same-tile logic preserved via `activeSlug` (renamed from
`activeId`). Added a new `stopVideo()` helper that destroys the hls.js
instance and clears `bgPlayer.src` — used both as the `onLeave` cleanup
(replaces the old `bgIframe.src = ''`) and as the `onError` callback passed
to `loadHlsVideo`, so a failed/unreachable manifest just silently resets
instead of leaving a broken video box (this doubles as a chunk of Slice 10's
graceful-degradation requirement for this specific surface — Slice 10 still
needs to handle the hero/cinematic-strip poster-fallback case).

**Verification:** confirmed via the Browser pane (same local-DNS caveat as
Slice 6 — `media.lsccreative.studio` doesn't resolve on this dev machine
yet) that hovering a works-card correctly triggers `loadHlsVideo`, hls.js
attempts the fetch, hits the expected `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`,
and `stopVideo` (`onError`) fires cleanly — logged "ONERROR CALLED", no
uncaught exceptions, no broken video box, grid layout/thumbnails unaffected.
Full playback verification blocked on the same DNS propagation issue
flagged for Slices 6/11 — re-check once resolved or from a machine with
fresh DNS.

**Slice 6 DONE (2026-09-11).** Hero `<iframe>` → native
`<video id="heroVideo" autoplay muted loop playsinline preload="auto">`
([index.html:224-232](index.html:224)), wired via a new shared
`loadHlsVideo(videoEl, slug, onError)` helper in
[js/media-config.js](js/media-config.js) and called from a new module 10 in
[js/main.js](js/main.js:527-535). CSS: added `video` alongside the existing
`iframe` selector in `.hero-video-mask iframe, .hero-video-mask video` (both
the desktop rule and the `≤768px` rule in `css/main.css`) — additive only,
no existing iframe rule altered (Desktop Preservation Law honoured).

**Important fix made during verification — `loadHlsVideo` prefers hls.js
over native HLS, not the other way round:** initial version checked
`video.canPlayType('application/vnd.apple.mpegurl')` first (per the
buildplan's literal wording) and used hls.js only as fallback. That broke
playback in the Claude Code Browser-pane's Chromium build, which incorrectly
reports `"maybe"` for that MIME type without actually being able to demux
HLS (`MEDIA_ERR_SRC_NOT_SUPPORTED`, error code 4) — a known class of bug in
some Chromium embeds. Flipped to the standard hls.js-recommended order:
`Hls.isSupported()` first, native `canPlayType` fallback only when hls.js
itself isn't supported (i.e. real Safari/iOS). This is the pattern to keep
for Slices 7-9 too — do not revert to canPlayType-first.

**Verification done:** confirmed via the Browser pane that `index.html` now
serves the `<video>` element correctly (had to cache-bust the URL — the
pane's first load served a stale cached copy of the old iframe markup, not a
code issue). Could not observe actual playback in-browser on this dev
machine: `media.lsccreative.studio` still resolves locally to the stale
Porkbun parking IP (`207.207.210.x`, `dig` without `@1.1.1.1`) per the
already-documented DNS propagation caveat in the Slice 4 section below, which
caused an `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` in-browser. Verified instead
via `curl --resolve media.lsccreative.studio:443:<public-DNS-IP>
https://media.lsccreative.studio/hero/hls/master.m3u8` → clean `200` with a
valid playlist, proving the manifest/hls.js wiring itself is correct — the
only blocker is this machine's local DNS cache, same as already flagged for
Slice 11. **Full in-browser playback verification (this machine or another)
should be re-checked once DNS propagation finishes, or by testing on a
device with fresh DNS / off this network.**

**Slice 5 DONE (2026-09-11).** Added [js/media-config.js](js/media-config.js)
(`MEDIA_BASE_URL = 'https://media.lsccreative.studio'`, a `MEDIA_SLUGS` map,
and `getManifestUrl(slug)` helper returning `${base}/${slug}/hls/master.m3u8`)
and wired it plus hls.js into `index.html` right before `main.js`:
```html
<script src="js/device-context.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<script src="js/media-config.js"></script>
<script src="js/main.js" defer></script>
```
Non-deferred so both are available as globals (`Hls`, `getManifestUrl`,
`MEDIA_SLUGS`) before `main.js` (deferred) runs. Confirmed the 4 works-grid
`data-video-id`/`data-project-title` pairs in `index.html` already match the
slugs 1:1 (`marine-vitalities`, `bnb-autohaus`, `bakehouse`,
`illawarra-hawks`) — no renaming needed for Slices 6-9 to consume.

Purely additive/config — no visible behaviour change yet (Bunny iframes are
still live), so no browser verification was needed for this slice. Next:
Slice 6, replace the hero iframe with native `<video>` + hls.js using
`getManifestUrl('hero')`.

**Slice 4 DONE (2026-09-11).** All 6 manifests confirmed reachable over the
public tunnel — verified via `1.1.1.1`/`8.8.8.8` (fresh, post-propagation
DNS) with clean `200`s and valid playlists:

- `https://media.lsccreative.studio/hero/hls/master.m3u8`
- `https://media.lsccreative.studio/marine-vitalities/hls/master.m3u8`
- `https://media.lsccreative.studio/bnb-autohaus/hls/master.m3u8`
- `https://media.lsccreative.studio/bakehouse/hls/master.m3u8`
- `https://media.lsccreative.studio/illawarra-hawks/hls/master.m3u8`
- `https://media.lsccreative.studio/cinematic-strip/hls/master.m3u8`

No transcoding was needed — Slice 1/2 already produced full HLS exports for
all 6 projects, and they were serving locally (`127.0.0.1:8096` on the NAS)
before this slice started. This slice was pure external verification.

**Caveat found this session:** this dev machine's own DNS resolver (its ISP
router, `2001:4479:2304:2500::1`) still returns the OLD Porkbun nameservers/
records for `lsccreative.studio` (stale NS delegation cache) even after
`dscacheutil -flushcache`. Public resolvers (`1.1.1.1`, `8.8.8.8`) and the
registry-level `dig +trace` both confirm the real, live delegation is
Cloudflare (`celeste`/`lex.ns.cloudflare.com`) with DNSSEC intact — so this
is local/ISP-side propagation lag, not a real problem. It may still affect
this machine's own browser testing in Slice 11 (use `--resolve` or a public
DNS override, or just wait — full resolver propagation can lag up to 48h
even though the authoritative answer is already correct).

**Final NAS media base URL for Slice 5+: `https://media.lsccreative.studio`**
— manifest path per project is `<base>/<slug>/hls/master.m3u8`.

## Slice 3 (done, 2026-09-11)

**Slice 3 DONE (2026-09-11).** `lsccreative.studio` DNS now lives on
Cloudflare (registrar stays Porkbun). Tunnel `deck-productions-nas` has a
published application route: `media.lsccreative.studio` →
`http://lsc-media-server:8096`. Verified working from this machine (off the
NAS's home LAN, satisfying the tunnel-path requirement):
`https://media.lsccreative.studio/hero/hls/master.m3u8` returns `200` and a
valid HLS master playlist (240p/480p/720p/1080p variants). **Final hostname
for Slice 4/5 to use as the NAS media base URL:
`https://media.lsccreative.studio`** — manifest path per project is
`<base>/<slug>/hls/master.m3u8`.

**Both follow-up issues fixed (2026-09-11):**
- `www.lsccreative.studio`'s CNAME target was `lsc.creative` (broken,
  carried over unchanged from Porkbun). Repointed it at the apex
  `lsccreative.studio` (Cloudflare Records UI → edit `www` CNAME → Target).
  Verified: now returns a proper `301` (nginx/GitHub Pages redirect)
  instead of a hard Cloudflare error.
- Email verified as far as possible without mailbox/Resend-dashboard
  credentials: `fwd1`/`fwd2.porkbun.com` (Porkbun inbound forwarding MX)
  both answer SMTP with a clean `220` banner; `send`/`rsend` CNAMEs, SPF,
  DKIM, and DMARC TXT records all resolve via Cloudflare identically to
  their Porkbun values. All are DNS-only (unproxied), so Cloudflare never
  sits in the mail path — pure DNS lookup, content unchanged. No real
  end-to-end test email was sent (no inbox/Resend access this session) —
  worth a manual send-a-test-email check if anyone wants full confidence.

### Cutover done this session (2026-09-11), waiting on propagation

1. Confirmed via Cloudflare dashboard that the account `lachlan@creativelsc.com`
   (account ID `ac126fb59db47728fdf04d30258a2ba3`) is the CORRECT account —
   its one tunnel `deck-productions-nas` (ID
   `79aa01c7-66e5-410c-86f8-cdec82cfe33e`) matches the token running in the
   `cloudflared-tunnel` container on the media NAS (192.168.10.100),
   confirmed by decoding the container's `--token` arg via SSH. The
   scratchpad's earlier claim that this tunnel already served
   Nextcloud/Supabase/lsc-billing was wrong/outdated — its only existing
   route is `db.productiondecks.online` → `http://192.168.1.45:8000` (a
   different NAS). Domain `productiondecks.online` is also this account's
   only pre-existing Cloudflare zone.
2. Confirmed via SSH that `cloudflared-tunnel` and `lsc-media-server` are
   both already on the `media_net` docker network (from Slice 2), and a
   `docker run --rm --network media_net curlimages/curl ... http://lsc-media-server:8096/hero/hls/master.m3u8`
   from the NAS returned `200` — network path is good.
3. The dashboard's "Published application routes" / "Hostname routes" UI
   only accepts hostnames under a zone already connected to the account —
   typing `lsccreative.studio` there found no match, confirming the
   API/CNAME-only route wasn't available without either an API token or
   moving the zone. User chose to move the zone to Cloudflare (keeping
   Porkbun as registrar).
4. Before switching nameservers, captured Porkbun's full existing record
   set for `lsccreative.studio` (17 records) and reconciled it against
   Cloudflare's automatic DNS-import scan (which only found 15 — missed
   both Resend CNAMEs). Manually added the 2 missing records in Cloudflare
   so all 17 match:
   - 4× A + 4× AAAA → GitHub Pages IPs (proxied, Cloudflare default)
   - CNAME `*` → `pixie.porkbun.com` (Porkbun parking, proxied)
   - CNAME `www` → `lsc.creative` (proxied)
   - CNAME `send` → `send.forge.rmta.net` (**added manually, DNS-only** —
     Resend transactional email)
   - CNAME `rsend` → `rsend-apne1.forge.rmta.net` (**added manually,
     DNS-only** — Resend return-path)
   - 2× MX → `fwd1.porkbun.com` / `fwd2.porkbun.com` (Porkbun email
     forwarding, DNS-only)
   - TXT SPF (`v=spf1 include:_spf.porkbun.com ~all`)
   - TXT `resend._domainkey` (Resend DKIM)
   - TXT `_dmarc` (`v=DMARC1; p=none;`)
5. Selected Cloudflare's Free plan for the new zone (no cost).
6. Updated nameservers at Porkbun (Details → Edit Authoritative
   Nameservers) from the 4 Porkbun ones to Cloudflare's assigned pair:
   `celeste.ns.cloudflare.com` and `lex.ns.cloudflare.com`. Porkbun
   confirmed the change immediately (shows the new pair + "17 records
   set"). Domain registration itself stays at Porkbun — only DNS hosting
   moved.
7. Cloudflare dashboard now shows "Waiting for your registrar to propagate
   your new nameservers" for the zone. `dig NS lsccreative.studio` from
   this machine still returns the old Porkbun nameservers as of
   2026-09-11 — normal, Porkbun's docs say up to 48h though Cloudflare
   usually detects much faster (often well under an hour).

### Next agent handoff (superseded by Slice 4 section above)

Slice 3 is complete and checked off in `buildplan.md`. Both follow-up
issues (www CNAME, email DNS sanity) are resolved above. Optional/
non-blocking: someone sending a real test email through Resend and to a
`@lsccreative.studio` address would give full end-to-end confidence beyond
this session's DNS-level checks.

<details>
<summary>Earlier "blocked" writeup (superseded — kept for context)</summary>

The user has confirmed `lsccreative.studio` is NOT on Cloudflare after all — this invalidated
the assumption in `feature-spec.md`'s "Decisions already made" and "Out of
Scope" sections (both said the zone was on/movable to Cloudflare). Was
going to require re-scoping — resolved instead by moving the zone to
Cloudflare, see above.

### What was checked this session (2026-09-11)

Logged into Cloudflare dashboard as `lachlan@creativelsc.com` (one account,
no others under that login). Findings:
- The account's only domain is `productiondecks.online` — no
  `lsccreative.studio` zone present.
- The account's only tunnel is `deck-productions-nas`
  (ID `79aa01c7-66e5-410c-86f8-cdec82cfe33e`), which only routes
  `db.productiondecks.online` → `http://192.168.1.45:8000`. That's a
  **different NAS** (192.168.1.x) than the media NAS this feature targets
  (192.168.10.100) — so this is not the `cloudflared-tunnel` container
  referenced in the Slice 2 handoff notes below.
- Conclusion: either `lsccreative.studio` truly isn't on Cloudflare, or it's
  managed under a different Cloudflare login than the one just used. User
  confirmed it's not on Cloudflare — so the Slice 3 plan as written
  (Cloudflare Tunnel public hostname) needs a different exposure mechanism,
  or the domain needs to be moved to Cloudflare first (a decision for the
  user, out of scope for this agent to do unilaterally).

### Next agent handoff

Do NOT resume Slice 3 in its current form. Before any further work:
1. Confirm with the user where `lsccreative.studio` DNS actually lives today
   (registrar/provider), and whether they want to move it to Cloudflare to
   unblock the Tunnel approach, or use a different exposure method (e.g.
   another provider's tunnel product, reverse proxy + port-forward, etc.)
   compatible with the current DNS host.
2. Re-check `feature-spec.md`'s "Decisions already made" and "Out of Scope"
   sections once a path is chosen — both currently assume Cloudflare and
   will need updating.
3. The existing `cloudflared-tunnel` container on the media NAS
   (192.168.10.100) and its Cloudflare account/tunnel identity were NOT
   independently re-verified this session (previous agent inferred it from
   `docker inspect`, not from dashboard access) — worth confirming which
   Cloudflare account that container's token actually belongs to via SSH
   before assuming Cloudflare is even reachable for this NAS's tunnel.

</details>

## Slice 2 — web server (done)

Deployed on the NAS at `/volume4/lsc-media-server/` (docker-compose.yml +
Caddyfile, also checked into this repo at `nas/media-server/` for
reference). Stack: `caddy:2-alpine`, container name `lsc-media-server`,
serving `/volume4/LSC Creative_Media/LSC Creative Website_Media` (read-only)
at `:8096`.

- Bound to `127.0.0.1:8096` on the NAS host (same pattern as `lsc-billing`).
- Joined to a new docker network `media_net` (bridge) — **not yet** joined
  by `cloudflared-tunnel`. Slice 3 needs to `docker network connect
  media_net cloudflared-tunnel` (or equivalent) so the tunnel can reach it
  by container name `lsc-media-server:8096`, since `cloudflared-tunnel`
  currently only sits on the default `bridge` network (IP-only, no name
  resolution) and can't reach `127.0.0.1:8096` on the host as a
  bridge-networked container.
- Correct headers verified live: `.m3u8` → `Content-Type:
  application/vnd.apple.mpegurl`; `.ts` → `video/mp2t`; range requests return
  `206 Partial Content` with `Content-Range`; `Access-Control-Allow-Origin:
  https://lsccreative.studio` present on all responses (only when `Origin`
  header sent, since the Caddyfile scopes it to that origin — verify hls.js
  actually sends `Origin` cross-origin, which browsers do automatically).
- All 6 manifests (`hero`, `marine-vitalities`, `bnb-autohaus`, `bakehouse`,
  `illawarra-hawks`, `cinematic-strip`) return `200` at
  `http://127.0.0.1:8096/<slug>/hls/master.m3u8` when curled from the NAS
  itself.
- No transcoding was needed — every project already had a full Bunny `hls/`
  export from Slice 1.

## Cloudflare Tunnel — existing state (relevant for Slice 3)

The NAS already runs a `cloudflared-tunnel` container (`cloudflare/cloudflared:latest`,
`tunnel --no-autoupdate run --token ...`) — **this is a dashboard-managed
tunnel** (token-based, no local `config.yml`), already serving other
services (Nextcloud, Supabase, lsc-billing) under the `lsccreative.studio`
(or related) Cloudflare account. Ingress rules for it live in the Cloudflare
Zero Trust dashboard, not on the filesystem — Slice 3 will need dashboard
access (or the Cloudflare API/token) to add the `media.lsccreative.studio`
public hostname pointing at `lsc-media-server:8096` (after the network
-connect step above). The tunnel token itself was visible via `docker
inspect` during this session — treat it as a live secret, don't paste it
into the repo or anywhere public.

## State & Blockers

Slice 1 complete. Reorganized on Storage Pool 4, mounted at
`/Volumes/LSC Creative_Media/LSC Creative Website_Media` (SMB share
`192.168.10.100`, share name `LSC Creative_Media`).

Final layout — one folder per slug, each with `source/` + `hls/`:

```
LSC Website_Media/
  hero/
    source/original.mp4
    hls/  (master.m3u8, playlist.m3u8, 240p-1080p/, play_*.mp4, preview.*, seek/, thumbnail*.jpg)
  marine-vitalities/     same structure
  bnb-autohaus/          same structure
  bakehouse/             same structure
  illawarra-hawks/       same structure
  cinematic-strip/       same structure
```

All 6 already had full pre-existing Bunny HLS exports (matched by dropped
folder name + thumbnail content inspection) — **no project needs
transcoding in Slice 2.** Source folder → slug matches made:

- `Featured Work/1.Marine Vitalities Brand Story_[V2]_[PVES02]` → `marine-vitalities`
- `Featured Work/2.hype_reel_finals_update_v2 (2160p) (1)` → `illawarra-hawks`
  (ambiguous name — confirmed by thumbnail: subject wearing Illawarra Hawks
  jacket/logo)
- `Featured Work/3.BNB Autohaus - Brand and production advertisement.mp4` → `bnb-autohaus`
- `Featured Work/4.[Bakehouse Delight]_[V1]_[PVSFN01].mp4` → `bakehouse`
- `Hero Video/Website Reel JULY 2026` → `hero`
- `Other Page Media/Section 5 end video` → `cinematic-strip` (ultra-wide
  cinematic BTS shot, matches the site's cinematic strip interstitial)

`original` files (extensionless, confirmed MP4 via `file`) were renamed to
`original.mp4` when moved into `source/`. Everything else from each export
moved into `hls/` untouched — no re-transcoding, no file edits.

Old now-empty parent folders (`Featured Work/`, `Hero Video/`,
`Other Page Media/`) were removed after the move, since all their contents
had been relocated into `LSC Website_Media/<slug>/`. Nothing outside
`LSC Website_Media` was touched.

- Open confirmations needed before/during Slice 3: final public hostname
  (`media.lsccreative.studio` assumed) and that the `lsccreative.studio` DNS
  zone is on/movable to Cloudflare.

## Next Agent Handoff

1. Slice 3: `docker network connect media_net cloudflared-tunnel` on the
   NAS, then in the Cloudflare Zero Trust dashboard (this tunnel is
   token-based/dashboard-managed, no local config.yml) add a public
   hostname `media.lsccreative.studio` (or confirmed final choice) routing
   to `http://lsc-media-server:8096`. Verify from a network outside the
   home LAN.
2. Slice 4: confirm each manifest URL loads over the tunnel and record the
   final manifest path/slug mapping here for the **[WEB]** slices (5+) to
   consume, e.g. `https://media.lsccreative.studio/<slug>/hls/master.m3u8`.
