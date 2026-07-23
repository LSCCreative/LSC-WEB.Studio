/* ============================================================
   LSC CREATIVE — PRODUCTION SCRIPT (Rebuild 2026-06)
   Live modules only — dead engines from V3 removed.
   1. Global Camera HUD — live timecode
   2. Cinematic focus meter (desktop pointer)
   3. Navbar state + entrance reveals + smooth anchor scroll
   4. Mobile navigation drawer
   5. About modal + fractal glass turbulence
   6. Video modal (works cards)
   7. Intake form modal
   8. Works section — hover background preview (desktop)
   9. Process section — reveal + hover display panel
   ============================================================ */

/* ── 0. INK-GRID PRELOADER — L → S → C morph + fade on load ── */
(function () {
    var stage = document.getElementById('lscPreStage');
    var mask  = document.getElementById('cinematicLoader');
    if (!stage || !mask) return;

    /* 5×7 letter bitmaps (1 = active dark square) */
    /* bold 6x7 glyphs, 2-cell-thick strokes, fully orthogonally connected
       so the goo filter fuses each stroke into one continuous ink shape */
    var LETTERS = {
        L: ["110000", "110000", "110000", "110000", "110000", "111111", "111111"],
        S: ["111111", "110000", "110000", "111111", "000011", "000011", "111111"],
        C: ["111111", "110000", "110000", "110000", "110000", "110000", "111111"]
    };
    var SEQUENCE = ["L", "S", "C"];
    var COLS = 6, ROWS = 7;

    function cellsOf(map) {
        var out = [];
        for (var r = 0; r < ROWS; r++)
            for (var c = 0; c < COLS; c++)
                if (map[r][c] === "1") out.push({ c: c, r: r });
        return out;
    }
    var LAYOUTS = SEQUENCE.map(function (k) { return cellsOf(LETTERS[k]); });
    var POOL = Math.max.apply(null, LAYOUTS.map(function (l) { return l.length; }));

    var css     = getComputedStyle(mask);
    /* --pre-cell is a clamp() expression, so parseFloat() can't read it —
       derive the resolved cell size from the stage's rendered width. */
    var cell    = stage.getBoundingClientRect().width / COLS;
    var stagger = parseFloat(css.getPropertyValue('--pre-stagger')) || 18;
    var morph   = parseFloat(css.getPropertyValue('--pre-morph'))   || 900;
    var HOLD    = 600;   /* ms each letter holds before morphing (3s total) */

    /* keep cell size correct across orientation / resize changes */
    window.addEventListener('resize', function () {
        cell = stage.getBoundingClientRect().width / COLS;
        render(prevLayout, prevMap);
    });

    /* build the square pool once */
    var squares = [];
    for (var i = 0; i < POOL; i++) {
        var el = document.createElement('div');
        el.className = 'lsc-pre__cell';
        stage.appendChild(el);
        squares.push(el);
    }

    /* greedy nearest-neighbour: each square flows to the closest target
       in the next layout, so transitions slide rather than hard-cut */
    function assign(prev, next) {
        var used = new Array(next.length);
        return prev.map(function (p) {
            var best = -1, bestD = Infinity;
            for (var j = 0; j < next.length; j++) {
                if (used[j]) continue;
                var dx = p.c - next[j].c, dy = p.r - next[j].r, d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = j; }
            }
            if (best >= 0) used[best] = true;
            return best;
        });
    }

    /* current on-screen cell of each pool square (parked at centre if idle) */
    function poolCells(layout, map) {
        return squares.map(function (_, i) {
            var t = map ? map[i] : i;
            return (t != null && t >= 0 && layout[t]) ? layout[t] : { c: 2, r: 3 };
        });
    }

    function render(layout, map) {
        for (var i = 0; i < POOL; i++) {
            var s = squares[i];
            var target = map ? map[i] : i;
            var t = (target != null && target >= 0) ? layout[target] : null;
            s.style.transitionDelay = (i * stagger) + 'ms';
            if (t) {
                s.style.setProperty('--x', (t.c * cell) + 'px');
                s.style.setProperty('--y', (t.r * cell) + 'px');
                s.style.setProperty('--s', 1);
                s.style.opacity = 1;
            } else {
                s.style.setProperty('--s', 0);   /* dissolve into the lane */
                s.style.opacity = 0;
            }
        }
    }

    /* Play L -> S -> C once, holding each letter. C then stays on screen
       until the page is ready, so the full sequence ALWAYS plays through
       and the fade always begins from the final letter. */
    var prevLayout = LAYOUTS[0], prevMap = null;
    render(LAYOUTS[0], null);                       /* L visible immediately */

    for (var k = 1; k < LAYOUTS.length; k++) {
        (function (idx) {
            setTimeout(function () {
                var layout = LAYOUTS[idx];
                var map = assign(poolCells(prevLayout, prevMap), layout);
                render(layout, map);
                prevLayout = layout; prevMap = map;
            }, idx * (HOLD + morph));
        })(k);
    }
    /* time at which the last letter (C) has rendered and finished its hold */
    var SEQ_END = (LAYOUTS.length - 1) * (HOLD + morph) + HOLD;

    /* secondary progress bar — creeps while loading, snaps to 100% on dismiss */
    var bar = document.getElementById('lscPreBar');
    var pct = 0;
    var creep = setInterval(function () {
        pct = Math.min(pct + Math.random() * 6, 92);
        if (bar) bar.style.width = pct + '%';
    }, 260);

    var loaded = false, seqDone = false, done = false;
    function dismiss() {
        if (done) return; done = true;
        clearInterval(creep);
        if (bar) bar.style.width = '100%';
        setTimeout(function () { mask.classList.add('is-loaded'); }, 320);
    }
    function maybeDismiss() { if (loaded && seqDone) dismiss(); }

    setTimeout(function () { seqDone = true; maybeDismiss(); }, SEQ_END);

    function onReady() { loaded = true; maybeDismiss(); }
    if (document.readyState === 'complete') onReady();
    else window.addEventListener('load', onReady);

    /* safety net: never trap the user if 'load' stalls past the sequence */
    setTimeout(function () { seqDone = true; loaded = true; dismiss(); }, 12000);
})();

