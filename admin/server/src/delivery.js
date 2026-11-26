'use strict';

/**
 * A project after acceptance (merged-admin R1): its checklist, its client
 * record, and the one place that says where it stands.
 *
 * acceptEstimate (routes/projects.js) calls clientForAcceptance and
 * createChecklist inside its own transaction, so both ways in, the client's
 * signature and the studio's Mark accepted, open the project the same way
 * (IA flow "Quote to project").
 *
 * deliveryState is the IA's Project State Model: one badge vocabulary for
 * money and delivery together, the first row that matches winning. It is a
 * pure function of what readDelivery loads, so later tasks extend the loader
 * (C4 notes, C5 approvals, F4/F5 payment) without touching the table order.
 */

const { newId } = require('./db');
const { normEmail } = require('./clients');

/* The most items one quoted line opens. A quantity is typed by hand; a slip
   ("300 × Cut-down") shouldn't fill a checklist the studio has to clear. */
const MAX_PER_LINE = 50;

/**
 * The checklist a quote opens with: one item per quoted deliverable, so a
 * line of 3 × Cut-down is three items, "Cut-down (1 of 3)" and on. A line
 * with no name or no positive quantity was never quoted work. A fractional
 * quantity rounds, but a positive one is always at least one item.
 *
 * @param {object} estimate  loadEstimate's shape (`activeRows.deliverables`)
 * @returns {Array<{title, format, duration, quoteLineId}>}
 */
function quotedDeliverables(estimate) {
  const rows = (estimate && estimate.activeRows && estimate.activeRows.deliverables) || [];
  const items = [];
  for (const line of Array.isArray(rows) ? rows : []) {
    if (!line) continue;
    const name = String(line.name || '').trim();
    const qty = Number(line.qty);
    if (!name || !Number.isFinite(qty) || qty <= 0) continue;
    const n = Math.min(MAX_PER_LINE, Math.max(1, Math.round(qty)));
    for (let i = 1; i <= n; i++) {
      items.push({
        title: n === 1 ? name : `${name} (${i} of ${n})`,
        format: String(line.format || '').trim(),
        duration: String(line.duration || '').trim(),
        quoteLineId: line.id ? String(line.id) : null,
      });
    }
  }
  return items;
}

/**
 * Opens the project's checklist from the accepted quote, inside the caller's
 * transaction. Only once: a project that already has items keeps them (the
 * checklist is the studio's from here on). Returns how many were made.
 */
