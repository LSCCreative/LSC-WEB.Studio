# Scratchpad

> High-frequency memory zone. Wiped clean when the current feature merges to
> main. Keep this brutally current — overwrite, don't append history.

## Current Focus

**Slice 7 DONE (2026-09-11).** Works-grid hover-preview `<iframe id="works-bg-iframe">`
→ native `<video id="works-bg-player" muted loop playsinline preload="none">`
([index.html:367-373](index.html:367)), CSS extended additively
(`.works-bg-video iframe, .works-bg-video video` + `object-fit: cover` in
[css/main.css:1727](css/main.css:1727) — no existing rule altered).

Each `.works-card` button now carries a new `data-video-slug` attribute
(`marine-vitalities`, `bnb-autohaus`, `bakehouse`, `illawarra-hawks`)
**alongside** the existing `data-video-id` (Bunny GUID) — deliberately did
NOT repurpose `data-video-id` itself, since the video-modal click handler
(module 6 in `js/main.js`, Slice 8's job) still reads `data-video-id` to
build the Bunny iframe URL and would break if it were overwritten with a
slug this slice. Slice 8 should either add its own switch to
`loadHlsVideo(..., slug)` reading `data-video-slug`, or fully retire
`data-video-id` at that point once the modal is also converted.

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
