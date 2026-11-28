'use strict';

/* One project, as every screen shows it (production-booking task 17; IA,
 * Component Reuse Map): the stage line, and the project card that carries it.
 *
 * THE STAGE LINE IS ONE FUNCTION. The Projects list, the client's projects and
 * the project folder (task 18) all print stageLine(), so the three can't
 * disagree. Where the project is, its `stage` and `stageDetail.step`, comes
 * from the server (server/src/projects.js projectStage), which also filters
 * and counts by it; this only words it. Dates are read against the browser's
 * today, as everywhere else in the app: a sent estimate past its valid-until
 * reads "expired" (D44, derived, never stored), and an invoice past its due
 * date "overdue".
 *
 * The card is the existing .proj-card (IA: "the stage line where the date
 * sat"), with the next production day under it when there is one.
 */

const ProjectCard = (() => {
  const { fmt, esc } = LSCUtil;
  const C = LSCCalendar;

  /* The two lists' filter chips, in the order a job moves through them
     (merged-admin L3, R2; IA "Pipeline", "Live projects"). Each list's first chip
     is its default (the server's `pipeline` and `live`); the others narrow it.
     Pipeline's Open leaves declined projects a filter away. Live's chips are the
     server's named lists: delivery badges, and Payment due, which is anything
     with a sent invoice unpaid. Complete projects belong to their client, so no
     chip finds them: they are under Clients. */
  const PIPELINE_CHIPS = [
    ['pipeline', 'Open'],
    ['draft', 'Draft'],
    ['sent', 'Sent'],
    ['declined', 'Declined'],
  ];
  const LIVE_CHIPS = [
    ['live', 'All'],
    ['in-production', 'In production'],
    ['in-review', 'In review'],
    ['revisions', 'Revisions'],
    ['payment-due', 'Payment due'],
  ];

  /* Where a project belongs in the admin, from its stage, not from how you
     arrived (IA "Navigation Model"). Before acceptance: Scope & Sales, with
     the breadcrumb "Pipeline / Project". After it: Clients, "Clients / Client
     / Project". `area` and `page` are LSCShell's ids (no page lit once the
     project is a level below the row); `path` is where the Back link goes and
     `crumb` what it says. A project with no client record has nowhere under
     Clients to go yet, so it falls back to the list that holds it. */
  const clientPath = (id) => '/clients/' + encodeURIComponent(id) + '/projects';

  function placeOf(project) {
    const stage = project && project.stage;
    if (stage === 'accepted' || stage === 'invoiced' || stage === 'paid') {
      const client = (project && project.client) || {};
      const name = client.businessName || client.contactName || '';
      if (client.id) {
        return { area: 'clients', page: null, path: clientPath(client.id), crumb: 'Clients / ' + (name || 'Client') };
      }
      return stage === 'paid'
        ? { area: 'clients', page: null, path: '/clients', crumb: 'Clients' }
        : { area: 'clients', page: 'live', path: '/projects', crumb: 'Live projects' };
    }
    return { area: 'sales', page: 'pipeline', path: '/pipeline', crumb: 'Pipeline' };
  }

  /* A project screen's Back link: the list or client page it was opened from
     when that is one Back away, so the chip and search it showed come back;
     else where the project belongs (placeOf). `project` may be null (a
     project that couldn't be loaded). { path, crumb }. */
  const LIST_CRUMBS = { '/pipeline': 'Pipeline', '/projects': 'Live projects', '/clients': 'Clients' };
  function backOf(project) {
    const place = placeOf(project);
    const behind = LSCRouter.behindPath();
    if (!behind || behind === place.path) return { path: place.path, crumb: place.crumb };
    if (LIST_CRUMBS[behind]) return { path: behind, crumb: LIST_CRUMBS[behind] };
    if (/^\/clients\/[^/]+\/(projects|invoices)$/.test(behind)) {
      const client = (project && project.client) || {};
      const own = client.id && behind.startsWith('/clients/' + encodeURIComponent(client.id) + '/');
      return { path: behind, crumb: own ? 'Clients / ' + (client.businessName || client.contactName || 'Client') : 'Back' };
    }
    return { path: place.path, crumb: place.crumb };
  }

  /* An accepted project's tabs, each an address (IA "Project"). */
  const PROJECT_TABS = [['deliverables', 'Deliverables'], ['production', 'Production'], ['payments', 'Payments'], ['documents', 'Documents']];

  /* Where a screen under a project goes back to: the tab it was opened from when
     that is one Back away, else `fallback`, else the project (which opens on its
     default tab once it's accepted). Only a tab, or a deliverable under one: the
     project's other screens (its estimate, an invoice) aren't where Back ends. */
  function folderBack(projectId, fallback) {
    const home = '/projects/' + encodeURIComponent(projectId);
    const behind = LSCRouter.behindPath();
    const rest = behind && behind.startsWith(home + '/') ? behind.slice(home.length + 1).split('/') : [];
    const isTab = PROJECT_TABS.some(([key]) => key === rest[0]) && (rest.length === 1 || (rest.length === 2 && rest[0] === 'deliverables'));
    return isTab ? behind : fallback || home;
  }

  /* An old address's `?stage=` (from before the Pipeline had its own screen)
     as the screen that now holds those projects, or null when the stage is
     one the lists still use: '/pipeline?stage=sent', '/projects', '/clients'. */
  function redirectForStage(stage) {
    if (stage === 'draft' || stage === 'sent' || stage === 'declined') return '/pipeline?stage=' + stage;
    if (stage === 'accepted' || stage === 'invoiced') return '/projects';
    if (stage === 'paid') return '/clients';
    return null;
  }

  /* A date as YYYY-MM-DD. A timestamp (accepted_at, declined_at, a send) is
     UTC, so it is read on this browser's clock: an evening here is the next
     morning in UTC. A plain date is already a calendar day. */
  function localDate(value) {
    const raw = String(value || '');
    if (raw.length <= 10) return raw;
    const t = new Date(raw);
    if (!Number.isFinite(t.getTime())) return raw.slice(0, 10);
    const pad = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  // "14 Oct", with the year when it isn't this one. Takes a date or a timestamp.
  function dayMonth(value, today) {
    const ymd = localDate(value);
    if (!C.isDate(ymd)) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    const s = d + ' ' + C.MONTHS[m - 1].slice(0, 3);
    return today && ymd.slice(0, 4) !== today.slice(0, 4) ? s + ' ' + y : s;
  }

  const KIND = { deposit: 'Deposit', final: 'Final', single: 'Invoice' };

  /* An unpaid invoice that has gone out: due, overdue, or just unpaid. */
  function owing(word, detail, today) {
    const due = String(detail.dueAt || '').slice(0, 10);
    if (!C.isDate(due)) return { word: word + ' sent', note: 'unpaid' };
    if (due < today) return { word: word + ' overdue', note: 'was due ' + dayMonth(due, today), alert: true };
    return { word: word + ' sent', note: 'due ' + dayMonth(due, today) };
  }

  /**
   * The stage line's words: { word, note, alert }. `word` leads ("Sent v2"),
   * `note` follows it after a dot ("valid until 14 Oct"), and `alert` marks a
   * line that needs the owner (expired, overdue, a proposed date taken).
   */
  function stageLine(project, today) {
    const d = project.stageDetail || {};
    const step = d.step || project.stage;
    const on = (value) => dayMonth(value, today);
    switch (step) {
      case 'sent': {
        const word = d.version ? 'Sent v' + d.version : 'Sent';
        // A proposed date another project has since confirmed (C6): the
        // client's Accept is paused until new dates go to them (D41).
        const taken = Array.isArray(project.takenDays) ? project.takenDays.length : 0;
        if (taken) return { word, note: taken === 1 ? 'a proposed date is taken' : taken + ' proposed dates are taken', alert: true };
        const until = String(d.validUntil || '').slice(0, 10);
        if (C.isDate(until)) {
          return until < today
            ? { word, note: 'expired ' + on(until), alert: true }
            : { word, note: 'valid until ' + on(until) };
        }
        return { word, note: d.at ? on(d.at) : '' };
      }
      case 'accepted': return { word: 'Accepted', note: 'invoices not created' };
      case 'deposit_draft': return { word: 'Accepted', note: 'deposit not sent' };
      case 'final_draft': return { word: 'Accepted', note: 'final not sent' };
      case 'single_draft': return { word: 'Accepted', note: 'invoice not sent' };
      case 'deposit_scheduled': return { word: 'Accepted', note: 'deposit scheduled' };
      case 'single_scheduled': return { word: 'Accepted', note: 'invoice scheduled' };
      case 'final_scheduled': return { word: 'Deposit paid', note: 'final scheduled' };
      case 'deposit_paid': return { word: 'Deposit paid', note: 'final not sent' };
      case 'deposit_sent':
      case 'final_sent':
      case 'single_sent':
        return owing(KIND[step.split('_')[0]], d, today);
      case 'legacy': return { word: 'Invoiced', note: d.number ? d.number + ', made the old way' : 'made the old way' };
      case 'paid': return { word: 'Paid', note: d.at ? on(d.at) : '' };
      case 'declined': return { word: 'Declined', note: d.at ? on(d.at) : '' };
      default: return { word: 'Draft', note: '' };
    }
  }

  /* Where the job stands, from the server's one state model (delivery.js
     deliveryState): words on every list after acceptance, tinted by what it asks
     of the studio. Nothing while it's a quote: the stage line says that. */
  function badgeMarkup(project) {
    const d = project.delivery;
    if (!d || d.group === 'pipeline' || !/^[a-z_]+$/.test(d.badge || '')) return '';
    return '<span class="delivery-badge is-' + d.badge + '">' + esc(d.label) + '</span>';
  }

  /* The line as markup. The square before it is the stage's mark; the word
     beside it says the same thing, so colour is never the only sign. */
  function stageMarkup(project, today) {
    const line = stageLine(project, today);
    const stage = /^[a-z]+$/.test(project.stage || '') ? project.stage : 'draft';
    return (
      '<p class="stage-line is-' + stage + (line.alert ? ' is-alert' : '') + '">' +
      '<span class="stage-word">' + esc(line.word) + '</span>' +
      (line.note ? '<span class="stage-note"> · ' + esc(line.note) + '</span>' : '') +
      '</p>'
    );
  }

  /* One activity row in words ("INV-AUD-B-D paid, $2,000.00 by bank
     transfer"): the folder's log and Home's Recent activity (task 22) both
     print this, so the two can't word an event differently. */
  /* "8 Oct, 9:00 am": when a scheduled email goes, on this browser's clock. */
  function dayTime(value, today) {
    const t = new Date(value);
    if (!Number.isFinite(t.getTime())) return '';
    return dayMonth(value, today) + ', ' + t.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  }

  function activityText(entry, today) {
    const d = entry.detail || {};
    switch (entry.kind) {
      case 'sent': {
        // How it went (task 29): emailed now or later, or its link copied.
        // A row from before (Mark sent) has no `by`.
        const v = d.version ? 'v' + d.version : 'the estimate';
        const until = C.isDate(d.validUntil) ? ', valid until ' + dayMonth(d.validUntil, today) : '';
        // An edit saved to a quote the client has (task 33 C2) is sent as it's saved.
        if (d.carried) return 'Edited: ' + v + ' goes with the email scheduled ' + dayTime(d.scheduledFor, today) + until;
        const sent = d.update ? 'Edited and sent ' : 'Sent ';
        if (d.by === 'email' && d.scheduledFor) return 'Scheduled ' + v + ' to email ' + dayTime(d.scheduledFor, today) + until;
        if (d.by === 'email') return sent + v + ' by email' + (d.to ? ' to ' + d.to : '') + until;
        if (d.by === 'link') return (d.update ? 'Edited: ' + v + ' is on the client’s link' : 'Sent ' + v + ' by link') + until;
        return 'Marked sent' + until;
      }
      case 'opened': return 'Client opened the estimate' + (d.version > 1 ? ' (v' + d.version + ')' : '');
      case 'accepted': return 'Marked accepted' + invoicesText(d);
      case 'signed': return 'Client signed and accepted' + (d.version > 1 ? ' v' + d.version : '') +
        (d.signedBy ? ' · ' + d.signedBy + (d.role ? ', ' + d.role : '') : '') + invoicesText(d) +
        (d.invoiceProblem ? ' · no invoices made yet' : '');
      case 'invoices_created': return 'Invoices created' + invoicesText(d);
      case 'declined': return 'Declined';
      case 'reopened': return 'Reopened';
      case 'deliverable_added': return 'Added “' + (d.title || 'a deliverable') + '” to the checklist';
      case 'deliverable_removed': return 'Removed “' + (d.title || 'a deliverable') + '” from the checklist';
      case 'deliverable_not_needed': return 'Marked “' + (d.title || 'a deliverable') + '” not needed';
      case 'deliverable_needed': return 'Put “' + (d.title || 'a deliverable') + '” back on the checklist';
      case 'deliverable_stage': return '“' + (d.title || 'A deliverable') + '” is now a ' + (d.stage === 'final' ? 'Final' : 'Draft Cut');
      case 'version_added': return 'Added v' + d.n + ' of “' + (d.title || 'a deliverable') + '”' + (d.file ? ': ' + d.file : '');
      case 'version_removed': return 'Removed v' + d.n + ' of “' + (d.title || 'a deliverable') + '”';
      case 'version_published': return 'Published v' + d.n + ' of “' + (d.title || 'a deliverable') + '” as a ' + (d.stage === 'final' ? 'Final' : 'Draft Cut');
      case 'portal_invite_sent': return 'Portal invite emailed to ' + (d.to || 'the client');
      case 'portal_invite_failed': return 'The portal invite email to ' + (d.to || 'the client') + ' didn’t go' + (d.error ? ': ' + d.error : '');
      case 'client_approved': return 'Client approved v' + d.n + ' of “' + (d.title || 'a deliverable') + '”' +
        (d.stage === 'final' ? ', the Final' : ', a Draft Cut');
      case 'deemed_approved': return 'Marked v' + d.n + ' of “' + (d.title || 'a deliverable') + '” as deemed approved (no reply in 14 business days)';
      case 'deemed_reminder_sent': return 'Reminder emailed to ' + (d.to || 'the client') + ' about v' + d.n + ' of “' + (d.title || 'a deliverable') + '”';
      case 'deemed_reminder_failed': return 'The reminder email to ' + (d.to || 'the client') + ' about v' + d.n + ' didn’t go' + (d.error ? ': ' + d.error : '');
      case 'files_sent': return (d.update ? 'Updated files' : 'Files') + ' emailed to ' + (d.to || 'the client') +
        (d.missing && d.missing.length ? ' (no Drive link: ' + d.missing.join(', ') + ')' : '');
      case 'files_failed': return 'The files email to ' + (d.to || 'the client') + ' didn’t go' + (d.error ? ': ' + d.error : '') +
        (d.gaveUp ? '. It won’t be tried again' : '');
      case 'files_not_sent': return 'The files couldn’t be emailed: ' + (d.badEmail ? 'the client’s email address (' + d.badEmail + ') isn’t valid' : 'the client has no email address');
      case 'no_deliverables': return 'Said no deliverables are expected';
      case 'deliverables_expected': return 'Said deliverables are expected after all';
      case 'archived': return 'Archived';
      case 'unarchived': return 'Unarchived, back in Complete';
      case 'files_offline': return 'Client’s files taken offline' + (d.versions ? ' (' + d.versions + (d.versions === 1 ? ' version' : ' versions') + ' off Bunny)' : '');
      case 'files_online': return 'Client’s files brought back online' + (d.missing ? ', ' + d.missing + ' not on the NAS' : '');
      case 'invoice_sent': return (d.by === 'hnry' ? (d.hnryNumber || d.number || 'Invoice') : (d.number || 'Invoice')) +
        (d.by === 'email' ? ' emailed' + (d.late ? ' late' : '') : d.by === 'link' ? ' sent by link' : d.by === 'hnry' ? ' sent from Hnry' : ' marked sent') +
        (C.isDate(d.dueAt) ? ', due ' + dayMonth(d.dueAt, today) : '');
      // Hnry (hnry-invoicing): made there as a draft, or why it didn't get there.
      case 'hnry_pushed': return (d.number || 'Invoice') + ' made in Hnry' + (d.hnryNumber ? ' as ' + d.hnryNumber : '') +
        (d.lines > 1 ? ' (' + d.lines + ' lines)' : '');
      case 'hnry_push_failed': return (d.number || 'Invoice') + ' didn’t reach Hnry' + (d.message ? ': ' + d.message : '');
      case 'invoice_paid': return (d.number || 'Invoice') + ' paid' + (typeof d.amount === 'number' ? ', ' + fmt(d.amount) : '') +
        (d.via === 'card' ? ' by card' : d.via === 'bank' ? ' by bank transfer' : '');
      case 'invoice_voided': return (d.number || 'Invoice') + ' voided' + (d.reason ? ': ' + d.reason : '') +
        (d.replacement ? '. Replaced by ' + d.replacement : '');
      case 'invoice_edited': return (d.number || 'Invoice') + ' edited' +
        (typeof d.depositPct === 'number' ? ', deposit now ' + d.depositPct + '%' : '') +
        (typeof d.amountDue === 'number' ? ' (' + fmt(d.amountDue) + ' due)' : '');
      // The call sheet emailed to crew (trip-planner task 11): two names, or a count.
      case 'call_sheet_sent': {
        const to = Array.isArray(d.to) ? d.to : [];
        return 'Call sheet emailed' + (!to.length ? ''
          : to.length <= 2 ? ' to ' + to.join(' and ')
            : ' to ' + to[0] + ' and ' + (to.length - 1) + ' others');
      }
      default: return entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1).replace(/_/g, ' ');
    }
  }

  function invoicesText(d) {
    const numbers = Array.isArray(d.invoices) ? d.invoices : [];
    return (numbers.length ? ' · ' + numbers.join(', ') : '') +
      (d.invoicing === 'pair' && d.depositPct ? ' (' + d.depositPct + '% deposit)' : '');
  }

  /* Where opening a project goes: its folder (task 18). The one place a card
     opens from, for the list, the client's projects and app.js. */
  const pathOf = (project) => (project && project.id ? '/projects/' + encodeURIComponent(project.id) : null);

  function upidMarkup(project) {
    const more = project.estimateCount > 1 ? ' · ' + project.estimateCount + ' estimates' : '';
    if (project.upid) return '<div class="card-num">' + esc(project.upid) + more + '</div>';
    return (
      '<div class="card-num is-missing' + (project.needsUpid ? ' is-needed' : '') + '">' +
      (project.needsUpid ? 'UPID needed' : 'No UPID yet') + more + '</div>'
    );
  }

  function nextDayMarkup(project, today) {
    const next = project.nextDay;
    if (!next || !C.isDate(next.date)) return '';
    return (
      '<p class="card-next"><span class="card-next-label">Next day</span>' +
      C.statusChip(next.status) +
      '<span class="card-next-date">' + esc(next.date === today ? 'Today' : C.shortDate(next.date)) + '</span></p>'
    );
  }

  /* `opts.hideClient`: the list is one client's. `opts.action`: { act, label,
     says }, a button of the screen's own on the card, which the card's click
     leaves alone (the screen delegates on data-act). */
  function cardMarkup(project, today, opts) {
    const client = project.client || {};
    const { hideClient, action } = opts || {};
    return (
      '<div class="proj-card project-card" data-id="' + esc(project.id) + '" role="listitem">' +
      upidMarkup(project) +
      '<h2 class="card-name"><button type="button" class="card-open">' + esc(project.name || 'Untitled') + '</button></h2>' +
      (hideClient ? '' : '<div class="card-client">' + esc(client.businessName || '—') + '</div>') +
      '<div class="card-gross-label">Total (inc GST)</div>' +
      '<div class="card-gross">' + fmt(project.totalIncGst) + '</div>' +
      '<div class="card-foot project-foot">' + badgeMarkup(project) + stageMarkup(project, today) + nextDayMarkup(project, today) + '</div>' +
      (action
        ? '<div class="card-actions"><button type="button" class="btn btn-sm" data-write data-act="' + esc(action.act) + '"' +
          ' data-id="' + esc(project.id) + '" aria-label="' + esc(action.says) + '">' + esc(action.label) + '</button></div>'
        : '') +
      '</div>'
    );
  }

  /* Cards in a grid, each opening its project: the list and the client's
     projects bind them the same way. The card's title is its <button>
     (.card-open, stretched over the card by estimates.css), so Enter and
     Space arrive here as a click too. */
  function bind(container, projects, onOpen) {
    container.querySelectorAll('.project-card').forEach((card) => {
      const project = projects.find((p) => p.id === card.dataset.id);
      if (project) {
        card.addEventListener('click', (e) => {
          if (!e.target.closest('.card-actions')) onOpen(project);
        });
      }
    });
  }

  return { PIPELINE_CHIPS, LIVE_CHIPS, PROJECT_TABS, placeOf, backOf, folderBack, redirectForStage, stageLine, stageMarkup, badgeMarkup, cardMarkup, bind, pathOf, dayMonth, localDate, activityText };
})();