function createChecklist(db, projectId, estimate, now) {
  if (db.prepare('SELECT 1 FROM deliverables WHERE project_id = ? LIMIT 1').get(projectId)) return 0;
  const add = db.prepare(`
    INSERT INTO deliverables (id, project_id, position, title, format, duration, estimate_id, quote_line_id,
                              created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const items = quotedDeliverables(estimate);
  items.forEach((item, i) => {
    add.run(newId('dlv'), projectId, i + 1, item.title, item.format, item.duration,
      (estimate && estimate.id) || null, item.quoteLineId, now, now);
  });
  return items.length;
}

/* One spelling for comparing: trimmed and folded in JS, as the client
   editor's sameName does (SQLite's lower() folds only ASCII, so "CAFÉ" and
   "Café" would differ there). */
const fold = (s) => String(s || '').trim().toLowerCase();

/**
 * The client an accepted project belongs to, inside the caller's
 * transaction (IA flow "Quote to project", Defaults 6). A project already
 * linked keeps its client; one whose quote names a client record takes it.
 * Otherwise the quote's details find one:
 *
 *   1. By email (ignoring case and spaces). Two clients sharing it are told
 *      apart by business name; failing that the oldest is taken, and the
 *      note `shared_email` says a choice was made.
 *   2. By business name, which the client editor keeps unique. When the quote
 *      has an email the client lacks, the client takes it; when the client
 *      has a different one it keeps its own, and the note `email_differs`
 *      carries the quote's so the studio can check it.
 *   3. Failing both, a client is made from the quote, named by its business,
 *      else its contact, else its email (the editor needs a name, and so
 *      does Hnry). A quote with none of the three stays without a client
 *      (R2's Client details is where that gets fixed).
 *
 * Links the project, and its estimates that name no client, to the result.
 *
 * @returns {{ clientId: string|null, how: 'linked'|'matched_email'|'matched_name'|'created'|null,
 *             note?: { kind: 'shared_email'|'email_differs', ... } }}
 */
function clientForAcceptance(db, p, estimate, now) {
  let clientId = p.client_id || null;
  let how = clientId ? 'linked' : null;
  let note = null;
  if (!clientId && estimate && estimate.clientId &&
      db.prepare('SELECT 1 FROM clients WHERE id = ?').get(estimate.clientId)) {
    clientId = estimate.clientId;
    how = 'linked';
  }
  const snap = (estimate && estimate.client) || {};
  if (!clientId) {
    const email = normEmail(snap.email);
    const business = String(snap.businessName || '').trim();
    const contact = String(snap.contactName || '').trim();
    // Oldest first, so a tie goes to the client made first.
    const all = db.prepare('SELECT id, business_name, email FROM clients ORDER BY created_at, id').all();
    const byEmail = email ? all.filter((c) => fold(c.email) === fold(email)) : [];
    const byName = business ? all.find((c) => fold(c.business_name) === fold(business)) : null;
    if (byEmail.length) {
      const named = byEmail.length > 1 && byEmail.find((c) => business && fold(c.business_name) === fold(business));
      clientId = (named || byEmail[0]).id;
      how = 'matched_email';
      if (byEmail.length > 1 && !named) note = { kind: 'shared_email', among: byEmail.length };
    } else if (byName) {
      clientId = byName.id;
      how = 'matched_name';
      if (email && !String(byName.email || '').trim()) {
        db.prepare('UPDATE clients SET email = ?, updated_at = ? WHERE id = ?').run(email, now, byName.id);
      } else if (email) {
        note = { kind: 'email_differs', quoteEmail: email };
      }
    } else if (business || contact || email) {
      clientId = newId('cl');
      how = 'created';
      db.prepare(`
        INSERT INTO clients (id, business_name, contact_name, email, phone, abn, address, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      `).run(clientId, business || contact || email, contact, email,
        String(snap.phone || '').trim(), String(snap.abn || '').replace(/\s+/g, ''),
        String(snap.address || '').trim(), now, now);
    }
  }
  if (clientId) {
    if (p.client_id !== clientId) {
      db.prepare('UPDATE projects SET client_id = ?, updated_at = ? WHERE id = ?').run(clientId, now, p.id);
    }
    db.prepare('UPDATE estimates SET client_id = ? WHERE project_id = ? AND client_id IS NULL').run(clientId, p.id);
  }
  return note ? { clientId, how, note } : { clientId, how };
}

/* ── The state model ────────────────────────────────────────────────────── */

/* The IA's table, in its order. `client` is what the portal says; null where
   the client sees nothing of the project there. */
const BADGES = {
  draft: { group: 'pipeline', label: 'Draft', client: null },
  sent: { group: 'pipeline', label: 'Sent', client: null },
  declined: { group: 'pipeline', label: 'Declined', client: null },
  revisions: { group: 'live', label: 'Revisions', client: 'We’re making your changes' },
  in_review: { group: 'live', label: 'In review', client: 'Ready for your review' },
  in_production: { group: 'live', label: 'In production', client: 'We’re working on it' },
  send_invoice: { group: 'live', label: 'Send invoice', client: 'Approved. Your invoice is on its way' },
  payment_claimed: { group: 'live', label: 'Payment claimed', client: 'Thanks, we’re confirming your payment' },
  payment_due: { group: 'live', label: 'Payment due', client: 'Approved. Payment due' },
  downloads_locked: { group: 'live', label: 'Downloads locked', client: 'Downloads are paused. Contact us' },
  complete: { group: 'done', label: 'Complete', client: 'Complete' },
  archived: { group: 'done', label: 'Archived', client: 'Complete' },
};

/* The invoices that bill the end of a job; a deposit never does. */
const CLOSING_KINDS = ['final', 'single', 'legacy'];

/**
 * Where a project stands (IA "Project State Model"). Pure.
 *
 * @param {object} input
 *   money       projects.js projectStage's `stage` (draft|sent|declined|accepted|invoiced|paid)
 *   project     { upid, archivedAt, noDeliverablesAt, paymentRequired, paymentClaimedAt, downloadsLocked }
 *   items       [{ notNeeded, approved, awaitingClient, notesSubmitted }] — the checklist
 *   invoices    [{ kind, status }] — the project's invoices
 *   signed      the client signed the accepted quote (no flag when true)
 * @returns {{ badge, label, group, client, flags: string[], asks: string[],
 *             checklist: { total, approved, notNeeded, open } }}
 *
 * Archived is the IA's last row but is checked first after the Pipeline:
 * every archived project would otherwise match Complete above it.
 * "All approved" is every item approved or not needed; an empty list counts
 * only when the studio said none are expected (`noDeliverablesAt`), so an
 * empty checklist never completes a project and asks for an item instead.
 * With payment not required, approval is enough to complete (brief, Job
 * lifecycle). Payment claimed and Lock downloads arrive with F4/F5; until
 * then their inputs are absent and those rows never match.
 */
function deliveryState(input) {
  const { money, project = {}, items = [], invoices = [], signed = false } = input;
  const total = items.length;
  const notNeeded = items.filter((i) => i.notNeeded).length;
  const approved = items.filter((i) => !i.notNeeded && i.approved).length;
  const open = total - notNeeded - approved;
  const checklist = { total, approved, notNeeded, open };

  const flags = [];
  if (!project.upid) flags.push('no_upid');
  const pipeline = money === 'draft' || money === 'sent' || money === 'declined';
  if (!pipeline && !signed) flags.push('no_agreement');
  if (project.paymentRequired) flags.push('payment_required');

  const asks = [];
  const at = (badge) => ({ badge, ...BADGES[badge], flags, asks, checklist });

  if (pipeline) return at(money);
  if (project.archivedAt) return at('archived');

  const live = items.filter((i) => !i.notNeeded && !i.approved);
  if (live.some((i) => i.notesSubmitted)) return at('revisions');
  if (live.some((i) => i.awaitingClient)) return at('in_review');
  if (open > 0) return at('in_production');
  if (total === 0 && !project.noDeliverablesAt) {
    asks.push('checklist_empty');
    return at('in_production');
  }

  // Everything approved or not needed.
  if (project.paymentRequired && money !== 'paid') {
    // Scheduled is sent as far as the studio goes: it is queued, nothing to do.
    const billed = invoices.filter((i) => i.status !== 'void' && CLOSING_KINDS.includes(i.kind));
    if (!billed.some((i) => i.status === 'scheduled' || i.status === 'sent' || i.status === 'paid')) {
      return at('send_invoice');
    }
    if (project.paymentClaimedAt) return at('payment_claimed');
    return at('payment_due');
  }
  if (project.downloadsLocked) return at('downloads_locked');
  return at('complete');
}

/* ── Reading it ─────────────────────────────────────────────────────────── */

/* Revision rounds per Final deliverable (brief, Revision rounds; contract clause 4). */
const ROUNDS_INCLUDED = 2;

/* An approval as the readers see it (C5): the record, whoever reads it decides how
   much of it they show (the client sees when, the studio sees all of it). */
/* A version's Bunny Stream row as the checklist carries it. Only a ready row with
   an id plays; anything else leaves the version on its NAS link. */
const bunnyStateOf = (b) => (b ? { status: b.status, error: b.error || null, videoId: b.bunny_video_id || null } : null);

const approvalOf = (a) => (a ? {
  kind: a.kind,
  approvedAt: a.approved_at,
  email: a.email || '',
  name: a.name || '',
  stage: a.stage,
  versionN: a.version_n,
  fileName: a.file_name || '',
  ip: a.ip || '',
  userAgent: a.user_agent || '',
} : null);

/* Item and version rows as the admin reads them, each item with its versions.
   `submissions` (C4) mark the versions the client sent notes on; `notes` are the
   client's, sent or not (each reader decides what it shows: the studio sees a
   note once it's sent). `approvals` (C5) are each version's, if it has one.
   `roundsUsed` counts the sets sent on Final versions: a Draft Cut's never count. */
function checklistOf(items, versions, { submissions = [], notes = [], approvals = [], bunny = [] } = {}) {
  const bunnyOf = new Map(bunny.map((b) => [b.version_id, b]));
  const sentAt = new Map(submissions.map((s) => [s.version_id, s.submitted_at]));
  const sentById = new Map(submissions.map((s) => [s.id, s.submitted_at]));
  const approvalAt = new Map(approvals.map((a) => [a.version_id, a]));
  return items.map((d) => ({
    id: d.id,
    position: d.position,
    title: d.title,
    format: d.format,
    duration: d.duration,
    estimateId: d.estimate_id,
    quoteLineId: d.quote_line_id,
    stage: d.stage,
    hubStatus: d.hub_status || null,
    notNeededAt: d.not_needed_at || null,
    versions: versions.filter((v) => v.deliverable_id === d.id).map((v) => ({
      id: v.id,
      n: v.n,
      stage: v.stage,
      sourcePath: v.source_path,
      fileName: v.file_name,
      kind: v.kind,
      photoCount: v.photo_count,
      driveLink: v.drive_link,
      createdAt: v.created_at,
      publishedAt: v.published_at || null,
      submittedAt: sentAt.get(v.id) || null,
      approval: approvalOf(approvalAt.get(v.id)),
      // Its video on Bunny Stream (bunny-publish.js), or null: where the client will
      // watch it from. Studio-only: the portal's reply builds its review from it.
      bunny: bunnyStateOf(bunnyOf.get(v.id)),
    })),
    roundsUsed: submissions.filter((s) => s.deliverable_id === d.id && s.stage === 'final').length,
    roundsIncluded: ROUNDS_INCLUDED,
    notes: notes.filter((n) => n.deliverable_id === d.id).map((n) => ({
      id: n.id,
      versionId: n.version_id,
      clientId: n.client_id,
      text: n.text,
      seconds: n.seconds === null || n.seconds === undefined ? null : n.seconds,
      photoKey: n.photo_key || null,
      photoName: n.photo_name || null,
      createdAt: n.created_at,
      submittedAt: n.submission_id ? sentById.get(n.submission_id) || null : null,
    })),
  }));
}

/* The newest version the client has been given, or null. */
function newestPublished(d) {
  return d.versions.filter((v) => v.publishedAt).pop() || null;
}

/* Signed off (S12): the item's newest version, published or not, is a Final the
   client approved (or the studio marked approved, C7). A new file the studio adds
   takes the item out of approved at once, before it's even published: the approval
   stays on its own version's record, but it was of a file that's being replaced. A
   draft's approval never signs an item off (brief, Deliverables). The old hub's word
   (R4) stands until the item's next file, which clears it. */
function itemApproved(d) {
  if (d.hubStatus === 'approved' || d.hubStatus === 'delivered') return true;
  const newest = d.versions[d.versions.length - 1];
  return Boolean(newest && newest.stage === 'final' && newest.approval);
}

/** The checklist as the admin reads it, in order, each item with its versions and the client's notes. */
function readChecklist(db, projectId) {
  return checklistOf(
    db.prepare('SELECT * FROM deliverables WHERE project_id = ? ORDER BY position, created_at, id').all(projectId),
    db.prepare('SELECT * FROM deliverable_versions WHERE project_id = ? ORDER BY n').all(projectId),
    {
      submissions: db.prepare('SELECT * FROM client_submissions WHERE project_id = ?').all(projectId),
      notes: db.prepare('SELECT * FROM client_notes WHERE project_id = ? ORDER BY created_at, id').all(projectId),
      approvals: db.prepare('SELECT * FROM client_approvals WHERE project_id = ?').all(projectId),
      bunny: db.prepare("SELECT version_id, status, error, bunny_video_id FROM bunny_assets WHERE project_id = ? AND kind = 'video'").all(projectId),
    },
  );
}

/* Did the client sign one of this project's quotes, or the old hub's sign-off?
   Mark accepted leaves neither (brief: "The project page says so plainly; delivery
   isn't blocked by it"). */
function projectSigned(db, projectId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM signatures s
      JOIN estimate_versions v ON v.id = s.version_id
      JOIN estimates e ON e.id = v.estimate_id
     WHERE e.project_id = ? LIMIT 1
  `).get(projectId)) || Boolean(db.prepare(`
    SELECT 1 FROM agreement_evidence a JOIN hub_imports i ON i.hub_id = a.project_id WHERE i.project_id = ? LIMIT 1
  `).get(projectId));
}

