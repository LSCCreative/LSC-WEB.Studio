'use strict';

/**
 * Deemed approval (merged-admin C7; brief "Deemed approval"; contract clause 4:
 * "Deliverables are deemed approved if no revision request is received within 14
 * business days of delivery").
 *
 * THE CLOCK. It starts on the Sydney day a Final version is published, which never
 * counts itself, and runs 14 business days: Monday to Friday, skipping the NSW
 * public holidays in the holidays table (the one the calendar uses, holidays the
 * owner hid included as working days, as everywhere else). The client has all of
 * the 14th day (`lastDay`); from the next day (`dueOn`) the studio may mark it.
 * Each new version restarts it, because only the item's newest version has one.
 *
 * SILENCE. The clock runs while the newest version is a published Final with no
 * approval and no set of notes sent on it. Notes the client has written but not
 * sent are still silence: nothing reached the studio. An item the old hub left
 * approved or with changes (R4) has no clock until its next file.
 *
 * NOTHING CHANGES ON ITS OWN (brief). This module only says where each clock
 * stands. The studio's Mark approved records the deemed approval (routes/
 * deliverables.js); the client's reminder (deemed-reminders.js) goes before it.
 */

const { dayKind } = require('./calc');
const { readHolidays } = require('./days');

const DEEMED_BUSINESS_DAYS = 14;
/* The client's reminder goes this many business days before their last day. */
const REMIND_BUSINESS_DAYS_BEFORE = 3;

const SYDNEY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });
const sydneyDay = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? SYDNEY_DAY.format(new Date(iso)) : '');

/** 'YYYY-MM-DD' → the next calendar day, read in UTC so no timezone moves it. */
function nextDay(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* Monday to Friday and not a listed holiday. The studio's own working week
   (Settings' surcharges) is for pricing days, not the contract's business days. */
const isBusinessDay = (ymd, holidays) => dayKind(ymd, {}, holidays) === 'weekday';

/** The nth business day after `ymd`; `ymd` itself never counts. */
function businessDaysAfter(ymd, n, holidays) {
  let d = ymd;
  for (let k = 0; k < n;) {
    d = nextDay(d);
    if (isBusinessDay(d, holidays)) k += 1;
  }
  return d;
}

/**
 * One version's clock from when it was published.
 * @returns {{ publishedOn, remindOn, lastDay, dueOn }} Sydney days
 */
function clockOf(publishedAt, holidays) {
  const publishedOn = sydneyDay(publishedAt);
  const lastDay = businessDaysAfter(publishedOn, DEEMED_BUSINESS_DAYS, holidays);
  return {
    publishedOn,
    remindOn: businessDaysAfter(publishedOn, DEEMED_BUSINESS_DAYS - REMIND_BUSINESS_DAYS_BEFORE, holidays),
    lastDay,
    dueOn: nextDay(lastDay),
  };
}

/**
 * Every running clock: one per item whose newest version is a published Final the
 * client hasn't answered, on a live project (accepted, not declined or archived).
 *
 * @param {{ projectId?: string }} [opts] one project's only
 * @returns {Array<{ projectId, itemId, versionId, n, title, fileName, upid, name, clientId,
 *   publishedAt, publishedOn, remindOn, lastDay, dueOn }>} oldest due first
 */
function deemedClocks(db, { projectId = null } = {}) {
  const rows = db.prepare(`
    SELECT v.id AS version_id, v.n, v.published_at, v.file_name, d.id AS item_id, d.title,
           p.id AS project_id, p.upid, p.name, p.client_id
      FROM deliverables d
      JOIN projects p ON p.id = d.project_id
      JOIN deliverable_versions v ON v.deliverable_id = d.id
       AND v.n = (SELECT MAX(n) FROM deliverable_versions WHERE deliverable_id = d.id)
     WHERE d.not_needed_at IS NULL
       AND p.accepted_at IS NOT NULL AND p.declined_at IS NULL AND p.archived_at IS NULL
       AND v.published_at IS NOT NULL AND v.stage = 'final'
       AND d.hub_status IS NULL
       AND NOT EXISTS (SELECT 1 FROM client_approvals a WHERE a.version_id = v.id)
       AND NOT EXISTS (SELECT 1 FROM client_submissions s WHERE s.version_id = v.id)
       AND (? IS NULL OR p.id = ?)
     ORDER BY v.published_at, v.id
  `).all(projectId, projectId);
  if (!rows.length) return [];
  const holidays = readHolidays(db);
  return rows.map((r) => ({
    projectId: r.project_id,
    itemId: r.item_id,
    versionId: r.version_id,
    n: r.n,
    title: r.title || '',
    fileName: r.file_name || '',
    upid: r.upid || '',
    name: r.name || '',
    clientId: r.client_id || null,
    publishedAt: r.published_at,
    ...clockOf(r.published_at, holidays),
  }));
}

module.exports = {
  deemedClocks, clockOf, businessDaysAfter, isBusinessDay, sydneyDay, nextDay,
  DEEMED_BUSINESS_DAYS, REMIND_BUSINESS_DAYS_BEFORE,
};
