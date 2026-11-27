'use strict';

/**
 * Needs you (merged-admin R5; IA "Needs you"): the queue of what is waiting on
 * the studio, worked out fresh from the records on every ask. Nothing is stored
 * as an item, so an item leaves the moment the thing behind it is resolved, not
 * when someone clicks it. The one exception is "New project", which is a notice
 * with nothing to resolve: it leaves when the project is first opened.
 *
 * KINDS, in the IA's order (contract clocks and client money first). Later tasks
 * add theirs at the places marked below; the client reads only `kind`, so a new
 * kind needs a label there and nothing else.
 *
 *   deemed_approval   (C7)  14 business days after a Final
 *   paid_claim        (C6+) "I've paid" pressed by the client
 *   revision_notes    (C4)  the client submitted notes
 *   final_invoice     (C5)  everything approved, final invoice not sent
 *   publish_failed    (B2)  Bunny gave up on the newest version of a needed item
 *   invoice_overdue         a sent invoice past its due date
 *   quote_awaiting          a quote sent QUOTE_DAYS or more ago, no answer
 *   no_upid                 an accepted project with no UPID
 *   new_project             an accepted project nobody has opened
 *
 * Within a kind, the oldest waiting comes first. Not paginated: a long queue is
 * real information.
 */

const { amountDue, parseJson } = require('./invoices');
const { ROUNDS_INCLUDED } = require('./delivery');
const { deemedClocks } = require('./deemed');

const QUOTE_DAYS = 7;

const KINDS = [
  'deemed_approval', 'paid_claim', 'revision_notes', 'final_invoice', 'publish_failed',
  'invoice_overdue', 'quote_awaiting', 'no_upid', 'new_project',
];

const day = (iso) => String(iso || '').slice(0, 10);
/* The Sydney day of a moment (S19): a timestamp's UTC date is the day before for
   anything done in a Sydney morning. */
const SYDNEY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });
const sydneyDay = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? SYDNEY_DAY.format(new Date(iso)) : '');
const dayNumber = (ymd) => Math.round(Date.parse(ymd + 'T00:00:00Z') / 86400000);
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

/**
 * @param {object} db
 * @param {{today: string, briefs: function, rows: Array}} ctx
 *   today (YYYY-MM-DD), projectBriefs(db) and readProjectRows' result.
 * @returns {Array<object>} items: { id, kind, projectId, invoiceId?, name,
 *   client, upid, since, days?, number?, amount? }
 */