/**
 * The state of a project row from its checklist, whose money stage the caller
 * already has (projectStage). An item is waiting on the client from its first
 * published version: a newer one still unpublished doesn't take back what they
 * have, until they answer it: a draft they approved is the studio's to follow with
 * the Final. Approvals (C5, itemApproved) and submitted notes (C4) join here.
 */
function stateOf(p, money, invoices, deliverables, signed) {
  const items = deliverables.map((d) => ({
    notNeeded: Boolean(d.notNeededAt),
    approved: itemApproved(d),
    awaitingClient: Boolean(newestPublished(d) && !newestPublished(d).approval),
    // Notes sent on the newest version the client has (C4), until the studio publishes
    // the next; or where the old hub left it.
    notesSubmitted: d.hubStatus === 'changes' || Boolean(newestPublished(d) && newestPublished(d).submittedAt),
  }));
  return deliveryState({
    money,
    project: {
      upid: p.upid,
      archivedAt: p.archived_at,
      noDeliverablesAt: p.no_deliverables_at,
      paymentRequired: p.payment_required === 1,
      paymentClaimedAt: p.payment_claimed_at,
      downloadsLocked: p.downloads_locked === 1,
    },
    items,
    invoices: invoices || [],
    signed,
  });
}

/**
 * One project's checklist and state.
 *
 * @returns {{ state: object, deliverables: Array }}
 */
