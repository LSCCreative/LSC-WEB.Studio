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
        if (onError) {
            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) { window.__hlsFatalDebug = data; onError(); }
            });
        }
        return hls;
    }

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = src;
        if (onError) {
            videoEl.addEventListener('error', function handler() {
                videoEl.removeEventListener('error', handler);
                onError();
            });
        }
        return null;
    }

    if (onError) onError();
    return null;
}