function readNeeds(db, { today, briefs, rows }) {
  /* An item for `row` (project_id, client_id, upid, name): named as a card is,
     with the project's own name when no estimate gives one (an old hub's). */
  const base = (kind, row, extra) => {
    const b = briefs(row);
    return {
      id: kind + ':' + (extra.invoiceId || row.project_id), kind, projectId: row.project_id,
      name: b.name || row.name || '', client: b.client, upid: row.upid || '', ...extra,
    };
  };
  const items = [];

  // Approval due (C7): a Final the client left unanswered past its 14 business days
  // (deemed.js). From the day after their last day; it leaves when the studio marks
  // it, the client answers, or a newer file restarts the clock. The row opens the
  // item, where Mark approved is.
  deemedClocks(db).filter((c) => today >= c.dueOn).forEach((c) => {
    items.push({
      ...base('deemed_approval', { project_id: c.projectId, client_id: c.clientId, upid: c.upid, name: c.name }, {
        itemId: c.itemId, versionId: c.versionId, title: c.title, n: c.n, lastDay: c.lastDay,
        since: c.dueOn, days: daysBetween(c.dueOn, today),
      }),
      id: 'deemed_approval:' + c.versionId,
    });
  });

  // Revision notes (C4): a set the client sent on the newest version they have, until the
  // studio publishes the next one. One row per item; the oldest waiting first.
  db.prepare(`
    SELECT s.deliverable_id, s.note_count, s.submitted_at, s.stage, d.title, p.id AS project_id, p.client_id, p.upid, p.name,
           (SELECT COUNT(*) FROM client_submissions x
             WHERE x.deliverable_id = s.deliverable_id AND x.stage = 'final'
               AND (x.submitted_at < s.submitted_at OR (x.submitted_at = s.submitted_at AND x.id <= s.id))) AS round_n
      FROM client_submissions s
      JOIN deliverables d ON d.id = s.deliverable_id
      JOIN projects p ON p.id = s.project_id
     WHERE p.archived_at IS NULL AND d.not_needed_at IS NULL
       AND s.version_id = (SELECT v.id FROM deliverable_versions v
                            WHERE v.deliverable_id = s.deliverable_id AND v.published_at IS NOT NULL
                            ORDER BY v.n DESC LIMIT 1)
     ORDER BY s.submitted_at, s.deliverable_id
  `).all().forEach((s) => {
    const since = sydneyDay(s.submitted_at);
    // On a Final, which round this set is (C5); past the included ones the studio quotes
    // before working (brief, Revision rounds: flagged, never charged on its own).
    const round = s.stage === 'final' ? s.round_n : null;
    items.push({
      ...base('revision_notes', s, {
        itemId: s.deliverable_id, title: s.title || '', notes: s.note_count, since, days: daysBetween(since, today),
        round, included: ROUNDS_INCLUDED, extraRound: round !== null && round > ROUNDS_INCLUDED,
      }),
      id: 'revision_notes:' + s.deliverable_id,
    });
  });

  // Publish failed (Bunny Slice 3): Bunny gave up on the newest version of a needed item,
  // so the client can't be given its video (a photo library, Slice 7, can go to them
  // from the NAS meanwhile, but the send still needs doing again). Leaves when a publish of it goes through (or a newer
  // version replaces it); the row opens the item, where Send to Bunny again is. A version
  // the client already has isn't counted: they still watch it from the NAS, so nothing
  // waits on it (its item page says the send failed). A Final's master (Slice 8) isn't
  // counted either: Publish never waits on it, and the item page says when one failed.
  db.prepare(`
    SELECT b.version_id, b.error, b.updated_at, v.n, d.id AS item_id, d.title,
           p.id AS project_id, p.client_id, p.upid, p.name
      FROM bunny_assets b
      JOIN deliverable_versions v ON v.id = b.version_id
      JOIN deliverables d ON d.id = v.deliverable_id
      JOIN projects p ON p.id = d.project_id
     WHERE b.status = 'failed' AND b.kind != 'master' AND p.archived_at IS NULL AND p.declined_at IS NULL AND d.not_needed_at IS NULL
       AND v.published_at IS NULL
       AND v.n = (SELECT MAX(n) FROM deliverable_versions WHERE deliverable_id = d.id)
     ORDER BY b.updated_at, b.version_id
  `).all().forEach((b) => {
    const since = sydneyDay(b.updated_at);
    items.push({
      ...base('publish_failed', b, {
        itemId: b.item_id, versionId: b.version_id, title: b.title || '', n: b.n, error: b.error || '',
        since, days: daysBetween(since, today),
      }),
      id: 'publish_failed:' + b.version_id,
    });
  });

  // Invoice overdue: sent, unpaid, past its due date. A void invoice never gets here.
  db.prepare(`
    SELECT i.id, i.project_id, i.number, i.kind, i.due_at, i.totals_json, p.client_id, p.upid, p.name
      FROM invoices i JOIN projects p ON p.id = i.project_id
     WHERE i.status = 'sent' AND i.due_at IS NOT NULL AND p.declined_at IS NULL
     ORDER BY i.due_at, i.id
  `).all().forEach((i) => {
    const due = day(i.due_at);
    if (!due || due >= today) return;
    const amount = amountDue(i.kind, parseJson(i.totals_json, {}));
    items.push(base('invoice_overdue', i, {
      invoiceId: i.id, number: i.number || '', since: due, days: daysBetween(due, today), amount,
    }));
  });

  // Send final invoice (C5): every item approved or not needed, at least one approved,
  // and no invoice that closes the job (final, single or legacy) scheduled, sent or paid.
  // Dated from the newest approval that signs an item off: a Final's, on the item's newest
  // version (delivery.js itemApproved). A draft's, or one on a file since replaced, isn't
  // when everything got approved. Items the old hub signed off (R4) carry no date, so a
  // project with only those has none and the row says so, never "today".
  // Its draft final, when there is one, is where the row opens.
  const billed = new Set(db.prepare(`
    SELECT DISTINCT project_id FROM invoices WHERE kind IN ('final', 'single', 'legacy') AND status IN ('scheduled', 'sent', 'paid')
  `).all().map((r) => r.project_id));
  const draftFinal = new Map(db.prepare(`
    SELECT project_id, id FROM invoices WHERE kind IN ('final', 'single') AND status = 'draft' ORDER BY created_at, id
  `).all().map((r) => [r.project_id, r.id])); // the newest draft wins
  const lastSignOff = new Map(db.prepare(`
    SELECT d.project_id, MAX(a.approved_at) AS at
      FROM deliverables d
      JOIN deliverable_versions v ON v.deliverable_id = d.id
       AND v.n = (SELECT MAX(n) FROM deliverable_versions WHERE deliverable_id = d.id)
      JOIN client_approvals a ON a.version_id = v.id AND a.stage = 'final'
     WHERE d.not_needed_at IS NULL
     GROUP BY d.project_id
  `).all().map((r) => [r.project_id, r.at]));
  rows.map((r) => r.project).forEach((p) => {
    const { checklist, badge, group } = p.delivery;
    if (group === 'pipeline' || badge === 'archived' || p.stage === 'declined' || p.stage === 'paid') return;
    if (checklist.open > 0 || checklist.approved === 0 || billed.has(p.id)) return;
    const since = sydneyDay(lastSignOff.get(p.id)) || null;
    const invoiceId = draftFinal.get(p.id);
    items.push({ id: 'final_invoice:' + p.id, kind: 'final_invoice', projectId: p.id, name: p.name,
      client: p.client.businessName || p.client.contactName, upid: p.upid, since, days: since ? daysBetween(since, today) : null,
      ...(invoiceId ? { invoiceId } : {}) });
  });

  // Quote awaiting reply: still sent after QUOTE_DAYS. Sent today is day 0.
  rows.map((r) => r.project).filter((p) => p.stage === 'sent' && p.stageDetail.at).forEach((p) => {
    const sent = sydneyDay(p.stageDetail.at) || day(p.stageDetail.at);
    const waited = daysBetween(sent, today);
    if (waited >= QUOTE_DAYS) {
      items.push({ id: 'quote_awaiting:' + p.id, kind: 'quote_awaiting', projectId: p.id, name: p.name,
        client: p.client.businessName || p.client.contactName, upid: p.upid, since: sent, days: waited });
    }
  });

  // No UPID and new project: accepted, live (not declined, not archived).
  db.prepare(`
    SELECT id AS project_id, client_id, upid, name, accepted_at, opened_at FROM projects
     WHERE accepted_at IS NOT NULL AND declined_at IS NULL AND archived_at IS NULL
     ORDER BY accepted_at, project_id
  `).all().forEach((p) => {
    const since = sydneyDay(p.accepted_at) || day(p.accepted_at);
    if (!p.upid) items.push(base('no_upid', p, { since }));
    if (!p.opened_at) items.push(base('new_project', p, { since }));
  });

  // Stable sort by the IA's order; each kind keeps its oldest-first order.
  return items
    .map((item, n) => ({ item, n }))
    .sort((a, b) => KINDS.indexOf(a.item.kind) - KINDS.indexOf(b.item.kind) || a.n - b.n)
    .map((x) => x.item);
}

module.exports = { readNeeds, KINDS, QUOTE_DAYS };
