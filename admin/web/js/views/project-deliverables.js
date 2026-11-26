'use strict';

/* A project's Deliverables tab (merged-admin R3; IA "Project: Deliverables"): the
 * checklist, and one item's page under it at .../deliverables/<itemId>. The hub
 * editor's asset list, on real records (server/src/routes/deliverables.js).
 *
 * ProjectFolder owns the screen and calls draw() with the panel and a context:
 *   folder              the reply on screen
 *   itemId              the item asked for, or null for the checklist
 *   apply(reply, focus) the folder a write answered with: redraw, then focus that
 *   confirm(el, opts)   its dialog
 *   authLost(), missing()
 *
 * Every write answers with the folder, so nothing here patches itself. A write
 * outcome can land after the screen has gone: apply() checks that.
 */

const ProjectDeliverables = (() => {
  const { esc } = LSCUtil;

  const STAGE = { draft: 'Draft Cut', final: 'Final' };
  const PHOTOS_SHOWN = 12;

  let ctx = null;
  let box = null;
  const $ = (id) => box.querySelector('#' + id);
  const apiBase = () => '/api/projects/' + encodeURIComponent(ctx.folder.project.id) + '/deliverables';
  const folderPathOf = () => '/projects/' + encodeURIComponent(ctx.folder.project.id) + '/deliverables';
  const itemPath = (id) => folderPathOf() + '/' + encodeURIComponent(id);
  const versionUrl = (item, v, tail) => apiBase() + '/' + encodeURIComponent(item.id) + '/versions/' + encodeURIComponent(v.id) + (tail || '');
  const newestOf = (item) => item.versions[item.versions.length - 1] || null;
  /* Filed away: nothing changes until it's unarchived (the server refuses it), so
     nothing here offers to. */
  const filed = () => Boolean(ctx.folder.project.archivedAt);
  const today = () => LSCUtil.today();
  const when = (value) => ProjectCard.dayMonth(value, today());

  function showError(message) {
    const el = $('dlv-error');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
  }
  function clearError() {
    const el = $('dlv-error');
    if (!el) return;
    el.textContent = '';
    el.classList.remove('show');
  }

  /* Every field a redraw would wipe, by form. A write's `saves` names the ones the
     reply now answers for; whatever else is half-typed comes back after the redraw.
     Restored text differs from the field's default, so it still counts as unsaved. */
  const ADD_ITEM = ['dlv-add-title', 'dlv-add-format', 'dlv-add-duration'];
  const DETAILS = ['dlv-title', 'dlv-format', 'dlv-duration'];
  const ADD_VERSION = ['dlv-path', 'dlv-new-drive'];
  const DRIVE = ['dlv-drive-link'];
  const FIELDS = [...ADD_ITEM, ...DETAILS, ...ADD_VERSION, ...DRIVE];

  function halfTyped(saved) {
    const kept = [];
    FIELDS.forEach((id) => {
      const el = (saved || []).includes(id) ? null : $(id);
      if (el && el.value !== el.defaultValue) kept.push([id, el.value]);
    });
    return kept;
  }

  const failureText = (err) => (err.kind === 'network' ? 'The server is unreachable.' : err.message || 'The server refused.');

  /* A write that answers with the folder. On a refusal the message goes in the
     panel's error line, or rejects for a dialog to show (`rethrow`). */
  async function write(method, url, body, opts) {
    const o = opts || {};
    clearError();
    if (o.working) Toast.working(o.working);
    const sep = url.includes('?') ? '&' : '?';
    try {
      const reply = await LSCApi[method](url + sep + 'today=' + today(), body);
      if (o.ok) Toast.ok(o.ok);
      else Toast.hide();
      const kept = halfTyped(o.saves);
      ctx.apply(reply, o.focus);
      kept.forEach(([id, value]) => {
        const el = $(id);
        if (el) el.value = value;
      });
      return reply;
    } catch (err) {
      Toast.hide();
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') {
        ctx.authLost();
        return null;
      }
      // The record is gone. A path with nothing at it (file_not_found) is a refusal.
      if (err.code === 'not_found') {
        ctx.missing();
        return null;
      }
      if (o.rethrow) throw err;
      if (o.onRefused) o.onRefused(err);
      else showError(failureText(err));
      return null;
    }
  }

  /* While a write is out, its own button waits. */
  async function busyWhile(button, run) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await run();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  // ── The checklist ─────────────────────────────────────────────────────────

  function progressText(checklist) {
    const counted = checklist.total - checklist.notNeeded;
    if (!checklist.total) return 'Nothing on it yet';
    return checklist.approved + ' of ' + counted + ' approved' + (checklist.notNeeded ? ' · ' + checklist.notNeeded + ' not needed' : '');
  }

  /* A draft's approval lets the studio go on; only a Final's signs the item off (C5). */
  const approvedWord = (a) => (a.stage !== 'final' ? 'draft approved' : a.kind === 'deemed' ? 'deemed approved' : 'approved');

  function fileLine(item) {
    const newest = newestOf(item);
    if (!newest) return 'No file yet';
    const published = item.versions.filter((v) => v.publishedAt).pop();
    if (newest.approval) return 'v' + newest.n + ' ' + approvedWord(newest.approval) + ' ' + when(newest.approval.approvedAt);
    if (newest.publishedAt) {
      const clock = deemedOf(item);
      return 'v' + newest.n + ' published ' + when(newest.publishedAt) + (clock && clock.due ? ' · approval due' : '');
    }
    const bunny = { none: ' · send to Bunny first', processing: ' · Bunny processing', failed: ' · Bunny failed', ready: ' · Bunny has an old cut' }[bunnyHold(newest)] || '';
    return 'v' + newest.n + ' not published' + bunny + (published ? ' · v' + published.n + ' is with the client' : '');
  }

  /* Sets sent on Finals (C5). Past the included ones the client was told it's charged
     work, quoted first; nothing is charged on its own. */
  /* Rounds per Final come with the item (delivery.js ROUNDS_INCLUDED). */
  function roundsText(item) {
    const used = Number(item.roundsUsed) || 0;
    const included = Number(item.roundsIncluded) || 0;
    return used + ' of ' + included + ' rounds used' + (used > included ? ' · ' + (used - included) + ' extra' : '');
  }
  function roundsLine(item) {
    return item.stage === 'final' || item.roundsUsed
      ? '<span class="dlv-rounds' + (item.roundsUsed > item.roundsIncluded ? ' is-over' : '') + '">' + esc(roundsText(item)) + '</span>' : '';
  }

  function rowMarkup(item) {
    const newest = newestOf(item);
    const off = Boolean(item.notNeededAt);
    const meta = [item.format, item.duration].filter(Boolean).join(' · ');
    const named = item.title;
    // A video waiting on Bunny opens its page, where Send to Bunny is.
    const canPublish = newest && !newest.publishedAt && !off && !filed() && !bunnyHold(newest);
    const primary = filed()
      ? '<button type="button" class="btn btn-sm" data-dlv="open" data-id="' + esc(item.id) + '" aria-label="Open ' + esc(named) + '">Open</button>'
      : off
      ? '<button type="button" class="btn btn-sm" data-write data-dlv="needed" data-id="' + esc(item.id) + '" aria-label="Mark needed: ' + esc(named) + '">Mark needed</button>'
      : canPublish
        ? '<button type="button" class="btn btn-sm" data-write data-dlv="publish" data-id="' + esc(item.id) + '" aria-label="Publish v' + newest.n + ' of ' + esc(named) + '">Publish v' + newest.n + '…</button>'
        : '<button type="button" class="btn btn-sm" data-dlv="open" data-id="' + esc(item.id) + '" aria-label="' + (newest ? 'Open ' : 'Add a file to ') + esc(named) + '">' + (newest ? 'Open' : 'Add file') + '</button>';
    const extra = !item.estimateId && !item.quoteLineId && !item.versions.some((v) => v.publishedAt);
    const items = filed() ? [] : [
      canPublish ? { text: 'Open', attrs: { 'data-dlv': 'open', 'data-id': item.id } } : null,
      off ? null : { text: 'Mark not needed', attrs: { 'data-dlv': 'not-needed', 'data-id': item.id, 'data-write': '' } },
      extra ? { text: 'Remove…', danger: true, attrs: { 'data-dlv': 'remove', 'data-id': item.id, 'data-write': '' } } : null,
    ].filter(Boolean);
    return (
      '<li class="dlv-row' + (off ? ' is-off' : '') + '">' +
      '<div class="dlv-row-id"><h3 class="dlv-row-title"><a href="#' + esc(itemPath(item.id)) + '" data-go="' + esc(itemPath(item.id)) + '">' + esc(named) + '</a></h3>' +
      (meta ? '<p class="dlv-row-meta">' + esc(meta) + '</p>' : '') + '</div>' +
      '<div class="dlv-row-state">' +
      (off
        ? '<span class="pf-chip">Not needed</span>'
        : '<span class="pf-chip' + (item.stage === 'final' ? ' is-info' : '') + '">' + STAGE[item.stage] + '</span>' +
          '<span class="dlv-file">' + esc(fileLine(item)) + '</span>' + roundsLine(item)) +
      '</div>' +
      '<div class="dlv-row-acts">' + primary +
      (items.length ? LSCMenu.markup({ id: 'dlv-menu-' + item.id, label: 'More', ariaLabel: 'More for ' + named, items }) : '') +
      '</div></li>'
    );
  }

  function emptyMarkup(project) {
    if (filed()) return '<div class="panel-body"><p class="pf-empty">No deliverables on this project.</p></div>';
    if (project.noDeliverablesAt) {
      return (
        '<div class="panel-body dlv-ask"><p>You said no deliverables are expected on this project.</p>' +
        '<button type="button" class="btn btn-sm" data-write data-dlv="expected">Deliverables are expected after all</button></div>'
      );
    }
    return (
      '<div class="panel-body dlv-ask"><p><strong>This project has no deliverables yet.</strong> ' +
      'Its quote had none on it. Add the first below, or say none are expected. An empty checklist never completes a project.</p>' +
      '<button type="button" class="btn btn-sm" data-write data-dlv="none-expected">No deliverables expected</button></div>'
    );
  }

  function addFormMarkup() {
    return (
      '<form class="dlv-add" id="dlv-add" novalidate>' +
      '<div class="form-grid">' +
      '<div class="field full"><label for="dlv-add-title">Title *</label><input id="dlv-add-title" type="text" maxlength="200" autocomplete="off"></div>' +
      '<div class="field"><label for="dlv-add-format">Format</label><input id="dlv-add-format" type="text" maxlength="100" placeholder="e.g. 16:9" autocomplete="off"></div>' +
      '<div class="field"><label for="dlv-add-duration">Length</label><input id="dlv-add-duration" type="text" maxlength="100" placeholder="e.g. 30s" autocomplete="off"></div>' +
      '</div>' +
      '<div class="form-actions"><button type="submit" class="btn" data-write>Add deliverable</button></div>' +
      '</form>'
    );
  }

  function checklistMarkup() {
    const { project, deliverables } = ctx.folder;
    const state = project.delivery;
    return (
      (filed() ? '<p class="pf-notice dlv-filed" role="note">Archived, so this is read-only. Unarchive it from Actions to change anything here.</p>' : '') +
      '<section class="panel" aria-labelledby="dlv-h">' +
      '<div class="panel-head"><h2 class="panel-title" id="dlv-h">Checklist</h2>' +
      '<p class="dlv-progress">' + esc(progressText(state.checklist)) + '</p></div>' +
      (deliverables.length
        ? '<div class="panel-body is-flush"><ol class="dlv-list">' + deliverables.map(rowMarkup).join('') + '</ol></div>'
        : emptyMarkup(project)) +
      inviteMarkup() +
      '<div class="dlv-error" id="dlv-error" role="alert"></div>' +
      '</section>' +
      (filed() ? '' : '<section class="panel dlv-add-panel" aria-labelledby="dlv-add-h"><div class="panel-head"><h2 class="panel-title" id="dlv-add-h">Add an extra deliverable</h2></div>' +
      '<div class="panel-body">' + addFormMarkup() + '</div></section>')
    );
  }

  /* A failed invite's code and link (C6), kept for this project until the studio
     dismisses them: this is the only time they exist, so no redraw or later error
     may wipe them, and coming back to the project shows them again. Only a reload
     lets them go; the invite line still offers to send it again. */
  let handover = null;

  /* What the portal invite did, in words, from a reply's `inviteResult` (C6). A
     failed email hands over the code and link (handoverMarkup). */
  function inviteOutcome(result) {
    if (!result) return '';
    if (result.sent) return ' Portal invite emailed to ' + result.to + '.';
    if (result.failed) return ' The invite email didn’t go.';
    return ' No invite was sent' + (result.message ? ': ' + result.message.replace(/^./, (c) => c.toLowerCase()) : '.');
  }

  /* Holds a failed invite's code for this project and redraws so it shows. */
  function keepHandover(result) {
    if (!result || !result.failed) return;
    handover = { projectId: ctx.folder.project.id, ...result };
    draw(box, ctx);
  }

  function handoverMarkup() {
    if (!handover || handover.projectId !== ctx.folder.project.id) return '';
    return '<div class="dlv-handover" role="alert" aria-labelledby="dlv-handover-h">' +
      '<p class="dlv-handover-h" id="dlv-handover-h">The invite email to ' + esc(handover.to) + ' didn’t go</p>' +
      '<p class="dlv-note">' + esc(handover.error) + '</p>' +
      '<p class="dlv-note">Pass these on yourself, or send the invite again (which replaces this code). They won’t be shown again once you close this.</p>' +
      '<dl class="dlv-approval-rec"><dt>Sign-in</dt><dd class="dlv-approval-ua">' + esc(handover.inviteUrl) + '</dd>' +
      '<dt>Client code</dt><dd class="fig">' + esc(handover.code) + '</dd></dl>' +
      '<button type="button" class="btn btn-sm" id="dlv-handover-done">I’ve noted them</button></div>';
  }

  function publish(item, opener) {
    const v = newestOf(item);
    if (!v) return;
    const offer = ctx.folder.invite || {};
    const inviting = offer.state === 'ready' && offer.firstPublish;
    const noEmail = offer.firstPublish && offer.state === 'no_email';
    ctx.confirm(opener, {
      title: 'Publish v' + v.n + '?',
      body: 'v' + v.n + ' (' + (v.fileName || v.sourcePath) + ') becomes the ' + STAGE[v.stage] + ' the client reviews, and the project goes In review. ' +
        'A published version can’t be changed, only followed by a new one.' +
        (inviting ? ' This is the first thing the client will see, so you can invite them to the Client Portal now.'
          : noEmail ? ' No email goes out: the client has no email on file, so add one in Client details to invite them.'
            : ' No email goes out.'),
      confirm: 'Publish',
      choice: inviting ? {
        legend: 'Portal invite',
        options: [
          { value: 'invite', label: 'Publish and email their sign-in to ' + offer.to },
          { value: 'none', label: 'Publish only, send no email' },
        ],
      } : undefined,
      run: async (ok, pick) => {
        const reply = await write('post', versionUrl(item, v, '/publish'), inviting ? { invite: pick === 'invite' } : undefined, {
          working: 'Publishing…',
          rethrow: true,
        });
        if (!reply) return;
        const result = reply.inviteResult;
        const words = 'v' + v.n + ' published.' + inviteOutcome(result);
        if (result && result.failed) Toast.error(words);
        else Toast.ok(words);
        keepHandover(result);
      },
    });
  }

  function sendInvite(opener) {
    const offer = ctx.folder.invite || {};
    const again = offer.state === 'retry';
    const published = (ctx.folder.deliverables || []).some((d) => d.versions.some((v) => v.publishedAt));
    ctx.confirm(opener, {
      title: (again ? 'Send the invite to ' : 'Invite ') + (offer.name || 'the client') + (again ? ' again?' : ' to the portal?'),
      body: 'Emails ' + offer.to + ' a link and a new Client code to sign in with. ' +
        (again ? 'The code from the invite that didn’t go stops working, including if you passed it on yourself. '
          : 'Anything they could sign in with before stops working. ') +
        (published ? '' : 'They’ll see nothing until you publish a version.'),
      confirm: again ? 'Send again' : 'Send invite',
      run: async () => {
        const reply = await write('post', '/api/projects/' + encodeURIComponent(ctx.folder.project.id) + '/portal-invite', undefined, {
          working: 'Sending…',
          rethrow: true,
        });
        if (!reply) return;
        const result = reply.inviteResult || {};
        if (result.sent) {
          handover = null;
          Toast.ok('Invite emailed to ' + result.to + '.');
          draw(box, ctx);
        } else {
          Toast.error('The invite email to ' + (result.to || offer.to) + ' didn’t go.');
          keepHandover(result);
        }
      },
    });
  }

  /* One line under the checklist: not invited yet (with the button), an invite whose
     email didn't go (send it again), invited, or why not. A failed invite's code
     and link sit above it until dismissed. */
  function inviteMarkup() {
    const offer = ctx.folder.invite || {};
    if (filed()) return '';
    return handoverMarkup() + inviteLine(offer);
  }

  function inviteLine(offer) {
    if (offer.state === 'retry') {
      return '<p class="dlv-invite">The portal invite email didn’t go on ' + esc(when(offer.failedAt)) + '. ' +
        '<button type="button" class="btn btn-sm" data-write id="dlv-invite">Send it to ' + esc(offer.to) + ' again…</button></p>';
    }
    if (offer.state === 'ready') {
      return '<p class="dlv-invite">Not invited to the portal yet. ' +
        '<button type="button" class="btn btn-sm" data-write id="dlv-invite">Invite ' + esc(offer.to) + '…</button></p>';
    }
    if (offer.state === 'sent') return '<p class="dlv-invite">Invited to the portal ' + esc(when(offer.at)) + '.</p>';
    if (offer.state === 'no_email') return '<p class="dlv-invite">Add the client’s email in Client details to invite them to the portal.</p>';
    return '';
  }

  function setNotNeeded(item, on, button) {
    return busyWhile(button, () => write('put', apiBase() + '/' + encodeURIComponent(item.id), { notNeeded: on }, {
      working: 'Saving…',
      ok: on ? 'Marked not needed.' : 'Back on the checklist.',
      focus: '.dlv-row-title a',
    }));
  }

  function removeItem(item, opener) {
    ctx.confirm(opener, {
      title: 'Remove this deliverable?',
      body: 'This takes “' + item.title + '” off the checklist' + (item.versions.length ? ', with its unpublished ' + (item.versions.length === 1 ? 'version' : 'versions') : '') + '.',
      confirm: 'Remove',
      danger: true,
      run: () => write('del', apiBase() + '/' + encodeURIComponent(item.id), undefined, {
        working: 'Removing…',
        ok: 'Removed.',
        rethrow: true,
        focus: '#dlv-add-title',
      }),
    });
  }

  /* Rows' actions: the menu's items are clicked in place, so these find them too. */
  function bindChecklist() {
    const { deliverables } = ctx.folder;
    const itemOf = (el) => deliverables.find((d) => d.id === el.dataset.id);
    box.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      LSCRouter.go(a.dataset.go);
    }));
    box.querySelectorAll('[data-dlv]').forEach((b) => b.addEventListener('click', () => {
      const opener = b.closest('.menu') ? b.closest('.menu').querySelector('.menu-btn') : b;
      const item = itemOf(b);
      const act = b.dataset.dlv;
      if (act === 'open') return LSCRouter.go(itemPath(item.id));
      if (act === 'publish') return publish(item, opener);
      if (act === 'not-needed') return setNotNeeded(item, true, opener);
      if (act === 'needed') return setNotNeeded(item, false, b);
      if (act === 'remove') return removeItem(item, opener);
      if (act === 'none-expected' || act === 'expected') {
        return busyWhile(b, () => write('post', '/api/projects/' + encodeURIComponent(ctx.folder.project.id) + '/no-deliverables',
          { on: act === 'none-expected' }, {
            working: 'Saving…',
            ok: act === 'none-expected' ? 'Noted: no deliverables expected.' : 'Noted: deliverables are expected.',
            focus: '#dlv-add-title',
          }));
      }
      return undefined;
    }));
    const inviteBtn = $('dlv-invite');
    if (inviteBtn) inviteBtn.addEventListener('click', () => sendInvite(inviteBtn));
    const handoverDone = $('dlv-handover-done');
    if (handoverDone) handoverDone.addEventListener('click', () => {
      handover = null;
      draw(box, ctx);
    });
    const form = $('dlv-add');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const title = $('dlv-add-title');
      if (!title.value.trim()) {
        showError('Give the deliverable a title.');
        title.focus();
        return;
      }
      busyWhile(button, () => write('post', apiBase(), {
        title: title.value, format: $('dlv-add-format').value, duration: $('dlv-add-duration').value,
      }, { working: 'Adding…', ok: 'Added to the checklist.', focus: '#dlv-add-title', saves: ADD_ITEM }));
    });
  }

  // ── Bunny Stream (Bunny Slice 4) ──────────────────────────────────────────
  /* With Bunny on (the folder's bunnyOn), the client watches a video from Bunny
     Stream: Send to Bunny comes first, and the client's Publish waits until it's
     ready there with the file the NAS holds now. The two stay separate steps, since
     Bunny takes minutes and Publish can email the client. Photo libraries aren't
     sent yet (Bunny Slice 7). The folder carries each version's status; a read of
     /bunny adds the poster and whether the NAS file changed since, and is repeated
     while Bunny processes. The newest read is kept per version, so a redraw (any
     write's reply) starts from it, not from the older folder. */
  const BUNNY_CHECK_MS = 10000;
  const bunnyViews = new Map();
  let bunnyTimer = null;
  const stopBunnyChecks = () => {
    clearTimeout(bunnyTimer);
    bunnyTimer = null;
  };

  const bunnyApplies = (v) => Boolean(ctx.folder.bunnyOn && v && v.kind === 'video' && v.sourcePath);
  /* The folder's status wins when it differs (the webhook moved it on since the
     last read); the kept read adds the poster and the changed-file check. */
  function bunnyOf(v) {
    const status = v.bunny ? v.bunny.status : 'none';
    const seen = bunnyViews.get(v.id);
    if (seen && seen.status === status) return seen;
    return { status, error: v.bunny ? v.bunny.error : null, sourceChanged: false, posterUrl: null };
  }
  /* Why the client's Publish waits, or '' when it needn't. */
  function bunnyHold(v) {
    if (!bunnyApplies(v) || v.publishedAt) return '';
    const b = bunnyOf(v);
    return b.status === 'ready' && !b.sourceChanged ? '' : b.status;
  }
  /* A view the server answered with: kept, and the folder's copy brought level, so
     the checklist row says the same when the screen goes back to it. */
  function keepBunny(v, view) {
    const kept = { status: view.status, error: view.error || null, sourceChanged: Boolean(view.sourceChanged), posterUrl: view.posterUrl || null };
    bunnyViews.set(v.id, kept);
    v.bunny = view.status === 'none' ? null : { status: kept.status, error: kept.error, videoId: (v.bunny && v.bunny.videoId) || null };
    return kept;
  }

  const BUNNY_CHIP = {
    none: ['Not sent', 'is-void'],
    processing: ['Processing', 'is-info'],
    ready: ['Ready', 'is-ok'],
    failed: ['Failed', 'is-alert'],
  };

  function bunnyMarkup(item, v) {
    if (!bunnyApplies(v)) return '';
    const b = bunnyOf(v);
    const n = 'v' + v.n;
    const can = !filed() && !item.notNeededAt;
    const sent = Boolean(v.publishedAt);
    const chip = b.status === 'ready' && b.sourceChanged ? ['Old cut', 'is-alert'] : BUNNY_CHIP[b.status] || BUNNY_CHIP.none;
    const button = (label, force) => '<button type="button" class="btn btn-sm" data-write id="dlv-bunny-send"' +
      (force ? ' data-force' : '') + '>' + label + '</button>';
    let note = '';
    let act = '';
    if (b.status === 'processing') {
      note = 'Bunny is fetching the file from the NAS and transcoding it. This checks again every 10 seconds, and you can leave the page.';
    } else if (b.status === 'failed') {
      note = (b.error || 'Bunny couldn’t take it.') + (sent ? ' Until it’s there, the client watches it from the NAS.' : '');
      if (can) act = button('Send to Bunny again');
    } else if (b.status === 'ready' && b.sourceChanged) {
      note = sent
        ? 'The NAS file changed after ' + n + ' went out. The client still watches the cut on Bunny: add the new file as a new version.'
        : 'The NAS file changed after it went to Bunny, so Bunny has the old cut. Republish it before you publish ' + n + '.';
      if (can && !sent) act = button('Republish to Bunny…', true);
    } else if (b.status === 'ready') {
      note = sent ? 'The client watches it from Bunny.' : 'The client will watch it from Bunny once you publish ' + n + '.';
    } else {
      note = sent
        ? 'The client watches this from the NAS. Send it to Bunny and they’ll watch it from there once it’s ready.'
        : 'The client watches videos from Bunny Stream, so send it there before you publish. Bunny fetches it from the NAS and transcodes it, which takes a few minutes.';
      if (can) act = button('Send to Bunny');
    }
    const poster = b.status === 'ready' && b.posterUrl
      ? '<div class="dlv-bunny-poster"><img src="' + esc(b.posterUrl) + '" alt="" loading="lazy"></div>' : '';
    return (
      '<div class="dlv-bunny' + (poster ? ' has-poster' : '') + '" id="dlv-bunny">' + poster +
      '<div class="dlv-bunny-body">' +
      '<p class="dlv-bunny-head"><span class="dlv-bunny-label">Bunny Stream</span>' +
      '<span class="pf-chip ' + chip[1] + '">' + chip[0] + '</span></p>' +
      '<p class="dlv-note" id="dlv-bunny-note" role="status">' + esc(note) + '</p>' +
      (act ? '<div class="dlv-bunny-acts">' + act + '</div>' : '') +
      '</div></div>'
    );
  }

  /* Redraws the Bunny block and Publish's hold in place: the preview, a half-typed
     Drive link and focus elsewhere on the page are left alone. */
  function paintBunny(item, v) {
    const block = $('dlv-bunny');
    if (!block) return;
    const hadFocus = block.contains(document.activeElement);
    block.outerHTML = bunnyMarkup(item, v);
    bindBunny(item, v);
    const publishBtn = $('dlv-publish');
    if (publishBtn) {
      const held = Boolean(bunnyHold(v));
      publishBtn.disabled = held;
      if (held) publishBtn.setAttribute('aria-describedby', 'dlv-bunny-note');
      else publishBtn.removeAttribute('aria-describedby');
    }
    if (hadFocus) focusBunny();
  }
  /* Focus back on the block after its button was replaced: its next action, or the
     block itself while there is none (Processing), so the keyboard isn't dropped. */
  function focusBunny() {
    const block = $('dlv-bunny');
    if (!block) return;
    const publishBtn = $('dlv-publish');
    const next = $('dlv-bunny-send') || (publishBtn && !publishBtn.disabled ? publishBtn : null);
    if (next) return next.focus();
    block.setAttribute('tabindex', '-1');
    block.focus();
  }

  /* Reads where the publish stands, and again every 10 seconds while Bunny is
     processing it. Stops once the screen has moved on. */
  async function checkBunny(item, v) {
    stopBunnyChecks();
    const block = $('dlv-bunny');
    if (!block || !v.bunny) return;
    try {
      const view = await LSCApi.get(versionUrl(item, v, '/bunny'));
      if (!block.isConnected) return;
      keepBunny(v, view);
      paintBunny(item, v);
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return ctx.authLost();
      if (!block.isConnected) return;
      const note = $('dlv-bunny-note');
      if (note && err.kind !== 'network') note.textContent = 'Couldn’t check Bunny: ' + failureText(err);
    }
    if (bunnyOf(v).status === 'processing' && $('dlv-bunny')) {
      bunnyTimer = setTimeout(() => {
        if ($('dlv-bunny') && $('dlv-bunny').isConnected) checkBunny(item, v);
      }, BUNNY_CHECK_MS);
    }
    return undefined;
  }

  /* Sends the version to Bunny, or with force replaces the video it has there. The
     reply is the publish's state; a 502 (Bunny refused) carries it too, with why. */
  async function postBunny(item, v, force) {
    try {
      const view = await LSCApi.post(versionUrl(item, v, '/bunny'), force ? { force: true } : {});
      keepBunny(v, view);
      return { view };
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') {
        ctx.authLost();
        return null;
      }
      if (err.code === 'not_found') {
        ctx.missing();
        return null;
      }
      if (err.data && err.data.status) {
        keepBunny(v, err.data);
        return { view: err.data, refused: err.data.error || 'Bunny refused it.' };
      }
      return { refused: failureText(err) };
    }
  }

  function bindBunny(item, v) {
    // A thumbnail that won't load leaves the frame empty rather than a broken image.
    const poster = box.querySelector('.dlv-bunny-poster img');
    if (poster) poster.addEventListener('error', () => poster.remove(), { once: true });
    const send = $('dlv-bunny-send');
    if (!send) return;
    const settle = (result) => {
      if (!result || !$('dlv-bunny')) return;
      paintBunny(item, v);
      if (result.refused && (!result.view || result.view.status !== 'failed')) showError(result.refused);
      if (bunnyOf(v).status === 'processing') checkBunny(item, v);
    };
    if (send.hasAttribute('data-force')) {
      send.addEventListener('click', () => ctx.confirm(send, {
        title: 'Republish v' + v.n + ' to Bunny?',
        body: 'Bunny fetches ' + (v.fileName || 'the file') + ' from the NAS again, and v' + v.n + ' uses the new video once it’s ready. ' +
          'The old one stays on Bunny until cleanup takes it off.',
        confirm: 'Republish',
        run: async () => {
          clearError();
          const result = await postBunny(item, v, true);
          if (result && result.refused && !result.view) throw new Error(result.refused);
          settle(result);
          // The dialog hands focus back to the button it came from, which settle replaced.
          setTimeout(focusBunny, 0);
        },
      }));
      return;
    }
    send.addEventListener('click', () => busyWhile(send, async () => {
      clearError();
      Toast.working('Sending to Bunny…');
      const result = await postBunny(item, v, false);
      if (result && !result.refused) Toast.ok(result.view.status === 'ready' ? 'Ready on Bunny.' : 'Sent. Bunny is processing it.');
      else Toast.hide();
      settle(result);
    }));
  }

  // ── One deliverable ───────────────────────────────────────────────────────

  function stageMarkup(item) {
    const newest = newestOf(item);
    const radio = (value) =>
      '<label class="dlv-stage-opt"><input type="radio" name="dlv-stage" value="' + value + '"' + (item.stage === value ? ' checked' : '') + (filed() ? ' disabled' : ' data-write') + '>' +
      '<span>' + STAGE[value] + '</span></label>';
    const note = newest && newest.publishedAt && newest.stage !== item.stage
      ? 'v' + newest.n + ' went out as a ' + STAGE[newest.stage] + '. Add the ' + STAGE[item.stage] + '’s file as a new version.'
      : item.stage === 'final'
        ? 'The client approves, or sends notes that use a revision round. ' + item.roundsIncluded + ' rounds per Final.'
        : 'The client approves or sends notes. It’s never downloadable and no round is used.';
    return (
      '<fieldset class="dlv-stage"><legend>Stage</legend><div class="dlv-stage-opts">' + radio('draft') + radio('final') + '</div>' +
      '<p class="dlv-note" id="dlv-stage-note">' + esc(note) + '</p></fieldset>'
    );
  }

  function versionStatus(v) {
    if (v.approval) return approvedWord(v.approval).replace(/^./, (c) => c.toUpperCase()) + ' ' + when(v.approval.approvedAt);
    return v.publishedAt ? 'Published ' + when(v.publishedAt) : 'Not published';
  }

  function currentMarkup(item) {
    const v = newestOf(item);
    if (!v) return '';
    const what = v.kind === 'photos' ? v.photoCount + (v.photoCount === 1 ? ' photo' : ' photos') : 'Video';
    const off = Boolean(item.notNeededAt);
    const live = !filed();
    return (
      '<section class="panel" aria-labelledby="dlv-file-h">' +
      '<div class="panel-head"><h3 class="panel-title" id="dlv-file-h">Version ' + v.n + '</h3>' +
      '<span class="pf-chip' + (v.publishedAt ? ' is-ok' : '') + '">' + esc(versionStatus(v)) + '</span></div>' +
      '<div class="panel-body dlv-current">' +
      '<p class="dlv-file-name">' + esc(v.fileName || v.sourcePath) + '</p>' +
      '<p class="dlv-note">' + esc(what) + ' · ' + STAGE[v.stage] + '</p>' +
      '<p class="dlv-path ref">' + esc(v.sourcePath) + '</p>' +
      bunnyMarkup(item, v) +
      '<div class="dlv-acts">' +
      (live && !v.publishedAt && !off
        ? '<button type="button" class="btn" data-write id="dlv-publish"' +
          (bunnyHold(v) ? ' disabled aria-describedby="dlv-bunny-note"' : '') + '>Publish v' + v.n + '…</button>'
        : '') +
      '<button type="button" class="btn" id="dlv-preview">Preview</button>' +
      (live && !v.publishedAt ? '<button type="button" class="btn btn-ghost" data-write id="dlv-remove-version">Remove this version</button>' : '') +
      '</div>' +
      '<div class="dlv-preview" id="dlv-preview-box" hidden></div>' +
      (live
        ? '<form class="dlv-drive" id="dlv-drive" novalidate>' +
          '<div class="field"><label for="dlv-drive-link">Google Drive backup</label>' +
          '<input id="dlv-drive-link" type="url" inputmode="url" autocomplete="off" value="' + esc(v.driveLink || '') + '" aria-describedby="dlv-drive-hint">' +
          '<p class="client-field-hint" id="dlv-drive-hint">What the client is offered if the video won’t load.</p></div>' +
          '<button type="submit" class="btn btn-sm" data-write>Save link</button>' +
          '</form>'
        : '') +
      '</div></section>'
    );
  }

  function addVersionMarkup(item) {
    if (item.notNeededAt || filed()) return '';
    const newest = newestOf(item);
    return (
      '<section class="panel" aria-labelledby="dlv-add-v-h">' +
      '<div class="panel-head"><h3 class="panel-title" id="dlv-add-v-h">' + (newest ? 'Add a new version' : 'Add the file') + '</h3>' +
      '<span class="dlv-note">As ' + (newest ? 'v' + (newest.n + 1) + ', ' : '') + 'a ' + STAGE[item.stage] + '</span></div>' +
      '<div class="panel-body"><form id="dlv-add-version" novalidate>' +
      '<div class="field"><label for="dlv-path">Path on the NAS *</label>' +
      '<input id="dlv-path" type="text" spellcheck="false" autocomplete="off" aria-describedby="dlv-path-hint">' +
      '<p class="client-field-hint" id="dlv-path-hint">Copy it from the UGREEN file manager. A video takes the path to the file, ' +
      'a photo library the path to its folder (.jpg, .png, .webp, up to 200).</p></div>' +
      '<div class="field"><label for="dlv-new-drive">Google Drive backup</label>' +
      '<input id="dlv-new-drive" type="url" inputmode="url" autocomplete="off"></div>' +
      '<div class="form-actions"><button type="submit" class="btn" data-write>Add version</button></div>' +
      '</form></div></section>'
    );
  }

  function historyMarkup(item) {
    const older = item.versions.slice(0, -1).reverse();
    if (!older.length) return '';
    return (
      '<section class="panel" aria-labelledby="dlv-history-h">' +
      '<div class="panel-head"><h3 class="panel-title" id="dlv-history-h">Earlier versions<span class="panel-count">' + older.length + '</span></h3></div>' +
      '<div class="panel-body is-flush"><ol class="dlv-history">' + older.map((v) =>
        '<li><span class="dlv-history-n">v' + v.n + '</span><span class="dlv-history-file">' + esc(v.fileName || v.sourcePath) + '</span>' +
        '<span class="dlv-note">' + STAGE[v.stage] + ' · ' + esc(versionStatus(v)) + '</span></li>').join('') + '</ol></div></section>'
    );
  }

  function detailsFormMarkup(item) {
    return (
      '<section class="panel" aria-labelledby="dlv-details-h">' +
      '<div class="panel-head"><h3 class="panel-title" id="dlv-details-h">Details</h3></div>' +
      '<div class="panel-body"><form id="dlv-details" novalidate><div class="form-grid">' +
      '<div class="field full"><label for="dlv-title">Title *</label><input id="dlv-title" type="text" maxlength="200" value="' + esc(item.title) + '" autocomplete="off"></div>' +
      '<div class="field"><label for="dlv-format">Format</label><input id="dlv-format" type="text" maxlength="100" value="' + esc(item.format || '') + '" autocomplete="off"></div>' +
      '<div class="field"><label for="dlv-duration">Length</label><input id="dlv-duration" type="text" maxlength="100" value="' + esc(item.duration || '') + '" autocomplete="off"></div>' +
      '</div><div class="form-actions">' +
      '<button type="button" class="btn btn-ghost" data-write id="dlv-toggle-needed">' + (item.notNeededAt ? 'Mark needed' : 'Mark not needed') + '</button>' +
      '<button type="submit" class="btn" data-write>Save details</button></div></form></div></section>'
    );
  }

  /* mm:ss, as the client's player stamped it. */
  const clock = (s) => {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };

  /* An approval's record (C5, S12): which file, when, and who from where. All of it
     goes through esc() (S8): the name, email and user agent came with the client. */
  function approvalMarkup(item, v) {
    const a = v.approval;
    const newest = newestOf(item);
    // The stage is named just before, so the word needn't repeat it.
    const head = 'v' + a.versionN + ' · ' + STAGE[a.stage] + ' · ' + (a.kind === 'deemed' ? 'deemed approved ' : 'approved ') + when(a.approvedAt);
    const standing = a.stage !== 'final' ? 'A Draft Cut’s approval: the Final still needs its own.'
      : newest && newest.id !== v.id ? 'A newer version replaced this file, so the item isn’t approved any more.' : '';
    const stamp = new Date(a.approvedAt);
    const exact = isNaN(stamp) ? a.approvedAt : stamp.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'long' });
    return '<div class="dlv-client-set dlv-approval"><p class="dlv-client-head">' + esc(head) + '</p>' +
      '<dl class="dlv-approval-rec">' +
      '<dt>File</dt><dd>' + esc(a.fileName || 'v' + a.versionN) + '</dd>' +
      (a.kind === 'deemed' ? '' :
        '<dt>By</dt><dd>' + esc([a.name, a.email].filter(Boolean).join(' · ') || 'The client') + '</dd>') +
      '<dt>When</dt><dd>' + esc(exact) + '</dd>' +
      (a.ip ? '<dt>From</dt><dd>' + esc(a.ip) + '</dd>' : '') +
      (a.userAgent ? '<dt>Device</dt><dd class="dlv-approval-ua">' + esc(a.userAgent) + '</dd>' : '') +
      '</dl>' + (standing ? '<p class="dlv-note">' + esc(standing) + '</p>' : '') + '</div>';
  }

  /* What the client sent: approvals (C5) and the sets of notes (C4), newest first, each
     under the version it was on. Every client-written field goes through esc() (S8): a
     note is text, whatever it holds. */
  function clientSetsMarkup(item) {
    const sent = (item.notes || []).filter((n) => n.submittedAt);
    const approved = item.versions.filter((v) => v.approval);
    if (!sent.length && !approved.length) return '<p class="pf-empty">No notes or approval yet.</p>';
    const byVersion = new Map();
    sent.forEach((n) => {
      if (!byVersion.has(n.versionId)) byVersion.set(n.versionId, []);
      byVersion.get(n.versionId).push(n);
    });
    const sets = [...byVersion.entries()].map(([versionId, notes]) => {
      const v = item.versions.find((x) => x.id === versionId);
      const head = (v ? 'v' + v.n + ' · ' + STAGE[v.stage] : 'An earlier version') + ' · ' +
        notes.length + (notes.length === 1 ? ' note' : ' notes') + ' sent ' + when(notes[0].submittedAt);
      return { at: notes[0].submittedAt, html: '<div class="dlv-client-set"><p class="dlv-client-head">' + esc(head) + '</p><ol class="dlv-client-notes">' +
        notes.map((n) => '<li>' +
          (n.seconds !== null && n.seconds !== undefined ? '<span class="dlv-note-at">' + esc(clock(n.seconds)) + '</span> ' : '') +
          (n.photoName ? '<span class="dlv-note-at">' + esc(n.photoName) + '</span> ' : '') +
          '<span class="dlv-note-text">' + esc(n.text) + '</span></li>').join('') +
        '</ol></div>' };
    });
    const approvals = approved.map((v) => ({ at: v.approval.approvedAt, html: approvalMarkup(item, v) }));
    return sets.concat(approvals).sort((x, y) => String(y.at).localeCompare(String(x.at))).map((e) => e.html).join('');
  }

  /* The deemed-approval clock on a Final waiting on the client (C7): when it runs out,
     the client's reminder, and Mark approved once it has. Nothing is deemed on its own. */
  const deemedOf = (item) => ((ctx.folder.deemed || {})[item.id]) || null;

  function reminderWords(c) {
    const r = c.reminder;
    if (r && r.status === 'sent') return 'Reminder emailed to ' + r.to + ' ' + when(r.sentAt) + '.';
    if (r && r.status === 'failed') return 'The reminder email to ' + r.to + ' didn’t go: ' + r.error;
    // No record says only that none was tried: why (no email of their own, no way into the
    // portal, or a clock that ran before reminders existed) isn't kept, so it isn't claimed.
    if (c.due || today() > c.lastDay) return 'No reminder was emailed.';
    return 'The client is emailed a reminder on ' + when(c.remindOn) + ' if they have an email of their own and a way into the portal.';
  }

  function deemedMarkup(item) {
    const c = deemedOf(item);
    if (!c) return '';
    const head = c.due
      ? 'No reply to v' + c.n + ' by ' + when(c.lastDay) + ', 14 business days after it was published ' + when(c.publishedOn) + '. The agreement deems it approved once you mark it.'
      : 'If the client sends nothing on v' + c.n + ' by the end of ' + when(c.lastDay) + ' (14 business days after ' + when(c.publishedOn) + '), you can mark it approved.';
    return '<div class="dlv-deemed' + (c.due ? ' is-due' : '') + '">' +
      '<p class="dlv-client-head">' + (c.due ? 'Approval due' : 'Deemed approval') + '</p>' +
      '<p class="dlv-note">' + esc(head) + '</p>' +
      '<p class="dlv-note">' + esc(reminderWords(c)) + '</p>' +
      (c.due && !filed() ? '<button type="button" class="btn btn-sm" data-write id="dlv-deem">Mark approved…</button>' : '') +
      '</div>';
  }

  function markDeemed(item, opener) {
    const c = deemedOf(item);
    if (!c) return;
    const v = item.versions.find((x) => x.id === c.versionId);
    ctx.confirm(opener, {
      title: 'Mark v' + c.n + ' approved?',
      body: 'The client sent no notes and didn’t approve v' + c.n + (v && v.fileName ? ' (' + v.fileName + ')' : '') +
        ' within 14 business days of ' + when(c.publishedOn) + '. This records it as deemed approved under the agreement, not as their approval, ' +
        'and the item counts as approved. A new version would take it back out.',
      confirm: 'Mark approved',
      run: () => write('post', versionUrl(item, { id: c.versionId }, '/deem'), undefined, {
        working: 'Saving…',
        ok: 'v' + c.n + ' marked as deemed approved.',
        rethrow: true,
        focus: '#dlv-item-h',
      }),
    });
  }

  function clientSideMarkup(item) {
    return (
      '<section class="panel" aria-labelledby="dlv-client-h">' +
      '<div class="panel-head"><h3 class="panel-title" id="dlv-client-h">From the client</h3>' +
      roundsLine(item) + '</div>' +
      '<div class="panel-body">' + deemedMarkup(item) + clientSetsMarkup(item) + '</div></section>'
    );
  }

  function itemMarkup(item) {
    const meta = [item.format, item.duration].filter(Boolean).join(' · ');
    const off = Boolean(item.notNeededAt);
    return (
      '<button type="button" class="back-btn" id="dlv-back">← All deliverables</button>' +
      '<div class="dlv-item-head"><h2 class="dlv-item-title" id="dlv-item-h" tabindex="-1">' + esc(item.title) + '</h2>' +
      (meta ? '<p class="dlv-note">' + esc(meta) + '</p>' : '') +
      (off ? '<p class="pf-notice" role="note">Marked not needed. It’s left out of the checklist’s count, and takes no files.</p>' : '') +
      (filed() ? '<p class="pf-notice" role="note">Archived, so this is read-only. Unarchive it from Actions to change anything here.</p>' : '') +
      '</div>' +
      '<div class="dlv-error" id="dlv-error" role="alert"></div>' +
      '<div class="dlv-item-grid"><div class="dlv-item-main">' +
      currentMarkup(item) + addVersionMarkup(item) + historyMarkup(item) +
      '</div><div class="dlv-item-side">' +
      '<section class="panel" aria-label="Stage"><div class="panel-body">' + stageMarkup(item) + '</div></section>' +
      clientSideMarkup(item) + (filed() ? '' : detailsFormMarkup(item)) +
      '</div></div>'
    );
  }

  async function togglePreview(item, v, button) {
    const area = $('dlv-preview-box');
    if (!area.hidden) {
      area.hidden = true;
      area.innerHTML = '';
      button.textContent = 'Preview';
      return;
    }
    button.textContent = 'Hide preview';
    area.hidden = false;
    const base = window.LSC_API_BASE + versionUrl(item, v, '/file');
    if (v.kind !== 'photos') {
      area.innerHTML = '<video class="dlv-video" controls preload="metadata" playsinline src="' + esc(base) + '"></video>';
      area.querySelector('video').addEventListener('error', () => {
        area.innerHTML = '<p class="pf-empty">That file couldn’t be played here. It may have moved on the NAS, or this browser can’t play its format.</p>';
      });
      return;
    }
    area.innerHTML = '<p class="pf-empty" role="status">Loading the photos…</p>';
    try {
      const { photos } = await LSCApi.get(versionUrl(item, v, '/file'));
      if (!area.isConnected) return;
      const shown = (photos || []).slice(0, PHOTOS_SHOWN);
      const more = (photos || []).length - shown.length;
      area.innerHTML = shown.length
        ? '<ul class="dlv-photos">' + shown.map((name) =>
          '<li><img loading="lazy" alt="' + esc(name) + '" src="' + esc(base + '?name=' + encodeURIComponent(name)) + '"></li>').join('') + '</ul>' +
          (more > 0 ? '<p class="dlv-note">and ' + more + ' more</p>' : '')
        : '<p class="pf-empty">No images in that folder any more.</p>';
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (err.kind === 'auth') return ctx.authLost();
      if (area.isConnected) area.innerHTML = '<p class="pf-empty">' + esc(failureText(err)) + '</p>';
    }
    return undefined;
  }

  function bindItem(item) {
    const url = apiBase() + '/' + encodeURIComponent(item.id);
    const newest = newestOf(item);
    $('dlv-back').addEventListener('click', () => LSCRouter.leaveTo(folderPathOf()));

    box.querySelectorAll('input[name="dlv-stage"]').forEach((radio) => radio.addEventListener('change', () => {
      write('put', url, { stage: radio.value }, {
        working: 'Saving…',
        ok: 'Now a ' + STAGE[radio.value] + '.',
        focus: 'input[name="dlv-stage"]:checked',
        onRefused: (err) => {
          showError(failureText(err));
          box.querySelector('input[name="dlv-stage"][value="' + item.stage + '"]').checked = true;
        },
      });
    }));

    const publishBtn = $('dlv-publish');
    if (publishBtn) publishBtn.addEventListener('click', () => publish(item, publishBtn));
    if (newest && bunnyApplies(newest)) {
      bindBunny(item, newest);
      // The folder has the status only: the poster, a changed NAS file and a
      // processing one's progress come from Bunny's side.
      if (newest.bunny) checkBunny(item, newest);
    }
    const deemBtn = $('dlv-deem');
    if (deemBtn) deemBtn.addEventListener('click', () => markDeemed(item, deemBtn));
    const previewBtn = $('dlv-preview');
    if (previewBtn) previewBtn.addEventListener('click', () => togglePreview(item, newest, previewBtn));
    const removeBtn = $('dlv-remove-version');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => ctx.confirm(removeBtn, {
        title: 'Remove v' + newest.n + '?',
        body: 'The client hasn’t seen it. This only takes it off the list: the file stays on the NAS.',
        confirm: 'Remove',
        danger: true,
        run: () => write('del', versionUrl(item, newest), undefined, { working: 'Removing…', ok: 'Version removed.', rethrow: true, focus: '#dlv-item-h', saves: DRIVE }),
      }));
    }
    const drive = $('dlv-drive');
    if (drive) {
      drive.addEventListener('submit', (e) => {
        e.preventDefault();
        busyWhile(drive.querySelector('button'), () => write('put', versionUrl(item, newest), { driveLink: $('dlv-drive-link').value }, {
          working: 'Saving…', ok: 'Backup link saved.', focus: '#dlv-drive-link', saves: DRIVE,
        }));
      });
    }
    const addVersion = $('dlv-add-version');
    if (addVersion) {
      addVersion.addEventListener('submit', (e) => {
        e.preventDefault();
        const field = $('dlv-path');
        if (!field.value.trim()) {
          showError('Paste the file or folder’s path from the NAS.');
          field.focus();
          return;
        }
        busyWhile(addVersion.querySelector('button[type="submit"]'), () => write('post', url + '/versions', {
          path: field.value, driveLink: $('dlv-new-drive').value,
        }, {
          working: 'Checking the NAS…',
          ok: 'Version added.',
          focus: '#dlv-publish',
          // The Drive field now belongs to the new version, so what was typed for the old one goes.
          saves: [...ADD_VERSION, ...DRIVE],
          // Next to the field, where the path can be fixed: the message says what's wrong.
          onRefused: (err) => {
            LSCUtil.showFieldErrors($('dlv-error'), [{ msg: failureText(err), field: err.code === 'link_invalid' ? $('dlv-new-drive') : field }]);
          },
        }));
      });
    }
    if (filed()) return;
    const details = $('dlv-details');
    details.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!$('dlv-title').value.trim()) {
        LSCUtil.showFieldErrors($('dlv-error'), [{ msg: 'Give the deliverable a title.', field: $('dlv-title') }]);
        return;
      }
      busyWhile(details.querySelector('button[type="submit"]'), () => write('put', url, {
        title: $('dlv-title').value, format: $('dlv-format').value, duration: $('dlv-duration').value,
      }, { working: 'Saving…', ok: 'Details saved.', focus: '#dlv-title', saves: DETAILS }));
    });
    const toggle = $('dlv-toggle-needed');
    toggle.addEventListener('click', () => busyWhile(toggle, () => write('put', url, { notNeeded: !item.notNeededAt }, {
      working: 'Saving…',
      ok: item.notNeededAt ? 'Back on the checklist.' : 'Marked not needed.',
      focus: '#dlv-toggle-needed',
    })));

    /* What's typed in the two forms is what a route away would lose. */
    const snapshot = () => JSON.stringify(['dlv-title', 'dlv-format', 'dlv-duration', 'dlv-path', 'dlv-new-drive', 'dlv-drive-link']
      .map((id) => ($(id) ? $(id).value.trim() : '')));
    const baseline = snapshot();
    LSCUnsaved.watch('deliverable-item', {
      label: 'this deliverable',
      onScreen: () => box.isConnected && Boolean(box.querySelector('#dlv-details')),
      dirty: () => snapshot() !== baseline,
    });
  }

  /* The panel, for ctx.itemId. False when that item doesn't exist. */
  function draw(panel, context) {
    stopBunnyChecks();
    box = panel;
    ctx = context;
    if (ctx.itemId) {
      const item = ctx.folder.deliverables.find((d) => d.id === ctx.itemId);
      if (!item) {
        box.innerHTML =
          '<div class="empty-state"><h3>That deliverable isn’t on this project any more</h3>' +
          '<button type="button" class="btn" id="dlv-back" style="margin-top:16px">All deliverables</button></div>';
        $('dlv-back').addEventListener('click', () => LSCRouter.go(folderPathOf(), { replace: true }));
        return;
      }
      box.innerHTML = itemMarkup(item);
      bindItem(item);
      return;
    }
    box.innerHTML = checklistMarkup();
    bindChecklist();
  }

  /* Is anything half-typed in the panel? A follow-up redraw waits for it. */
  function holdsInput(panel) {
    return Array.from(panel.querySelectorAll('input[type="text"], input[type="url"]')).some((i) => i.value !== i.defaultValue);
  }

  // clientSetsMarkup: for test-portal-feedback.js, which runs it as the browser does (S8).
  return { draw, holdsInput, clientSetsMarkup };
})();
