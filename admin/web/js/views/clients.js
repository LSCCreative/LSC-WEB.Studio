'use strict';

/* The Clients area (merged-admin R2; IA "Clients", "Client: Projects"): the
 * client list, and one client's record in three tabs.
 *
 *   #/clients?q=                 the list; search also finds a client through a
 *                                project's name or UPID, so an old job can be
 *                                found without remembering whose it was
 *   #/clients/new                a new client
 *   #/clients/<id>               gives way to .../projects
 *   #/clients/<id>/projects      Quotes, Active, Complete (?view=archived: Archived)
 *   #/clients/<id>/details       the record's fields
 *   #/clients/<id>/invoices      every invoice of theirs, newest first
 *
 * The record's head and tabs stay on the page across a move between tabs and
 * only the panel is redrawn, so a tab chosen by keyboard keeps its focus.
 *
 * EDITING A CLIENT NEVER TOUCHES AN ESTIMATE
 * Each estimate carries its own snapshot of the client's details, taken when it
 * was saved, so a quote already sent keeps the address it was sent with. The
 * record here is only where the estimate editor's typeahead fills *new* ones
 * from. The same is true of deleting: the server nulls the link and the
 * estimates keep their copy.
 *
 * ONE RECORD PER BUSINESS NAME
 * The estimate editor links an unpicked name to an existing client by a
 * case-insensitive exact match on business name (see resolveClient in
 * estimate-editor.js), so two records with the same name would make that
 * ambiguous. Saving here refuses a name another client already has.
 *
 * ONE CLIENT PER EMAIL (S13)
 * The email is the client's portal login. The server normalises it and refuses
 * one another client holds; two clients left on one address from before that
 * rule are told so on the Client details tab.
 */

