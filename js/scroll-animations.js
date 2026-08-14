/* Scroll-reveal engine — Phase 3.
   Adds .reveal-active to any .reveal element as it enters the viewport,
   honouring an optional data-reveal-delay (ms) for staggering. Elements
   are unobserved after firing so no scroll-path work remains; the CSS
   side animates opacity/transform only (compositor thread, 60fps).
   Independent of the two observers in main.js (.animate-entrance,
   .proc-reveal) — do not merge them. */
(function () {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;

    function activate(el) {
        var delay = parseInt(el.getAttribute('data-reveal-delay'), 10) || 0;
        if (delay) el.style.transitionDelay = delay + 'ms';
        el.classList.add('reveal-active');
    }

    if (!('IntersectionObserver' in window)) {
        els.forEach(activate);
        return;
    }

    var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                activate(entry.target);
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -10% 0px' });

    els.forEach(function (el) { observer.observe(el); });
})();