/* ── 1. GLOBAL CAMERA HUD — LIVE TIMECODE (24fps simulation) ── */
(function () {
    var el = document.getElementById('live-timecode');
    if (!el) return;
    function tick() {
        var now = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        el.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' +
                         pad(now.getSeconds()) + ':' + pad(Math.floor(now.getMilliseconds() / 40));
        requestAnimationFrame(tick);
    }
    tick();
})();

/* ── 2. CINEMATIC FOCUS METER — pointer-follow (desktop) ── */
(function () {
    var focusMeter = document.getElementById('focusMeter');
    if (!focusMeter) return;
    var mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
    var meterX = mouseX, meterY = mouseY;
    window.addEventListener('mousemove', function (e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });
    (function animate() {
        meterX += (mouseX - meterX) * 0.08;
        meterY += (mouseY - meterY) * 0.08;
        focusMeter.style.transform = 'translate(' + meterX + 'px,' + meterY + 'px) translate(-50%,-50%)';
        requestAnimationFrame(animate);
    })();
})();

/* ── 3. NAVBAR STATE + ENTRANCE REVEALS + SMOOTH ANCHORS ── */
(function () {
    var header = document.querySelector('.navbar');
    function headerState() {
        if (!header) return;
        header.classList.toggle('scrolled', window.scrollY > 20);
    }
    headerState();
    window.addEventListener('scroll', headerState, { passive: true });

    var revealEls = document.querySelectorAll('.animate-entrance');
    if ('IntersectionObserver' in window) {
        var obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    obs.unobserve(entry.target);
                }
            });
        }, { threshold: 0.2 });
        revealEls.forEach(function (el) { obs.observe(el); });
    } else {
        revealEls.forEach(function (el) { el.classList.add('visible'); });
    }

    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            var targetId = anchor.getAttribute('href');
            if (targetId.length > 1 && document.querySelector(targetId)) {
                e.preventDefault();
                document.querySelector(targetId).scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
})();

