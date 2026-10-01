/* FAQ page — accordion, deep links, chapter index, HUD timecode.
   Self-contained: the home page's main.js (preloader, goo nav) is not loaded here. */
(function () {
    'use strict';

    var items = Array.prototype.slice.call(document.querySelectorAll('.faq-item'));

    function setOpen(item, open) {
        var btn = item.querySelector('.faq-trigger');
        item.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    items.forEach(function (item) {
        item.querySelector('.faq-trigger').addEventListener('click', function () {
            setOpen(item, !item.classList.contains('is-open'));
        });
    });

    /* Deep link: faq.html#q-revision-rounds opens (and scrolls to) that answer.
       No hash → first question open, so the page reads as interactive. */
    function openFromHash() {
        var id = decodeURIComponent(location.hash.slice(1));
        var target = id && document.getElementById(id);
        if (target && target.classList.contains('faq-item')) {
            setOpen(target, true);
            target.scrollIntoView({ block: 'start', behavior: 'instant' });
            return true;
        }
        return false;
    }
    if (!openFromHash() && items.length) setOpen(items[0], true);
    window.addEventListener('hashchange', openFromHash);
    /* Web fonts reflow the page after first paint — re-aim the deep link once they land. */
    if (location.hash && document.fonts && document.fonts.ready) {
        document.fonts.ready.then(openFromHash);
    }

    /* Chapter index — highlight the chapter currently crossing the upper third. */
    var links = Array.prototype.slice.call(document.querySelectorAll('.faq-rail-link'));
    var chapters = Array.prototype.slice.call(document.querySelectorAll('.faq-chapter'));

    function activate(id) {
        links.forEach(function (a) {
            var on = a.getAttribute('data-target') === id;
            a.classList.toggle('is-active', on);
            if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
            /* keep the active chip visible in the mobile strip, without moving the page */
            if (on && a.parentNode.parentNode.scrollWidth > a.parentNode.parentNode.clientWidth) {
                var strip = a.parentNode.parentNode;
                strip.scrollTo({ left: a.offsetLeft - 24, behavior: 'smooth' });
            }
        });
    }

    if (chapters.length && 'IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) { if (en.isIntersecting) activate(en.target.id); });
        }, { rootMargin: '-25% 0px -65% 0px' });
        chapters.forEach(function (c) { io.observe(c); });
        activate(chapters[0].id);
    }

    /* HUD timecode — same 24fps readout as the home page. */
    var tc = document.getElementById('live-timecode');
    if (tc) {
        var pad = function (n) { return String(n).padStart(2, '0'); };
        (function tick() {
            var d = new Date();
            tc.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' +
                             pad(d.getSeconds()) + ':' + pad(Math.floor(d.getMilliseconds() / 40));
            requestAnimationFrame(tick);
        })();
    }
})();
