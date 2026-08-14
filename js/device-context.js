/* Device context detection — toggles .is-mouse / .is-touch on <body>.
   Hover-dependent styles must be scoped under body.is-mouse so touch
   devices never receive sticky hover states. Uses hover/pointer media
   queries (not touch sniffing) so hybrids like iPad+trackpad update
   live when the input mode changes. */
(function () {
    var mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    function applyDeviceContext(isMouse) {
        document.body.classList.toggle('is-mouse', isMouse);
        document.body.classList.toggle('is-touch', !isMouse);
    }
    applyDeviceContext(mq.matches);
    if (mq.addEventListener) {
        mq.addEventListener('change', function (e) { applyDeviceContext(e.matches); });
    } else {
        mq.addListener(function (e) { applyDeviceContext(e.matches); });
    }
})();