/* ── 4. MOBILE NAVIGATION DRAWER ── */
(function () {
    var toggle   = document.getElementById('mobileMenuToggle');
    var navLinks = document.querySelector('.nav-links.absolute-nav');
    if (!toggle || !navLinks) return;
    function alignMenu() {
        var rect = toggle.getBoundingClientRect();
        navLinks.style.right = (window.innerWidth - rect.right) + 'px';
    }
    function openMenu() {
        alignMenu();
        navLinks.classList.add('is-active');
        toggle.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
        navLinks.classList.remove('is-active');
        toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        navLinks.classList.contains('is-active') ? closeMenu() : openMenu();
    });
    navLinks.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function (e) {
            var href = link.getAttribute('href');
            if (link.id === 'aboutNavBtn') { closeMenu(); return; }
            if (href && href.startsWith('#') && href.length > 1) {
                e.preventDefault();
                closeMenu();
                setTimeout(function () {
                    var target = document.querySelector(href);
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 180);
            } else {
                closeMenu();
            }
        });
    });
    document.addEventListener('click', function (e) {
        if (!navLinks.contains(e.target) && e.target !== toggle) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeMenu();
    });
})();

/* ── 5. ABOUT MODAL + FRACTAL GLASS TURBULENCE ── */
(function () {
    var overlay  = document.getElementById('aboutModal');
    var openBtn  = document.getElementById('aboutNavBtn');
    var closeBtn = document.getElementById('aboutCloseBtn');
    if (!overlay) return;
    function openModal()  { overlay.classList.add('is-open');    document.body.style.overflow = 'hidden'; }
    function closeModal() { overlay.classList.remove('is-open'); document.body.style.overflow = ''; }
    if (openBtn)  openBtn.addEventListener('click', function (e) { e.preventDefault(); openModal(); });
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeModal();
    });

    /* Animated feTurbulence — runs only while the modal is open */
    var turbulence = document.getElementById('fractalTurbulence');
    if (!turbulence) return;
    var rafId = null, t = 0;
    function tick() {
        t += 0.003;
        turbulence.setAttribute('baseFrequency',
            (0.009 + Math.sin(t * 0.55) * 0.004).toFixed(6) + ' ' +
            (0.013 + Math.cos(t * 0.85) * 0.006).toFixed(6));
        rafId = requestAnimationFrame(tick);
    }
    new MutationObserver(function () {
        if (overlay.classList.contains('is-open')) {
            if (!rafId) { t = 0; tick(); }
        } else if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
})();

/* ── 6. CINEMATIC VIDEO MODAL — works cards ── */
(function () {
    var videoModal  = document.getElementById('videoModal');
    var videoIframe = document.getElementById('videoModalIframe');
    var videoTitle  = document.getElementById('videoModalTitle');
    var closeBtn    = document.getElementById('videoModalCloseBtn');
    if (!videoModal || !videoIframe) return;
    function openVideoModal(videoId, projectTitle) {
        videoIframe.src = 'https://player.mediadelivery.net/embed/662936/' + videoId + '?autoplay=true';
        if (videoTitle) videoTitle.textContent = projectTitle;
        videoModal.classList.add('is-active');
        document.body.style.overflow = 'hidden';
    }
    function closeVideoModal() {
        videoModal.classList.remove('is-active');
        videoIframe.src = '';                       /* kill stream + audio instantly */
        document.body.style.overflow = '';
    }
    document.querySelectorAll('.playable-tile').forEach(function (tile) {
        tile.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var videoId = tile.getAttribute('data-video-id');
            if (videoId) openVideoModal(videoId, tile.getAttribute('data-project-title') || 'Project Film');
        });
    });
    if (closeBtn) closeBtn.addEventListener('click', closeVideoModal);
    videoModal.addEventListener('click', function (e) { if (e.target === videoModal) closeVideoModal(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && videoModal.classList.contains('is-active')) closeVideoModal();
    });
})();

/* ── 7. INTAKE FORM MODAL ── */
(function () {
    var formModal = document.getElementById('contactFormModal');
    var openBtn   = document.getElementById('contactEnquiryBtn');
    var navBtn    = document.getElementById('navEnquiryBtn');
    var closeBtn  = document.getElementById('contactFormCloseBtn');
    if (!formModal) return;
    function openModal()  { formModal.classList.add('is-active');    document.body.style.overflow = 'hidden'; }
    function closeModal() { formModal.classList.remove('is-active'); document.body.style.overflow = ''; }
    if (openBtn)  openBtn.addEventListener('click', function (e) { e.preventDefault(); openModal(); });
    if (navBtn)   navBtn.addEventListener('click', function (e) { e.preventDefault(); openModal(); });
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    formModal.addEventListener('click', function (e) { if (e.target === formModal) closeModal(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && formModal.classList.contains('is-active')) closeModal();
    });
})();

