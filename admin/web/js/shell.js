'use strict';

/* The admin shell (merged-admin L2; IA "Navigation Model").
 *
 * Two areas, Scope & Sales and Clients, as real tabs in the header; the active
 * area's pages in a row beneath (#app-subnav); Settings and Sign out in the
 * account menu. app.js says where the screen on show belongs (set()), and
 * every move this file makes is a route through LSCRouter.go(), so each one
 * asks about unsaved edits first, exactly as the old header's buttons did.
 *
 * THE TABS use manual activation (APG): Left/Right/Home/End move focus, Enter
 * or Space goes there. Automatic activation would navigate on an arrow press,
 * and an arrow press must never put up the unsaved-edit prompt. Choosing a tab
 * opens that area's first page; choosing the tab you are on re-opens it, as a
 * nav item always has.
 *
 * TITLES name the area: "Pipeline — Scope & Sales", "Acme — Clients". title()
 * is what every screen calls instead of writing its own suffix.
 */

const LSCShell = (() => {
  const AREAS = {
    sales: {
      label: 'Scope & Sales',
      pages: [
        { id: 'home', label: 'Dashboard', path: '/home' },
        { id: 'pipeline', label: 'Pipeline', path: '/pipeline' },
        { id: 'finance', label: 'Finance & Price', path: '/finance' },
      ],
    },
    clients: {
      label: 'Clients',
      pages: [
        { id: 'clients', label: 'Clients', path: '/clients' },
        { id: 'live', label: 'Live projects', path: '/projects' },
      ],
    },
  };
  const SUFFIX_NONE = 'LSC Creative';

  const esc = (s) => LSCUtil.esc(s);
  let area = null; // 'sales' | 'clients' | null (Settings)
  let page = null;
  let onSignOut = null;
  let placed = null; // { id, area, page }: the last project placed, see placeProject()

  const $ = (id) => document.getElementById(id);
  const tabs = () => Array.from(document.querySelectorAll('#app-header .shell-tab'));

  function subnavMarkup(id) {
    const a = AREAS[id];
    return (
      '<nav class="subnav" aria-label="' + esc(a.label) + '"><ol class="subnav-list">' +
      a.pages.map((p, i) =>
        '<li><a class="subnav-link" href="#' + esc(p.path) + '" data-path="' + esc(p.path) + '" data-page="' + p.id + '"' +
        (p.id === page ? ' aria-current="page"' : '') + '>' +
        '<span class="subnav-index" aria-hidden="true">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="subnav-label">' + esc(p.label) + '</span></a></li>'
      ).join('') +
      '</ol></nav>'
    );
  }

  /* Where the screen on show belongs. areaId null (Settings) selects no tab
     and hides the row; pageId null highlights the area but no page in it (a
     project, an invoice: a level below the row). */
  function set(areaId, pageId) {
    const nextArea = AREAS[areaId] ? areaId : null;
    const nextPage = pageId || null;
    const changed = nextArea !== area;
    area = nextArea;
    page = nextPage;

    tabs().forEach((tab) => {
      const on = tab.dataset.area === area;
      tab.setAttribute('aria-selected', String(on));
    });
    // Roving tabindex: the selected tab, or the first when none is.
    const sel = tabs().find((t) => t.dataset.area === area) || tabs()[0];
    tabs().forEach((t) => t.setAttribute('tabindex', t === sel ? '0' : '-1'));

    const sub = $('app-subnav');
    if (!area) {
      sub.hidden = true;
      sub.innerHTML = '';
    } else {
      sub.hidden = false;
      sub.setAttribute('aria-labelledby', 'tab-' + area);
      if (changed || !sub.firstChild) {
        sub.innerHTML = subnavMarkup(area);
      } else {
        sub.querySelectorAll('.subnav-link').forEach((a) => {
          if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
          else a.removeAttribute('aria-current');
        });
      }
      revealCurrent(sub);
    }
    $('acct-btn').classList.toggle('is-current', area === null && pageId === 'settings');
  }

  /* A project's page belongs where the record's state says (IA "Where a
     project belongs"), which only its own screen knows once it has loaded.
     placeProject() lights that tab and remembers it for the project, so the
     screens under it (its estimate, its invoices) light the same tab while
     they load, and on to the next. projectPlace() answers for an id: the
     remembered place, else Scope & Sales with no page lit. notePlace() only
     remembers: a card being opened already knows its project's stage, so the
     route lights the right tab from the start. */
  function notePlace(id, place) {
    placed = { id, area: place.area, page: place.page };
  }

  function placeProject(id, place) {
    notePlace(id, place);
    set(place.area, place.page);
  }

  function projectPlace(id) {
    return placed && placed.id === id ? placed : { area: 'sales', page: null };
  }

  /* On a phone the row scrolls sideways; the current page is brought into it
     without moving the page itself. */
  function revealCurrent(sub) {
    const list = sub.querySelector('.subnav-list');
    const cur = sub.querySelector('[aria-current="page"]');
    if (!list || !cur || list.scrollWidth <= list.clientWidth) return;
    const left = cur.offsetLeft - 16;
    if (left < list.scrollLeft || cur.offsetLeft + cur.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left);
    }
  }

  /* The label of the page on show in the row ('Dashboard'), or null. */
  function pageLabel() {
    const p = area && AREAS[area].pages.find((x) => x.id === page);
    return p ? p.label : null;
  }

  /* "Pipeline — Scope & Sales". With no page name, the area alone. */
  function title(name) {
    const suffix = area ? AREAS[area].label : SUFFIX_NONE;
    return name && name !== suffix ? name + ' — ' + suffix : suffix;
  }

  function setUser(session) {
    const name = (session && session.username) || '';
    $('acct-initial').textContent = name ? name.trim().charAt(0).toUpperCase() : '';
    $('acct-name').textContent = name;
    $('acct-who').textContent = name;
    $('acct-btn').setAttribute('aria-label', name ? 'Account, signed in as ' + name : 'Account');
  }

  // A plain click becomes a route; a modified one (new tab) is left alone.
  const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

  function bind(opts) {
    onSignOut = opts.onSignOut;

    $('logo-btn').addEventListener('click', (e) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      LSCRouter.go('/home');
    });

    // The Needs you count opens the Dashboard, where the queue is.
    $('needs-link').addEventListener('click', (e) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      LSCRouter.go('/home');
    });

    const list = document.querySelector('#app-header .shell-tabs');
    list.addEventListener('click', (e) => {
      const tab = e.target.closest('.shell-tab');
      if (tab) LSCRouter.go(AREAS[tab.dataset.area].pages[0].path);
    });
    list.addEventListener('keydown', (e) => {
      const all = tabs();
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % all.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + all.length) % all.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = all.length - 1;
      if (n === null) return;
      e.preventDefault();
      all.forEach((t, k) => t.setAttribute('tabindex', k === n ? '0' : '-1'));
      all[n].focus();
    });
    // Focus leaving the tablist puts the roving stop back on the selected tab.
    list.addEventListener('focusout', (e) => {
      if (list.contains(e.relatedTarget)) return;
      const sel = tabs().find((t) => t.dataset.area === area) || tabs()[0];
      tabs().forEach((t) => t.setAttribute('tabindex', t === sel ? '0' : '-1'));
    });

    $('app-subnav').addEventListener('click', (e) => {
      const link = e.target.closest('.subnav-link');
      if (!link || !plainClick(e)) return;
      e.preventDefault();
      LSCRouter.go(link.dataset.path);
    });

    // The menu's items are clicked here, at home, by js/menu.js.
    $('acct-settings').addEventListener('click', () => LSCRouter.go('/settings'));
    $('acct-sign-out').addEventListener('click', () => onSignOut && onSignOut());
  }

  return { set, notePlace, placeProject, projectPlace, title, pageLabel, setUser, bind, AREAS };
})();