function readDelivery(db, p, money, invoices) {
  const deliverables = readChecklist(db, p.id);
  return { state: stateOf(p, money, invoices, deliverables, projectSigned(db, p.id)), deliverables };
}

/**
 * The state of many projects at once, for the lists: reads every checklist
 * and signature up front, then answers (p, money, invoices) => state. Make one
 * per request.
 */
function deliveryReader(db) {
  const versions = db.prepare('SELECT * FROM deliverable_versions ORDER BY n').all();
  const items = db.prepare('SELECT * FROM deliverables ORDER BY position, created_at, id').all();
  const submissions = db.prepare('SELECT id, project_id, deliverable_id, version_id, stage, submitted_at FROM client_submissions').all();
  const approvals = db.prepare('SELECT * FROM client_approvals').all();
  const signed = new Set(db.prepare(`
    SELECT DISTINCT e.project_id FROM signatures s
      JOIN estimate_versions v ON v.id = s.version_id
      JOIN estimates e ON e.id = v.estimate_id
    UNION
    SELECT i.project_id FROM agreement_evidence a JOIN hub_imports i ON i.hub_id = a.project_id WHERE i.project_id IS NOT NULL
  `).all().map((r) => r.project_id));
  const byProject = (rows) => {
    const map = new Map();
    rows.forEach((r) => {
      if (!map.has(r.project_id)) map.set(r.project_id, []);
      map.get(r.project_id).push(r);
    });
    return map;
  };
  const itemsOf = byProject(items);
  const versionsOf = byProject(versions);
  const submissionsOf = byProject(submissions);
  const approvalsOf = byProject(approvals);
  return (p, money, invoices) => stateOf(p, money, invoices,
    checklistOf(itemsOf.get(p.id) || [], versionsOf.get(p.id) || [], {
      submissions: submissionsOf.get(p.id) || [], approvals: approvalsOf.get(p.id) || [],
    }), signed.has(p.id));
}

module.exports = {
  quotedDeliverables, createChecklist, clientForAcceptance, deliveryState, readDelivery, deliveryReader, readChecklist, newestPublished,
  itemApproved, BADGES, MAX_PER_LINE, ROUNDS_INCLUDED,
};
