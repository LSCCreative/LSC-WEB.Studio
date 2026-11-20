'use strict';

/* The old hub's projects onto billing's records, #/setup/hub-import (merged-admin
 * R4). The rules are the server's (server/src/hub/adopt.js); this says what each
 * hub project will become, and asks about anything the email didn't settle.
 *
 * The richest copy of a hub project is in the localStorage of the browser that
 * edited it, on the portal's origin. This page is on another origin, so it can't
 * read it: the one line below copies it, and it is pasted here. Reading a list
 * stores nothing on the server. Records the server already holds are listed with
 * or without a list, so a sign-off is reachable if that browser is gone.
 *
 * Reached from Settings. It stays there after the import, because a record can be
 * left for later and "Not now" is the default for anything undecided.
 */

const HubImportView = (() => {
  const { esc } = LSCUtil;

  const BACK = '/settings/old-hub';
  const STORE_KEY = 'lsc_hub_projects_v1';
  const COPY_LINE = 'copy(localStorage.getItem(\'' + STORE_KEY + '\'))';
  const PORTAL_URL = 'https://lsccreative.studio/client-hub-app/';

  let root = null;
  let onAuthLost = null;
  let listing = null;      // the server's last reply
  let pasted = [];         // the browser's projects, only ever in this page
  let choices = new Map(); // hub id → the select's value; absent = the row's default
  let joins = new Map();   // hub id → joining the project with its UPID
  let confirming = false;

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  function failureText(err) {
    if (err.kind === 'network') return 'The server could not be reached. Nothing changed.';
    return err.message || 'The server had a problem. Nothing changed.';
  }

  /* ── What a row will do ──────────────────────────────────────────────── */

  const NOT_NOW = 'not-now';
  const LEAVE_OUT = 'leave-out';
  const IMPORT_MATCHED = 'matched';
  const NEW_CLIENT = 'new';

  function choiceOf(row) {
    return choices.get(row.id) || (row.state === 'ready' ? IMPORT_MATCHED : NOT_NOW);
  }

  /* The client the row's choice lands on: an id, or null for a new one or none. */
  function clientOfChoice(row, choice) {
    if (choice === IMPORT_MATCHED) return row.client.id;
    if (choice === NOT_NOW || choice === LEAVE_OUT || choice === NEW_CLIENT) return null;
    return choice;
  }

  /* The server has the last word on this; here it decides what to offer. */
  function canJoin(row, choice) {
    const there = row.upidProject;
    if (!there || !there.joinable || choice === NOT_NOW || choice === LEAVE_OUT) return false;
    return !there.clientId || there.clientId === clientOfChoice(row, choice);
  }

  const joining = (row, choice) => canJoin(row, choice) && joins.get(row.id) !== false;

  function decisions() {
    return listing.rows
      .filter((r) => (r.state === 'ready' || r.state === 'decide') && choiceOf(r) !== NOT_NOW)
      .map((r) => {
        const choice = choiceOf(r);
        if (choice === LEAVE_OUT) return { id: r.id, leaveOut: true };
        return {
          id: r.id,
          join: joining(r, choice),
          ...(choice === IMPORT_MATCHED ? {} : { client: choice }),
        };
      });
  }

  /* ── Markup ──────────────────────────────────────────────────────────── */

  function headMarkup(sub) {
    return (
      '<button class="back-btn" id="js-back">← Settings</button>' +
      '<div class="page-head"><div><h1 class="page-title">Bring over the old hub</h1>' +
      '<div class="page-sub">' + esc(sub) + '</div></div></div>'
    );
  }

  function subText() {
    const open = listing.rows.filter((r) => r.state === 'ready' || r.state === 'decide').length;
    if (!listing.rows.length) return 'Nothing from the hub yet';
    return open ? plural(open, 'hub project') + ' to bring over' : 'Every hub project is dealt with';
  }

  function hereMarkup() {
    const c = listing.classified;
    const orphans = c.noClient.length
      ? '<p class="hubi-note">' + plural(c.noClient.length, 'accepted project has', 'accepted projects have') +
        ' no client, because the quote names nobody. Open one to add its client from the quote.</p>' +
        '<ul class="hubi-orphans">' + c.noClient.map((p) =>
          '<li><a href="#/projects/' + esc(encodeURIComponent(p.id)) + '">' + esc(p.upid || 'No UPID') + (p.name ? ' · ' + esc(p.name) : '') + '</a></li>').join('') + '</ul>'
      : '';
    return (
      '<section class="panel" aria-labelledby="hubi-here-h">' +
      '<div class="panel-head"><h2 class="panel-title" id="hubi-here-h">Your projects here</h2></div>' +
      '<div class="panel-body"><p class="hubi-tally">' +
      '<span><strong>' + c.pipeline + '</strong> in the Pipeline</span>' +
      '<span><strong>' + c.live + '</strong> Live</span>' +
      '<span><strong>' + c.complete + '</strong> finished</span></p>' + orphans + '</div></section>'
    );
  }

  function sourceMarkup() {
    if (pasted.length) {
      return (
        '<section class="panel" aria-labelledby="hubi-source-h">' +
        '<div class="panel-head"><h2 class="panel-title" id="hubi-source-h">From the old browser</h2></div>' +
        '<div class="panel-body hubi-read"><p>Read ' + plural(pasted.length, 'project') + ' from that browser.' +
        (listing.skipped ? ' ' + plural(listing.skipped, 'entry', 'entries') + ' had no project id and were passed over.' : '') + '</p>' +
        '<button type="button" class="btn btn-sm btn-ghost" id="hubi-again">Paste another list</button></div></section>'
      );
    }
    return (
      '<section class="panel" aria-labelledby="hubi-source-h">' +
      '<div class="panel-head"><h2 class="panel-title" id="hubi-source-h">From the old browser</h2></div>' +
      '<div class="panel-body">' +
      '<p class="hubi-note">The hub kept its working copy in the browser you edited it in, on a computer. That copy has drafts and NAS paths the server never saw.</p>' +
      '<ol class="hubi-steps">' +
      '<li>In that browser, open <a href="' + PORTAL_URL + '" target="_blank" rel="noopener">the old hub</a>. You don’t need the PIN.</li>' +
      '<li>Open the browser’s console (Option-Command-J in Chrome, Option-Command-C in Safari), paste this line and press Return:' +
      '<div class="hubi-line"><code class="ref" id="hubi-line">' + esc(COPY_LINE) + '</code>' +
      '<button type="button" class="btn btn-sm" id="hubi-copy">Copy</button></div></li>' +
      '<li>Paste what it copied below. It holds clients’ portal codes, so don’t paste it anywhere else. Those are dropped before anything is saved.</li>' +
      '</ol>' +
      '<form id="hubi-form" novalidate><div class="field"><label for="hubi-paste">The hub’s list</label>' +
      '<textarea id="hubi-paste" rows="4" spellcheck="false" autocomplete="off" autocapitalize="none" aria-describedby="hubi-paste-error"></textarea></div>' +
      '<div class="hubi-error" id="hubi-paste-error" role="alert"></div>' +
      '<button type="submit" class="btn" id="hubi-read">Read the list</button></form>' +
      '</div></section>'
    );
  }

  function factsOf(row) {
    return [
      row.upid || 'No UPID',
      plural(row.assets, 'deliverable'),
      row.delivered ? 'delivered' : '',
      row.signed ? 'signed' : '',
      row.onPortal ? 'on the portal' : 'never published',
      !row.inBrowser ? 'not in that browser' : '',
    ].filter(Boolean).join(' · ');
  }

  function reasonOf(row) {
    if (row.reason === 'no_email') return 'The hub has no email for this one.';
    if (row.reason === 'shared_email') return 'Two clients share ' + row.email + ', so it could be either.';
    return 'No client has ' + row.email + '.';
  }

  function optionsOf(row) {
    const opt = (value, label) =>
      '<option value="' + esc(value) + '"' + (choiceOf(row) === value ? ' selected' : '') + '>' + esc(label) + '</option>';
    const leave = row.signed ? '' : opt(LEAVE_OUT, 'Leave it out');
    if (row.state === 'ready') {
      return opt(IMPORT_MATCHED, 'Import to ' + row.client.businessName) + opt(NOT_NOW, 'Not now') + leave;
    }
    const suggested = listing.clients.find((c) => c.id === row.suggested);
    const others = listing.clients.filter((c) => c.id !== row.suggested);
    return (
      opt(NOT_NOW, 'Not now') +
      (row.canCreate ? opt(NEW_CLIENT, 'New client: ' + row.createAs) : '') +
      (suggested ? opt(suggested.id, suggested.businessName + ' (looks likely)') : '') +
      (others.length ? '<optgroup label="Your clients">' + others.map((c) => opt(c.id, c.businessName)).join('') + '</optgroup>' : '') +
      leave
    );
  }

  function targetMarkup(row) {
    const choice = choiceOf(row);
    if (choice === NOT_NOW || choice === LEAVE_OUT) return '';
    const there = row.upidProject;
    if (!there) return '';
    if (canJoin(row, choice)) {
      return (
        '<label class="hubi-join"><input type="checkbox" data-join="' + esc(row.id) + '"' + (joining(row, choice) ? ' checked' : '') + '>' +
        '<span>Add to the project already on ' + esc(row.upid) + ' here, rather than making another</span></label>'
      );
    }
    return '<p class="hubi-note">' + esc(row.upid) + ' is already on ' +
      (there.clientName ? esc(there.clientName) + '’s project' : 'another project') +
      ', so this comes in with no UPID. You can give it one on its page.</p>';
  }

  function openRowMarkup(row) {
    const id = 'hubi-do-' + row.id;
    const who = [row.clientName, row.email].filter(Boolean).join(' · ');
    return (
      '<li class="hubi-row" data-row="' + esc(row.id) + '">' +
      '<div class="hubi-row-id"><h3 class="hubi-row-title">' + esc(row.title) + '</h3>' +
      '<p class="hubi-row-facts ref">' + esc(factsOf(row)) + '</p>' +
      (who ? '<p class="hubi-row-who">On the hub: ' + esc(who) + '</p>' : '') +
      (row.state === 'decide' ? '<p class="hubi-row-why">' + esc(reasonOf(row)) + '</p>' : '') +
      '</div>' +
      '<div class="hubi-row-do"><div class="field"><label for="' + esc(id) + '">What to do<span class="sr-only"> with ' + esc(row.title) + '</span></label>' +
      '<select id="' + esc(id) + '" data-choice="' + esc(row.id) + '">' + optionsOf(row) + '</select></div>' +
      targetMarkup(row) + '</div></li>'
    );
  }

  function group(state) {
    return listing.rows.filter((r) => r.state === state);
  }

  function openGroupMarkup(title, rows, hint, hid) {
    if (!rows.length) return '';
    return (
      '<section class="panel" aria-labelledby="' + hid + '">' +
      '<div class="panel-head"><h2 class="panel-title" id="' + hid + '">' + title + '<span class="panel-count">' + rows.length + '</span></h2></div>' +
      (hint ? '<p class="hubi-group-hint">' + hint + '</p>' : '') +
      '<ul class="hubi-rows">' + rows.map(openRowMarkup).join('') + '</ul></section>'
    );
  }

  function doneMarkup() {
    const done = group('done');
    const left = group('left_out');
    if (!done.length && !left.length) return '';
    const doneRows = done.map((r) =>
      '<li><a href="#/projects/' + esc(encodeURIComponent(r.projectId)) + '">' + esc(r.title) + '</a>' +
      '<span class="hubi-row-facts ref">' + esc(r.upid || 'No UPID') + '</span></li>').join('');
    const leftRows = left.map((r) =>
      '<li><span>' + esc(r.title) + '</span><button type="button" class="btn btn-sm btn-ghost" data-restore="' + esc(r.id) + '" aria-label="Bring back ' + esc(r.title) + '">Bring back</button></li>').join('');
    return (
      '<section class="panel" aria-labelledby="hubi-done-h">' +
      '<div class="panel-head"><h2 class="panel-title" id="hubi-done-h">Dealt with<span class="panel-count">' + (done.length + left.length) + '</span></h2></div>' +
      '<div class="panel-body">' +
      '<p class="hubi-note">Each comes over once. Reading the list again won’t change these, so anything you do on them is safe.</p>' +
      (doneRows ? '<ul class="hubi-done">' + doneRows + '</ul>' : '') +
      (leftRows ? '<h3 class="dlv-sub">Left out</h3><ul class="hubi-done">' + leftRows + '</ul>' : '') +
      '</div></section>'
    );
  }

  function actionMarkup() {
    const open = decisions();
    const undecided = group('decide').filter((r) => choiceOf(r) === NOT_NOW).length;
    if (!group('ready').length && !group('decide').length) return '';
    const imports = open.filter((d) => !d.leaveOut).length;
    const leaves = open.length - imports;
    const label = [imports ? 'Import ' + plural(imports, 'project') : '', leaves ? 'Leave out ' + leaves : ''].filter(Boolean).join(', ');
    return (
      '<div class="hubi-action" id="hubi-action">' +
      (confirming
        ? '<p class="hubi-action-text"><strong>Each comes over once.</strong> They become projects here, Payment required off. Clients’ links and logins carry on as they are, and no email goes out.</p>' +
          '<div class="hubi-action-btns"><button type="button" class="btn btn-ghost" id="hubi-cancel">Back</button>' +
          '<button type="button" class="btn btn-primary" id="hubi-go"><span class="spinner"></span>' + esc(label) + '</button></div>'
        : '<p class="hubi-action-text">' +
          (open.length ? '' : 'Nothing chosen yet. ') +
          (undecided ? plural(undecided, 'project stays', 'projects stay') + ' here for later.' : '') + '</p>' +
          '<div class="hubi-action-btns"><button type="button" class="btn btn-primary" id="hubi-start"' + (open.length ? '' : ' disabled') + '>' + esc(label || 'Import') + '…</button></div>') +
      '<div class="hubi-error" id="hubi-go-error" role="alert"></div></div>'
    );
  }

  function draw() {
    const holding = root.querySelector('#hubi-paste');
    const typed = holding ? holding.value : '';
    root.innerHTML =
      headMarkup(subText()) +
      '<p class="fix-intro">Each hub project becomes a project here, with its deliverables on the checklist and its sign-off in Documents. Clients’ links and logins carry on as they are, and nothing on the portal changes.</p>' +
      '<div class="hubi-screen">' +
      hereMarkup() + sourceMarkup() +
      openGroupMarkup('Needs a client', group('decide'), 'The email didn’t settle these. Choose a client, or leave them for later.', 'hubi-decide-h') +
      openGroupMarkup('Ready to import', group('ready'), 'One client has each email.', 'hubi-ready-h') +
      actionMarkup() + doneMarkup() +
      (listing.rows.length ? '' : '<p class="pf-empty">The server has no hub projects, and no list has been read yet.</p>') +
      '</div>';
    const paste = root.querySelector('#hubi-paste');
    if (paste) paste.value = typed;
    bind();
    document.title = LSCShell.title('Old hub');
  }

  /* ── Doing things ────────────────────────────────────────────────────── */

  function showError(id, message) {
    const box = root.querySelector(id);
    if (box) box.textContent = message;
  }

  /* The list as the hub saved it. A browser with nothing saved copies "null". */
  function parseList(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return { message: 'Paste the list first.' };
    let list;
    try {
      list = JSON.parse(trimmed);
    } catch {
      return { message: 'That isn’t the list. Run the line in the old hub’s console again, then paste what it copied.' };
    }
    if (list === null) return { message: 'That browser has no hub projects saved. It may be a different browser from the one you edited in.' };
    if (!Array.isArray(list)) return { message: 'That isn’t the old hub’s list of projects.' };
    return { list };
  }

  /* The codes stop here too, though the server drops them regardless. */
  const withoutSecrets = (list) => list.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const { clientCode, inviteToken, ...rest } = p;
    return rest;
  });

  async function read(button) {
    const paste = root.querySelector('#hubi-paste');
    const parsed = parseList(paste.value);
    if (parsed.message) {
      showError('#hubi-paste-error', parsed.message);
      paste.focus();
      return;
    }
    const list = withoutSecrets(parsed.list);
    button.disabled = true;
    try {
      listing = await LSCApi.post('/api/setup/hub-import/read', { projects: list });
      pasted = list;
      confirming = false;
      paste.value = '';
      draw();
      focusOn('#hubi-source-h');
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return onAuthLost({ keepScreen: true });
      if (button.isConnected) button.disabled = false;
      showError('#hubi-paste-error', failureText(err));
    }
    return undefined;
  }

  function focusOn(selector) {
    const el = root.querySelector(selector);
    if (!el) return;
    el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: false });
  }

  async function go(button) {
    if (button.classList.contains('loading')) return undefined;
    button.classList.add('loading');
    try {
      listing = await LSCApi.post('/api/setup/hub-import', { projects: pasted, decisions: decisions() });
      const r = listing.result;
      confirming = false;
      choices = new Map();
      joins = new Map();
      const made = r.imported + r.joined;
      const clash = r.clashes.length ? ' ' + plural(r.clashes.length, 'came', 'came') + ' in with no UPID, because it was taken.' : '';
      Toast.ok((made ? 'Imported ' + plural(made, 'project') + '.' : 'Done.') + clash);
      draw();
      focusOn('#hubi-done-h');
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return onAuthLost({ keepScreen: true });
      if (button.isConnected) button.classList.remove('loading');
      // All or nothing, so the message is true of every row.
      showError('#hubi-go-error', failureText(err));
    }
    return undefined;
  }

  async function restore(id, button) {
    button.disabled = true;
    try {
      listing = await LSCApi.post('/api/setup/hub-import/restore', { id, projects: pasted });
      // The server's kept copy was its only one: the page holds it from here, like a pasted project.
      if (listing.restored && !pasted.some((p) => p.id === listing.restored.id)) pasted = pasted.concat([listing.restored]);
      draw();
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return onAuthLost({ keepScreen: true });
      if (button.isConnected) button.disabled = false;
      Toast.error(failureText(err));
    }
    return undefined;
  }

  /* "Paste another list": the rows the old list brought are dropped with it, by
     asking the server again, so nothing on screen depends on a list no longer held. */
  async function forgetList(button) {
    button.disabled = true;
    try {
      listing = await LSCApi.get('/api/setup/hub-import');
      pasted = [];
      choices = new Map();
      joins = new Map();
      confirming = false;
      draw();
      focusOn('#hubi-paste');
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return onAuthLost({ keepScreen: true });
      if (button.isConnected) button.disabled = false;
      Toast.error(failureText(err));
    }
    return undefined;
  }

  async function copyLine(button) {
    try {
      await navigator.clipboard.writeText(COPY_LINE);
      button.textContent = 'Copied';
    } catch {
      // The line is on screen to select by hand.
      const range = document.createRange();
      range.selectNodeContents(root.querySelector('#hubi-line'));
      const picked = window.getSelection();
      picked.removeAllRanges();
      picked.addRange(range);
      button.textContent = 'Select it, then copy';
    }
  }

  function redrawAction() {
    const old = root.querySelector('#hubi-action');
    if (!old) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = actionMarkup();
    old.replaceWith(wrap.firstElementChild);
    bindAction();
  }

  function bindAction() {
    const start = root.querySelector('#hubi-start');
    if (start) {
      start.addEventListener('click', () => {
        confirming = true;
        redrawAction();
        root.querySelector('#hubi-go').focus();
      });
    }
    const cancel = root.querySelector('#hubi-cancel');
    if (cancel) {
      cancel.addEventListener('click', () => {
        confirming = false;
        redrawAction();
        root.querySelector('#hubi-start').focus();
      });
    }
    const goBtn = root.querySelector('#hubi-go');
    if (goBtn) goBtn.addEventListener('click', () => go(goBtn));
  }

  function bind() {
    root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(BACK));
    const form = root.querySelector('#hubi-form');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        read(root.querySelector('#hubi-read'));
      });
    }
    const copy = root.querySelector('#hubi-copy');
    if (copy) copy.addEventListener('click', () => copyLine(copy));
    const again = root.querySelector('#hubi-again');
    if (again) {
      again.addEventListener('click', () => forgetList(again));
    }
    bindRows();
    root.querySelectorAll('[data-restore]').forEach((button) => {
      button.addEventListener('click', () => restore(button.dataset.restore, button));
    });
    bindAction();
  }

  /* The rows' controls, here rather than in bind(): a row redrawn on its own has
     new ones. The join offer depends on the client, so a row redraws with its choice. */
  function bindRows() {
    root.querySelectorAll('[data-join]').forEach((box) => {
      box.onchange = () => {
        joins.set(box.dataset.join, box.checked);
        confirming = false;
        redrawAction();
      };
    });
    root.querySelectorAll('[data-choice]').forEach((select) => {
      if (select.dataset.bound) return;
      select.dataset.bound = '1';
      select.addEventListener('change', () => {
        if (!select.isConnected) return;
        choices.set(select.dataset.choice, select.value);
        confirming = false;
        const row = listing.rows.find((r) => r.id === select.dataset.choice);
        const wrap = document.createElement('ul');
        wrap.innerHTML = openRowMarkup(row);
        select.closest('.hubi-row').replaceWith(wrap.firstElementChild);
        bindRows();
        redrawAction();
        root.querySelector('#' + CSS.escape('hubi-do-' + row.id)).focus();
      });
    });
  }

  async function mount() {
    window.scrollTo(0, 0);
    const ticket = LSCRouter.ticket();
    listing = null;
    pasted = [];
    choices = new Map();
    joins = new Map();
    confirming = false;
    root.innerHTML = headMarkup('Loading…');
    root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(BACK));
    try {
      const reply = await LSCApi.get('/api/setup/hub-import');
      if (!LSCRouter.isCurrent(ticket)) return undefined;
      listing = reply;
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (!LSCRouter.isCurrent(ticket)) return undefined;
      if (err.kind === 'auth') return onAuthLost();
      root.innerHTML =
        headMarkup('Could not load') +
        '<div class="empty-state"><h3>Couldn’t load the old hub’s projects</h3><p>' + esc(failureText(err)) + '</p>' +
        '<button type="button" class="btn" id="js-retry" style="margin-top:16px">Try again</button></div>';
      root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(BACK));
      root.querySelector('#js-retry').addEventListener('click', mount);
      return undefined;
    }
    draw();
    LSCUnsaved.watch('hub-import', {
      label: 'the hub list you’ve read',
      onScreen: () => Boolean(root && root.querySelector('.hubi-screen')),
      // A list held only in this page, or a choice made, is lost by leaving.
      dirty: () => {
        const paste = root.querySelector('#hubi-paste');
        const open = listing.rows.some((r) => r.inBrowser && (r.state === 'ready' || r.state === 'decide'));
        return Boolean(paste && paste.value.trim()) || (pasted.length > 0 && open) || choices.size > 0;
      },
    });
    LSCUtil.landFocus(root);
    return undefined;
  }

  return {
    /* Once per sign-in. */
    init(container, options) {
      root = container;
      onAuthLost = options.onAuthLost;
    },

    /* The router's way in: segments after 'setup'. */
    show(segments) {
      if (segments.length !== 1 || segments[0] !== 'hub-import') return false;
      mount();
      return true;
    },
  };
})();
