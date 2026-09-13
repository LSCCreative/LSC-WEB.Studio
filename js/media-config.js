// Self-hosted NAS media config — replaces the old Bunny Stream library ID + GUID scheme.
// Manifest path convention: `${MEDIA_BASE_URL}/${slug}/hls/master.m3u8`.
const MEDIA_BASE_URL = 'https://media.lsccreative.studio';

const MEDIA_SLUGS = {
    hero: 'hero',
    'marine-vitalities': 'marine-vitalities',
    'bnb-autohaus': 'bnb-autohaus',
    bakehouse: 'bakehouse',
    'illawarra-hawks': 'illawarra-hawks',
    'cinematic-strip': 'cinematic-strip',
};

function getManifestUrl(slug) {
    return `${MEDIA_BASE_URL}/${MEDIA_SLUGS[slug]}/hls/master.m3u8`;
}

// Guards against a slow/blocked hls.js CDN load: callers that fire at page
// load (autoplaying hero/cinematic-strip video) can otherwise run before the
// CDN <script> has finished, see `Hls` as undefined, and wrongly fall through
// to loadHlsVideo's native canPlayType() branch — which Chromium falsely
// reports "maybe" for HLS without being able to actually demux it. Waits for
// the CDN script's load/error event when `Hls` isn't defined yet; calls back
// immediately otherwise.
function whenHlsReady(cb) {
    if (typeof Hls !== 'undefined') { cb(); return; }
    var script = document.getElementById('hlsjs-cdn');
    if (!script) { cb(); return; }
    script.addEventListener('load', cb, { once: true });
    script.addEventListener('error', cb, { once: true });
}

// Attaches an HLS manifest to a <video> element — native HLS on Safari/iOS,
// hls.js everywhere else. Returns the Hls instance (or null on native/error)
// so callers can detach it later (e.g. on modal close). onError fires once
// the source has definitively failed to load (network/tunnel down).
function loadHlsVideo(videoEl, slug, onError) {
    var src = getManifestUrl(slug);

    // hls.js (MSE-based) first — it's the reliable path everywhere it runs.
    // Native canPlayType() is used only as the fallback for browsers hls.js
    // doesn't support (real Safari/iOS), since some browsers report "maybe"
    // for the HLS MIME type without actually demuxing it correctly.
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        var hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(videoEl);
        window.__loadHlsVideoDebug = { branch: 'hlsjs', src: src };
        if (onError) {
            hls.on(Hls.Events.ERROR, function (event, data) {
                window.__loadHlsVideoDebug.lastError = { type: data.type, details: data.details, fatal: data.fatal };
                if (data.fatal) onError();
            });
        }
        return hls;
    }

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        window.__loadHlsVideoDebug = { branch: 'native', src: src };
        videoEl.src = src;
        if (onError) {
            videoEl.addEventListener('error', function handler() {
                videoEl.removeEventListener('error', handler);
                onError();
            });
        }
        return null;
    }

    window.__loadHlsVideoDebug = { branch: 'onErrorImmediate', src: src };
    if (onError) onError();
    return null;
}