const ClientsView = (() => {
  const { esc, abnDigits, abnValid, abnFormat, fmt } = LSCUtil;

  let root = null;
  let handlers = null;

  const LIST = '/clients';
  const clientPath = (id) => LIST + '/' + encodeURIComponent(id);
  const tabPath = (id, tab) => clientPath(id) + '/' + tab;
  const TABS = [['projects', 'Projects'], ['details', 'Client details'], ['invoices', 'Invoice index']];

  const SEARCH_WAIT_MS = 300;
  /* Complete cards shown before "Show all": the rest of the page stays in reach. */
  const COMPLETE_SHOWN = 12;
  const PAGE_LIMIT = 200;

  const FIELDS = [
    ['businessName', 'c-business'],
    ['contactName', 'c-contact'],
    ['email', 'c-email'],
    ['phone', 'c-phone'],
    ['abn', 'c-abn'],
    ['address', 'c-address'],
    ['notes', 'c-notes'],
  ];

  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  function failureText(err, action) {
    return err.kind === 'network'
      ? 'Couldn’t ' + action + ' — the server is unreachable.'
      : 'Couldn’t ' + action + ': ' + (err.message || 'the server refused the request.');
  }

  // ── List ──────────────────────────────────────────────────────────────────

  let listQuery = '';
  let typing = null; // the search box's pending route change
  const listOnScreen = () => Boolean(root && root.querySelector('#clients-view'));

  const listPath = (q) => (q ? LIST + '?' + new URLSearchParams({ q }).toString() : LIST);

  function matchMarkup(client) {
    if (!client.matches || !client.matches.length) return '';
    const more = client.moreMatches ? '<li class="client-match-more">and ' + client.moreMatches + ' more</li>' : '';
    return (
      '<ul class="client-matches" aria-label="Matching projects">' +
      client.matches.map((m) =>
        '<li><span class="client-match-upid">' + esc(m.upid || 'No UPID') + '</span> ' + esc(m.name || 'Untitled') +
        (m.archived ? ' <span class="client-match-note">Archived</span>' : '') + '</li>'
      ).join('') + more + '</ul>'
    );
  }

  function cardMarkup(client) {
    return (
      '<div class="proj-card client-card" data-id="' + esc(client.id) + '" role="listitem">' +
      '<h2 class="card-name"><button type="button" class="card-open">' +
      esc(client.businessName || '—') + '</button></h2>' +
      '<div class="card-client">' + esc(client.contactName || 'No contact name') + '</div>' +
      matchMarkup(client) +
      '<div class="card-foot"><div class="card-date client-card-email' + (client.email ? '' : ' is-missing') + '">' +
      esc(client.email || 'No email') + '</div>' +
      '<div class="tag client-card-live">' + esc(client.liveCount ? client.liveCount + ' live' : 'None live') + '</div>' +
      '</div></div>'
    );
  }

  function listShell() {
    return (
      '<div id="clients-view">' +
      '<div class="page-head"><div><h1 class="page-title">Clients</h1>' +
      '<div class="page-sub" id="clients-sub">Loading…</div></div>' +
      '<button class="btn btn-accent" id="js-new">+ New client</button></div>' +
      '<div class="projects-tools"><div class="projects-search" role="search">' +
      '<label class="sr-only" for="clients-q">Search clients and their projects</label>' +
      '<input type="search" id="clients-q" class="projects-q" autocomplete="off" spellcheck="false" ' +
      'placeholder="Search client, project or UPID" value="' + esc(listQuery) + '">' +
      '</div></div>' +
      '<div id="clients-results" aria-busy="true"></div>' +
      '<p class="sr-only" id="clients-live" aria-live="polite"></p>' +
      '</div>'
    );
  }

  function mountList() {
    root.innerHTML = listShell();
    root.querySelector('#js-new').addEventListener('click', () => LSCRouter.go(LIST + '/new'));
    const input = root.querySelector('#clients-q');
    const search = () => {
      clearTimeout(typing);
      typing = null;
      if (!listOnScreen()) return;
      const q = input.value.trim();
      if (q !== listQuery) LSCRouter.go(listPath(q), { replace: true });
    };
    input.addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(search, SEARCH_WAIT_MS);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') search();
    });
  }

  function emptyListMarkup() {
    if (listQuery) {
      return (
        '<div class="empty-state"><h3>Nothing matches “' + esc(listQuery) + '”</h3>' +
        '<p>Search looks at client names, contacts and emails, and at every project’s name and UPID, Complete and Archived included.</p>' +
        '<button type="button" class="btn" id="js-clear" style="margin-top:16px">Clear search</button></div>'
      );
    }
    return (
      '<div class="empty-state"><h3>No clients yet</h3>' +
      '<p>Add one with <strong>New client</strong>. A client is also made for you when a quote is accepted, ' +
      'or when an estimate is saved with <strong>Save to client list</strong> ticked.</p></div>'
    );
  }

  async function loadList(announce) {
    const ticket = LSCRouter.ticket();
    const box = root.querySelector('#clients-results');
    box.setAttribute('aria-busy', 'true');
    let reply;
    try {
      const params = new URLSearchParams({ today: LSCUtil.today() });
      if (listQuery) params.set('q', listQuery);
      reply = await LSCApi.get('/api/clients/summary?' + params.toString());
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (!LSCRouter.isCurrent(ticket) || !listOnScreen()) return;
      if (err.kind === 'auth') return handlers.onAuthLost();
      root.querySelector('#clients-sub').textContent = 'Could not load';
      box.removeAttribute('aria-busy');
      box.innerHTML =
        '<div class="empty-state"><h3>Couldn’t load your clients</h3><p>' +
        esc(err.kind === 'network' ? 'The server could not be reached.' : err.message || 'The server had a problem.') +
        '</p><button type="button" class="btn" id="js-retry" style="margin-top:16px">Try again</button></div>';
      box.querySelector('#js-retry').addEventListener('click', () => loadList(false));
      return;
    }
    if (!LSCRouter.isCurrent(ticket) || !listOnScreen()) return;
    const clients = reply.clients || [];
    root.querySelector('#clients-sub').textContent = listQuery
      ? clients.length + ' of ' + plural(reply.total, 'client')
      : reply.total ? plural(reply.total, 'client') : 'No clients yet';
    box.innerHTML = clients.length
      ? '<div class="cards-grid" role="list">' + clients.map(cardMarkup).join('') + '</div>'
      : emptyListMarkup();
    box.removeAttribute('aria-busy');
    box.querySelectorAll('.client-card').forEach((card) => {
      const client = clients.find((c) => c.id === card.dataset.id);
      // Keyboard activation arrives here too: Enter/Space on the card's own
      // .card-open button dispatch a click, which bubbles to the card. The
      // record rides along so opening it doesn't refetch what the list holds.
      card.addEventListener('click', () => LSCRouter.go(tabPath(client.id, 'projects'), { state: { client } }));
    });
    const clear = box.querySelector('#js-clear');
    if (clear) {
      clear.addEventListener('click', () => {
        LSCRouter.go(LIST);
        root.querySelector('#clients-q').focus();
      });
    }
    if (announce) {
      LSCUtil.announce(root.querySelector('#clients-live'), clients.length ? plural(clients.length, 'client') + ' shown' : 'No clients shown');
    }
  }

  function showList(q) {
    clearTimeout(typing);
    typing = null;
    listQuery = q;
    document.title = LSCShell.title('Clients');
    if (listOnScreen()) {
      const input = root.querySelector('#clients-q');
      // Not while it reads the same: rewriting it would eat a space being typed.
      if (input.value.trim() !== q) input.value = q;
      loadList(true);
      return;
    }
    window.scrollTo(0, 0);
    mountList();
    LSCUtil.landFocus(root);
    loadList(false);
  }

  // ── One client: the frame ─────────────────────────────────────────────────

  let record = null; // the client on show
  const recordOnScreen = (id) => Boolean(root && record && record.id === id && root.querySelector('#client-record'));
  const panel = () => root.querySelector('#client-panel');

  function subMarkup(client) {
    return (
      (client.contactName ? esc(client.contactName) + ' · ' : '') +
      (client.email ? esc(client.email) : '<span class="client-no-email">No email</span>')
    );
  }

  function headMarkup(client, tab) {
    return (
      '<div id="client-record">' +
      '<button class="back-btn" id="js-back">← Clients</button>' +
      '<div class="page-head"><div><h1 class="page-title" id="client-name">' + esc(client.businessName || 'Client') + '</h1>' +
      '<div class="page-sub" id="client-sub">' + subMarkup(client) + '</div></div></div>' +
      LSCSubTabs.markup({
        label: client.businessName || 'Client',
        current: tab,
        panelId: 'client-panel',
        tabs: TABS.map(([id, label]) => ({ id, label, path: tabPath(client.id, id) })),
      }) +
      '<div id="client-panel" role="tabpanel" aria-labelledby="subtab-' + tab + '" tabindex="-1"></div>' +
      '<p class="sr-only" id="client-live" aria-live="polite"></p>' +
      '</div>'
    );
  }

  function mountRecord(client, tab) {
    record = client;
    window.scrollTo(0, 0);
    root.innerHTML = headMarkup(client, tab);
    root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(LIST, { replace: true }));
    LSCSubTabs.bind(root.querySelector('#client-record'));
    // "Acme — Clients": the record names its tab, as a project's folder does.
    document.title = LSCShell.title(client.businessName || 'Client');
    LSCUtil.landFocus(root);
  }

  /* The record's name and contact, after a save changed them. */
  function repaintHead(client) {
    root.querySelector('#client-name').textContent = client.businessName || 'Client';
    root.querySelector('#client-sub').innerHTML = subMarkup(client);
    root.querySelector('.subtabs').setAttribute('aria-label', client.businessName || 'Client');
    document.title = LSCShell.title(client.businessName || 'Client');
  }

  function drawPanel(tab, view) {
    const box = panel();
    box.setAttribute('aria-labelledby', 'subtab-' + tab);
    if (tab === 'details') drawDetails(box, record);
    else if (tab === 'invoices') loadInvoices(box, record);
    else loadProjects(box, record, view);
  }

  /* A panel's load failing says so where its content would be. */
  function panelFailure(box, err, what, retry) {
    box.innerHTML =
      '<div class="empty-state"><h3>Couldn’t load ' + esc(what) + '</h3><p>' +
      esc(err.kind === 'network' ? 'The server could not be reached.' : err.message || 'The server had a problem.') +
      '</p><button type="button" class="btn" id="js-retry" style="margin-top:16px">Try again</button></div>';
    box.querySelector('#js-retry').addEventListener('click', retry);
  }

  /* #/clients/<id>/<tab>: the record the list handed over, or a fresh read for a
     reload or a deep link. A deleted one says so in place (D59). */
  async function showRecord(id, tab, view, held) {
    if (recordOnScreen(id)) {
      // The route has just reset the title to the area's.
      document.title = LSCShell.title(record.businessName || 'Client');
      LSCSubTabs.mark(root.querySelector('#client-record'), tab);
      drawPanel(tab, view);
      return;
    }
    if (held && held.id === id) {
      mountRecord(held, tab);
      drawPanel(tab, view);
      return;
    }
    const ticket = LSCRouter.ticket();
    // The screen being left goes now, not when the reply comes: the router has
    // already asked about its edits, so anything typed into it meanwhile
    // would be lost without a question.
    record = null;
    window.scrollTo(0, 0);
    root.innerHTML =
      '<button class="back-btn" id="js-back">← Clients</button>' +
      '<div class="empty-state"><h3>Loading…</h3></div>';
    root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(LIST));
    let client;
    try {
      client = (await LSCApi.get('/api/clients/' + encodeURIComponent(id))).client;
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (!LSCRouter.isCurrent(ticket)) return;
      if (err.kind === 'auth') return handlers.onAuthLost();
      window.scrollTo(0, 0);
      const gone = err.status === 404;
      root.innerHTML =
        '<button class="back-btn" id="js-back">← Clients</button>' +
        '<div class="empty-state"><h3>' +
        (gone ? 'That client doesn’t exist any more' : 'Couldn’t open that client') + '</h3><p>' +
        esc(gone ? 'They may have been deleted. Estimates saved for them keep their own copy of the details.' : failureText(err, 'load them')) +
        '</p>' + (gone ? '' : '<button type="button" class="btn" id="js-retry" style="margin-top:16px">Try again</button>') +
        '</div>';
      root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(LIST));
      if (!gone) root.querySelector('#js-retry').addEventListener('click', () => showRecord(id, tab, view));
      return;
    }
    if (!LSCRouter.isCurrent(ticket)) return;
    mountRecord(client, tab);
    drawPanel(tab, view);
  }

  // ── Projects tab ──────────────────────────────────────────────────────────

  /* One client's list, whole: there are few enough that paging would only hide
     them (IA, Content Growth: "No pagination for a single client's jobs"). The
     server caps a page, so this follows its cursor. */
  async function readClientProjects(clientId, stage) {
    const params = new URLSearchParams({ client: clientId, stage, limit: String(PAGE_LIMIT), today: LSCUtil.today() });
    const first = await LSCApi.get('/api/projects?' + params.toString());
    const projects = first.projects || [];
    let next = first.next;
    while (next) {
      params.set('before', next);
      const more = await LSCApi.get('/api/projects?' + params.toString());
      projects.push(...(more.projects || []));
      next = more.next;
    }
    return { projects, counts: first.counts || {} };
  }

  const today = () => LSCUtil.today();

  function groupMarkup(id, title, projects, opts) {
    const o = opts || {};
    return (
      '<section class="client-group" aria-labelledby="group-' + id + '">' +
      '<h2 class="client-group-title" id="group-' + id + '">' + esc(title) +
      ' <span class="client-group-count">' + (o.total === undefined ? projects.length : o.total) + '</span></h2>' +
      (projects.length
        ? '<div class="cards-grid" role="list" id="grid-' + id + '">' +
          projects.map((p) => ProjectCard.cardMarkup(p, today(), { hideClient: true, action: o.action && o.action(p) })).join('') +
          '</div>'
        : '<p class="client-group-empty">' + esc(o.empty || '') + '</p>') +
      (o.after || '') +
      '</section>'
    );
  }

  const ARCHIVE = (p) => ({ act: 'archive', label: 'Archive', says: 'Archive ' + (p.name || 'this project') });
  const UNARCHIVE = (p) => ({ act: 'unarchive', label: 'Unarchive', says: 'Unarchive ' + (p.name || 'this project') });

  function projectsMarkup(projects, counts, allComplete) {
    const quotes = projects.filter((p) => p.delivery.group === 'pipeline');
    const active = projects.filter((p) => p.delivery.group === 'live');
    const complete = projects.filter((p) => p.delivery.badge === 'complete');
    const archived = counts.archived || 0;
    const declined = counts.declined || 0;

    if (!projects.length && !archived && !declined) {
      return (
        '<div class="empty-state"><h3>No projects yet</h3>' +
        '<p>Pick this client from Business Name when you write an estimate, and its project will appear here.</p>' +
        '<button type="button" class="btn" id="js-new-project" style="margin-top:16px">+ New project</button></div>'
      );
    }

    const shownComplete = allComplete ? complete : complete.slice(0, COMPLETE_SHOWN);
    const moreComplete = complete.length - shownComplete.length;
    return (
      (quotes.length ? groupMarkup('quotes', 'Quotes', quotes) : '') +
      groupMarkup('active', 'Active', active, { empty: 'Nothing live for this client right now.' }) +
      (complete.length
        ? groupMarkup('complete', 'Complete', shownComplete, {
            action: ARCHIVE,
            total: complete.length,
            after: moreComplete
              ? '<div class="projects-more"><button type="button" class="btn" id="js-all-complete">Show all ' + complete.length + '</button></div>'
              : '',
          })
        : '') +
      '<div class="client-links">' +
      (archived
        ? '<button type="button" class="client-link" id="js-archived">Archived <span class="client-group-count">' + archived + '</span></button>'
        : '') +
      (declined
        ? '<button type="button" class="client-link" id="js-declined">' + esc(plural(declined, 'declined quote')) + ', under Pipeline</button>'
        : '') +
      '</div>'
    );
  }

  function archivedMarkup(projects) {
    return (
      '<button type="button" class="back-btn" id="js-all-projects">← All projects</button>' +
      '<section class="client-group" aria-labelledby="group-archived">' +
      '<h2 class="client-group-title" id="group-archived">Archived <span class="client-group-count">' + projects.length + '</span></h2>' +
      '<p class="client-group-note">The client sees these under Past projects, and they still open.</p>' +
      (projects.length
        ? '<div class="cards-grid" role="list" id="grid-archived">' +
          projects.map((p) => ProjectCard.cardMarkup(p, today(), { hideClient: true, action: UNARCHIVE(p) })).join('') + '</div>'
        : '<p class="client-group-empty">Nothing archived. Complete projects can be filed here from the Projects tab.</p>') +
      '</section>'
    );
  }

  /* Archive or Unarchive on a card. Where focus lands next: the way to what just
     moved, since the card it was on has gone. */
  function bindCardActions(box, client, reload) {
    const act = async (btn) => {
      const archive = btn.dataset.act === 'archive';
      btn.disabled = true;
      try {
        await LSCApi.post('/api/projects/' + encodeURIComponent(btn.dataset.id) + (archive ? '/archive' : '/unarchive'));
      } catch (err) {
        if (!(err instanceof LSCApi.ApiError)) throw err;
        if (btn.isConnected) btn.disabled = false;
        if (err.kind === 'auth') return handlers.onAuthLost({ keepScreen: true });
        Toast.error(failureText(err, archive ? 'archive it' : 'unarchive it'));
        return;
      }
      Toast.ok(archive ? 'Archived. It’s under Past projects for the client.' : 'Back in Complete.');
      if (!recordOnScreen(client.id)) return;
      await reload();
      const target = archive ? box.querySelector('#js-archived') : box.querySelector('#js-all-projects');
      if (target) target.focus();
    };
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="archive"], [data-act="unarchive"]');
      if (btn && !btn.disabled) act(btn);
    });
  }

  async function loadProjects(box, client, view) {
    const archivedView = view === 'archived';
    // A fresh node each draw: the card actions are delegated on it.
    const holder = document.createElement('div');
    box.replaceChildren(holder);
    holder.innerHTML = '<p class="client-history-empty" role="status">Loading projects…</p>';
    let allComplete = false;

    const reload = async () => {
      let reply;
      try {
        reply = await readClientProjects(client.id, archivedView ? 'archived' : 'current');
      } catch (err) {
        if (!(err instanceof LSCApi.ApiError)) throw err;
        if (err.kind === 'auth') return handlers.onAuthLost();
        if (holder.isConnected) panelFailure(holder, err, 'their projects', reload);
        return;
      }
      if (!holder.isConnected) return; // moved on while it loaded
      const draw = () => {
        holder.innerHTML = archivedView
          ? archivedMarkup(reply.projects)
          : projectsMarkup(reply.projects, reply.counts, allComplete);
        ProjectCard.bind(holder, reply.projects, handlers.onOpenProject);
        const on = (id, fn) => {
          const el = holder.querySelector('#' + id);
          if (el) el.addEventListener('click', fn);
        };
        on('js-new-project', () => LSCRouter.go('/projects/new'));
        on('js-archived', () => LSCRouter.go(tabPath(client.id, 'projects') + '?view=archived'));
        on('js-all-projects', () => LSCRouter.go(tabPath(client.id, 'projects')));
        on('js-declined', () => LSCRouter.go('/pipeline?' + new URLSearchParams({ stage: 'declined', q: client.businessName || '' })));
        on('js-all-complete', () => {
          allComplete = true;
          draw();
          // The first card that was hidden: the keyboard carries on from there.
          const cards = holder.querySelectorAll('#grid-complete .card-open');
          if (cards[COMPLETE_SHOWN]) cards[COMPLETE_SHOWN].focus();
        });
      };
      draw();
      // The link that brought us here went with the last draw: don't drop the keyboard at the top of the page.
      if (document.activeElement === document.body) box.focus({ preventScroll: true });
    };
    bindCardActions(holder, client, reload);
    await reload();
  }

  // ── Client details tab ────────────────────────────────────────────────────

  function field(id, label, value, extra) {
    const x = extra || {};
    return (
      '<div class="field' + (x.full ? ' full' : '') + '"><label for="' + id + '">' + label + '</label>' +
      (x.textarea
        ? '<textarea id="' + id + '">' + esc(value) + '</textarea>'
        : '<input id="' + id + '" type="' + (x.type || 'text') + '"' + (x.attrs ? ' ' + x.attrs : '') + ' value="' + esc(value) + '"' +
          (x.hint ? ' aria-describedby="' + id + '-hint"' : '') + '>') +
      (x.hint ? '<p class="client-field-hint' + (x.warn ? ' is-warn' : '') + '" id="' + id + '-hint">' + x.hint + '</p>' : '') +
      '</div>'
    );
  }

  function emailHint(client) {
    const shared = (client && client.emailSharedWith) || [];
    if (shared.length) {
      const names = shared.map((c) => esc(c.businessName)).join(', ');
      return { warn: true, text: 'Also on ' + names + '. A portal login can’t be shared, so give each client their own before inviting them.' };
    }
    if (client && !client.email) return { warn: true, text: 'No email yet. The client needs one to be invited to the portal.' };
    return { text: 'The client signs in to the portal with this, so each client has their own.' };
  }

  function formMarkup(client) {
    const c = client || {};
    const hint = emailHint(client);
    return (
      '<div class="form-grid">' +
      field('c-business', 'Business Name *', c.businessName || '', { full: true }) +
      field('c-contact', 'Contact name', c.contactName || '') +
      field('c-email', 'Email', c.email || '', { type: 'email', hint: hint.text, warn: hint.warn }) +
      field('c-phone', 'Phone', c.phone || '', { type: 'tel' }) +
      field('c-abn', 'ABN', abnFormat(c.abn), { attrs: 'inputmode="numeric" placeholder="e.g. 51 824 753 556"' }) +
      field('c-address', 'Address', c.address || '', { full: true }) +
      field('c-notes', 'Notes', c.notes || '', { full: true, textarea: true }) +
      '</div>' +
      '<div id="client-error" role="alert"></div>' +
      '<div class="form-actions">' +
      (client ? '<button type="button" class="btn btn-danger btn-sm" id="js-delete" data-write>Delete</button>' : '') +
      (client ? '' : '<button type="button" class="btn btn-ghost" id="js-cancel">Cancel</button>') +
      '<button type="button" class="btn btn-accent" id="js-save" data-write>' +
      '<span class="spinner" id="client-spin"></span><span id="client-save-label">Save client</span></button>' +
      '</div>' +
      (client ? '<p class="client-field-hint">Changes apply to new estimates. Ones already saved keep their own copy.</p>' : '')
    );
  }

  function drawDetails(box, client) {
    box.innerHTML = formMarkup(client);
    bindForm(box, client);
  }

  /* The form's behaviour, for a client's Details tab and for a new client. */
  function bindForm(box, client) {
    const $ = (id) => box.querySelector('#' + id);
    let saving = false;

    /* Is this form still on #main? A save or delete is async and the nav doesn't
       wait for it, so its outcome can land after the user has gone elsewhere —
       at which point re-rendering would pull them back to a client they had left. */
    const onScreen = () => box.isConnected && Boolean(box.querySelector('#c-business'));

    const showError = (message) => {
      const el = $('client-error');
      if (!el) return; // left while the request was in flight
      el.textContent = message;
      el.classList.add('show');
    };
    const clearError = () => LSCUtil.clearFieldErrors($('client-error'));
    const fieldError = (msg, id) => LSCUtil.showFieldErrors($('client-error'), [{ msg, field: $(id) }]);
    const setSaving = (next) => {
      // The flag first: it has to be cleared even when the controls have gone.
      saving = next;
      if (!onScreen()) return;
      $('js-save').disabled = next;
      $('client-spin').style.display = next ? 'inline-block' : 'none';
      $('client-save-label').textContent = next ? 'Saving…' : 'Save client';
      if ($('js-delete')) $('js-delete').disabled = next;
    };

    function read() {
      const body = {};
      FIELDS.forEach(([key, id]) => {
        body[key] = $(id).value.trim();
      });
      body.abn = abnDigits(body.abn);
      return body;
    }

    async function save() {
      if (saving) return;
      clearError();
      const body = read();
      if (!body.businessName) {
        fieldError('Enter a business name before saving.', 'c-business');
        return;
      }
      if (body.abn && !abnValid(body.abn)) {
        fieldError('That ABN doesn’t check out — it should be 11 digits, as shown on the ABN Lookup.', 'c-abn');
        return;
      }

      setSaving(true);
      Toast.working('Saving…');
      try {
        // The full list, not ?q= — search is capped at 20 partial matches, which
        // could leave the exact one out.
        const all = (await LSCApi.get('/api/clients')).clients || [];
        const clash = all.find((c) => sameName(c.businessName, body.businessName) && (!client || c.id !== client.id));
        if (clash) {
          setSaving(false);
          Toast.hide();
          fieldError(
            'There’s already a client called “' + clash.businessName + '”. Edit that one instead, or use a different name.',
            'c-business'
          );
          return;
        }
        const reply = client
          ? await LSCApi.put('/api/clients/' + encodeURIComponent(client.id), body)
          : await LSCApi.post('/api/clients', body);
        Toast.ok('Client saved.');
        if (!onScreen()) return;
        if (client) {
          // Redraws from the server's copy, which re-registers the unsaved-edits
          // watcher against a fresh baseline.
          record = reply.client;
          repaintHead(record);
          drawDetails(box, record);
          box.querySelector('#js-save').focus();
        } else {
          // A new client's #/clients/new becomes its own address.
          LSCRouter.go(tabPath(reply.client.id, 'projects'), { replace: true, skipGuard: true, state: { client: reply.client } });
        }
      } catch (err) {
        setSaving(false);
        Toast.hide();
        if (!(err instanceof LSCApi.ApiError)) throw err;
        if (err.kind === 'auth') return handlers.onAuthLost({ keepScreen: true });
        // The address is someone's portal login: the message says whose.
        if (err.code === 'email_taken' || err.code === 'email_required') {
          fieldError(err.message, 'c-email');
          return;
        }
        showError(failureText(err, 'save') + (err.kind === 'network' ? ' Your changes are still here.' : ''));
      }
    }

    async function remove() {
      if (saving || !client) return;
      // Known to be refused: say why now rather than after a confirm.
      if (client.projectCount > 0) {
        showError(
          'Couldn’t delete: this client has ' + (client.projectCount === 1 ? 'a project' : client.projectCount + ' projects') +
          ', so they stay on your list. Archive finished work from the Projects tab to file it away.'
        );
        return;
      }
      if (!window.confirm('Delete ' + (client.businessName || 'this client') + ' from your client list?')) return;

      setSaving(true);
      Toast.working('Deleting…');
      try {
        await LSCApi.del('/api/clients/' + encodeURIComponent(client.id));
        Toast.ok('Client deleted.');
        if (!onScreen()) return;
        // Replaces rather than going Back: the record behind it is gone.
        LSCRouter.go(LIST, { replace: true, skipGuard: true });
      } catch (err) {
        setSaving(false);
        Toast.hide();
        if (!(err instanceof LSCApi.ApiError)) throw err;
        if (err.kind === 'auth') return handlers.onAuthLost({ keepScreen: true });
        showError(failureText(err, 'delete'));
      }
    }

    /* read() trims, so this compares what would be saved rather than what is
       literally in the fields — a trailing space typed and left is not worth a
       dialog, since saving would discard it too. */
    const snapshot = () => JSON.stringify(read());
    const baseline = snapshot();
    LSCUnsaved.watch('client-editor', {
      label: client ? 'this client' : 'this new client',
      onScreen,
      dirty: () => snapshot() !== baseline,
    });

    $('js-save').addEventListener('click', save);
    if ($('js-delete')) $('js-delete').addEventListener('click', remove);
    if ($('js-cancel')) $('js-cancel').addEventListener('click', () => LSCRouter.leaveTo(LIST, { replace: true }));
  }

  /* #/clients/new: the form, under its own head. There's no record yet, so no tabs. */
  function showNew() {
    record = null;
    window.scrollTo(0, 0);
    root.innerHTML =
      '<button class="back-btn" id="js-back">← Clients</button>' +
      '<div class="page-head"><div><h1 class="page-title">New client</h1>' +
      '<div class="page-sub">Saved to your client list</div></div></div>' +
      '<div id="client-new"></div>';
    root.querySelector('#js-back').addEventListener('click', () => LSCRouter.leaveTo(LIST, { replace: true }));
    document.title = LSCShell.title('New client');
    const box = root.querySelector('#client-new');
    drawDetails(box, null);
    box.querySelector('#c-business').focus();
  }

  // ── Invoice index tab ─────────────────────────────────────────────────────

  const STATUS_WORD = { draft: 'Draft', scheduled: 'Scheduled', sent: 'Sent', paid: 'Paid', void: 'Void' };
  const KIND_WORD = { deposit: 'Deposit', final: 'Final', single: 'Invoice', legacy: 'Invoice' };

  /* Its status, from the same facts as the folder's invoice row: an unpaid one
     made the old way never recorded going out, and a sent one past its date is
     overdue on this browser's clock. */
  function invoiceStatus(inv, todayYmd) {
    if (inv.kind === 'legacy' && inv.status !== 'paid') return { word: 'Legacy', tone: 'neutral' };
    const due = String(inv.dueAt || '').slice(0, 10);
    if (inv.status === 'sent' && due && due < todayYmd) return { word: 'Overdue', tone: 'alert' };
    return { word: STATUS_WORD[inv.status] || inv.status, tone: inv.status };
  }

  function invoiceRow(inv, todayYmd) {
    const status = invoiceStatus(inv, todayYmd);
    const when = (value) => (value ? esc(ProjectCard.dayMonth(value, todayYmd)) : '—');
    const name = inv.hnryNumber || inv.number || 'No number';
    const project = inv.project || {};
    const voided = inv.status === 'void';
    return (
      '<tr' + (voided ? ' class="is-void"' : '') + '>' +
      '<td data-label="Invoice"><a class="client-invoice-link" data-project="' + esc(inv.projectId) + '" href="#/projects/' +
      encodeURIComponent(inv.projectId) + '/invoices/' + encodeURIComponent(inv.id) + '">' + esc(name) + '</a>' +
      '<div class="client-invoice-kind">' + esc(KIND_WORD[inv.kind] || 'Invoice') + '</div></td>' +
      // One child per cell: on a phone each cell is a label and a value, spaced apart.
      '<td data-label="Project"><span>' + esc(project.name || 'Untitled') +
      (project.upid ? ' <span class="client-invoice-upid">' + esc(project.upid) + '</span>' : '') + '</span></td>' +
      '<td data-label="Issued">' + when(inv.issuedAt) + '</td>' +
      '<td data-label="Due">' + (inv.status === 'paid' ? '—' : when(inv.dueAt)) + '</td>' +
      '<td data-label="Status"><span><span class="client-invoice-status is-' + esc(status.tone) + '">' + esc(status.word) + '</span>' +
      (inv.status === 'paid' && inv.paidAt ? ' <span class="client-invoice-paid">' + when(inv.paidAt) + '</span>' : '') + '</span></td>' +
      '<td class="right bill" data-label="Amount">' + fmt(inv.amountDue) + '</td>' +
      '</tr>'
    );
  }

  async function loadInvoices(box, client) {
    const holder = document.createElement('div');
    box.replaceChildren(holder);
    holder.innerHTML = '<p class="client-history-empty" role="status">Loading invoices…</p>';
    let reply;
    try {
      reply = await LSCApi.get('/api/clients/' + encodeURIComponent(client.id) + '/invoices');
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return handlers.onAuthLost();
      if (holder.isConnected) panelFailure(holder, err, 'their invoices', () => loadInvoices(box, client));
      return;
    }
    if (!holder.isConnected) return; // moved on while it loaded
    const invoices = reply.invoices || [];
    if (!invoices.length) {
      holder.innerHTML =
        '<div class="empty-state"><h3>No invoices yet</h3>' +
        '<p>A project’s invoices appear here from the day its quote is accepted.</p></div>';
      return;
    }
    const ymd = LSCUtil.today();
    holder.innerHTML =
      '<dl class="client-invoice-sums">' +
      '<div><dt>Outstanding</dt><dd>' + fmt(reply.outstanding) + '</dd></div>' +
      '<div><dt>Paid</dt><dd>' + fmt(reply.paid) + '</dd></div>' +
      '</dl>' +
      '<div class="est-block client-invoices"><table class="est-table">' +
      '<thead><tr><th scope="col">Invoice</th><th scope="col">Project</th><th scope="col">Issued</th><th scope="col">Due</th>' +
      '<th scope="col">Status</th><th scope="col" class="right">Amount</th></tr></thead>' +
      '<tbody>' + invoices.map((inv) => invoiceRow(inv, ymd)).join('') + '</tbody></table></div>';
    // The invoice's screen lights Clients once loaded; this lights it from the start.
    holder.addEventListener('click', (e) => {
      const link = e.target.closest('.client-invoice-link');
      if (link) LSCShell.notePlace(link.dataset.project, { area: 'clients', page: null });
    });
  }

  return {
    /* Once per sign-in. */
    init(container, options) {
      root = container;
      handlers = options;
    },

    /* The router's way in: the route, whose segments after 'clients' say the
       screen. False for a shape this area doesn't have. */
    show(route, state) {
      const [, id, tab, extra] = route.segments;
      if (id === undefined) {
        const q = (route.query.get('q') || '').trim();
        const canonical = listPath(q);
        if (canonical !== route.key) {
          LSCRouter.go(canonical, { replace: true, skipGuard: true });
          return true;
        }
        showList(q);
        return true;
      }
      if (id === 'new') {
        if (tab !== undefined) return false;
        showNew();
        return true;
      }
      if (extra !== undefined) return false;
      // A client opens on Projects (IA); an old link to the record lands there too.
      if (tab === undefined) {
        LSCRouter.go(tabPath(id, 'projects'), { replace: true, skipGuard: true, state });
        return true;
      }
      if (!TABS.some(([key]) => key === tab)) return false;
      // Only Projects has a view; an address this tab wouldn't write is put right.
      const view = tab === 'projects' && route.query.get('view') === 'archived' ? 'archived' : null;
      const canonical = tabPath(id, tab) + (view ? '?view=archived' : '');
      if (canonical !== route.key) {
        LSCRouter.go(canonical, { replace: true, skipGuard: true, state });
        return true;
      }
      showRecord(id, tab, view, state && state.client);
      return true;
    },
  };
})();