/* ── 8. WORKS — HOVER → FULL-SECTION MUTED VIDEO PREVIEW (desktop) ── */
(function () {
    var section  = document.getElementById('portfolio');
    var bgVideo  = document.getElementById('works-bg-video');
    var bgIframe = document.getElementById('works-bg-iframe');
    if (!section || !bgVideo || !bgIframe) return;
    var grid  = section.querySelector('.works-grid');
    var cards = section.querySelectorAll('.works-card');
    if (!grid || !cards.length) return;
    var activeId = null, leaveTimer = null, LIB = '662936';
    function loadVideo(videoId) {
        if (videoId === activeId) return;
        activeId = videoId;
        bgIframe.src = 'https://player.mediadelivery.net/embed/' + LIB + '/' + videoId +
                       '?autoplay=true&loop=true&muted=true&preload=true&responsive=true&controls=false';
    }
    function onEnter() {
        if (!document.body.classList.contains('is-mouse')) return;   /* touch: tap plays modal, no bg preview */
        clearTimeout(leaveTimer);
        var videoId = this.dataset.videoId;
        if (videoId) loadVideo(videoId);
        bgVideo.style.opacity = '1';
        grid.classList.add('has-hover');
        document.body.classList.add('works-hovered');
        cards.forEach(function (c) { c.classList.remove('is-hovered'); });
        this.classList.add('is-hovered');
    }
    function onLeave() {
        if (!document.body.classList.contains('is-mouse')) return;
        leaveTimer = setTimeout(function () {
            grid.classList.remove('has-hover');
            document.body.classList.remove('works-hovered');
            bgVideo.style.opacity = '0';
            cards.forEach(function (c) { c.classList.remove('is-hovered'); });
            setTimeout(function () {
                if (!grid.classList.contains('has-hover')) {
                    bgIframe.src = '';
                    activeId = null;
                }
            }, 600);   /* clear src after fade completes */
        }, 80);        /* grace period — next card's mouseenter cancels */
    }
    cards.forEach(function (card) {
        card.addEventListener('mouseenter', onEnter);
        card.addEventListener('mouseleave', onLeave);
    });
})();

/* ── 9. PROCESS — SCROLL REVEAL + HOVER DISPLAY PANEL ── */
(function () {
    var els = document.querySelectorAll('.proc-reveal');
    if (els.length && 'IntersectionObserver' in window) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-view');
                    entry.target.classList.remove('past-view');
                } else if (entry.boundingClientRect.bottom < 0) {
                    entry.target.classList.remove('in-view');
                    entry.target.classList.add('past-view');
                } else {
                    entry.target.classList.remove('in-view', 'past-view');
                }
            });
        }, { threshold: 0.15 });
        els.forEach(function (el) { observer.observe(el); });
    } else {
        els.forEach(function (el) { el.classList.add('in-view'); });
    }

    var section      = document.querySelector('.lsc-process-section');
    var displayTitle = section && section.querySelector('.process-display-title');
    var displayBody  = section && section.querySelector('.process-display-body');
    var processLeft  = section && section.querySelector('.process-left');
    if (!section || !displayTitle || !displayBody || !processLeft) return;
    var cards = Array.prototype.slice.call(section.querySelectorAll('.process-card'));
    var nodes = Array.prototype.slice.call(section.querySelectorAll('.process-timeline-node'));
    function activate(card) {
        cards.forEach(function (c) { c.classList.remove('is-hovered'); });
        card.classList.add('is-hovered');
        displayTitle.textContent = card.getAttribute('data-process-title');
        displayBody.textContent  = card.getAttribute('data-process-body');
        section.classList.add('has-open');
        var idx = cards.indexOf(card);
        nodes.forEach(function (n, i) { n.classList.toggle('is-active', i === idx); });
    }
    function clearAll() {
        cards.forEach(function (c) { c.classList.remove('is-hovered'); });
        nodes.forEach(function (n) { n.classList.remove('is-active'); });
        section.classList.remove('has-open');
        displayTitle.textContent = '';
        displayBody.textContent  = '';
    }
    cards.forEach(function (card) {
        card.addEventListener('mouseenter', function () { activate(card); });
        card.addEventListener('touchstart', function (e) {
            e.preventDefault();
            card.classList.contains('is-hovered') ? clearAll() : activate(card);
        }, { passive: false });
    });
    processLeft.addEventListener('mouseleave', clearAll);
})();
