'use strict';

/**
 * The client's reminder before a Final is deemed approved (merged-admin C7; brief:
 * "The client gets a reminder before the date"). A pass an hour looks at every
 * running clock (deemed.js) and emails the client once per version, from its
 * `remindOn` day up to and including its `lastDay`: a reminder after the last day
 * would tell them about a date already gone, so none goes then.
 *
 * It goes only to a client who can open what it points at: an email of their own
 * (not shared with another client), and a way into the portal (an invite went, or
 * they have a code). Otherwise there is nothing to send and nothing is recorded;
 * the next pass looks again (the studio may add the email meanwhile).
 *
 * Each try is recorded in deemed_reminders (v30). A failed send is tried again on
 * later passes while the client still has days left, up to MAX_ATTEMPTS, and
 * logged on the project. Like the invite, it doesn't use the send queue: its
 * `purpose` is a CHECK list of the signing emails.
 */

const { nowIso, newId } = require('./db');
const { readSettings } = require('./ratecard');
const { isEmail, deemedReminderEmail } = require('./mail');
const { emailSharedWith } = require('./clients');
const { accessStatus } = require('./portal-access');
const { deemedClocks, sydneyDay } = require('./deemed');
const { projectNameOf } = require('./portal-invite');

const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function logActivity(db, projectId, kind, detail, at) {
  db.prepare('INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(newId('act'), projectId, at, kind, JSON.stringify(detail));
}

/* Can this client open the portal the reminder points at? */
function reachable(db, client) {
  if (!client || !client.email || !isEmail(client.email)) return false;
  if (emailSharedWith(db, client).length) return false;
  const invited = db.prepare(`
    SELECT 1 FROM activity a JOIN projects p ON p.id = a.project_id
     WHERE p.client_id = ? AND a.kind = 'portal_invite_sent' LIMIT 1
  `).get(client.id);
  return Boolean(invited || accessStatus(db, client.id).hasCode);
}

/**
 * @param {object} env  { mailer, appUrl, portalUrl, now?: () => Date, tickMs? }
 */
function createDeemedReminders(db, env) {
  const now = env.now || (() => new Date());
  let timer = null;
  let running = false;

  const getRow = db.prepare('SELECT * FROM deemed_reminders WHERE version_id = ?');
  const upsert = db.prepare(`
    INSERT INTO deemed_reminders (version_id, project_id, status, to_email, last_day, attempts, error, sent_at, updated_at)
    VALUES (@version_id, @project_id, @status, @to_email, @last_day, 1, @error, @sent_at, @updated_at)
    ON CONFLICT(version_id) DO UPDATE SET
      status = excluded.status, to_email = excluded.to_email, last_day = excluded.last_day,
      attempts = deemed_reminders.attempts + 1, error = excluded.error, sent_at = excluded.sent_at,
      updated_at = excluded.updated_at
  `);

  /**
   * One pass. `today` is the Sydney day (tests pass their own).
   * @returns {Promise<{ sent:number, failed:number }>}
   */
  async function runDue(today = sydneyDay(now().toISOString())) {
    const out = { sent: 0, failed: 0 };
    if (running || !env.mailer || !env.mailer.configured || !env.portalUrl) return out;
    running = true;
    try {
      const due = deemedClocks(db).filter((c) => today >= c.remindOn && today <= c.lastDay);
      for (const c of due) {
        const done = getRow.get(c.versionId);
        if (done && (done.status === 'sent' || done.attempts >= MAX_ATTEMPTS)) continue;
        const client = c.clientId ? db.prepare('SELECT * FROM clients WHERE id = ?').get(c.clientId) : null;
        if (!reachable(db, client)) continue;
        // Still unanswered right now? The send below is awaited; read the clock just before it.
        if (!deemedClocks(db, { projectId: c.projectId }).some((x) => x.versionId === c.versionId)) continue;
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(c.projectId);
        const mail = deemedReminderEmail({
          business: readSettings(db).business || {},
          appUrl: env.appUrl,
          contactName: client.contact_name,
          projectName: projectNameOf(db, c.projectId),
          upid: (project && project.upid) || '',
          itemTitle: c.title,
          versionN: c.n,
          publishedOn: c.publishedOn,
          lastDay: c.lastDay,
          link: env.portalUrl,
        });
        const at = nowIso();
        try {
          await env.mailer.send({ to: client.email, ...mail });
        } catch (err) {
          const error = String((err && err.message) || err).slice(0, 300);
          upsert.run({ version_id: c.versionId, project_id: c.projectId, status: 'failed', to_email: client.email,
            last_day: c.lastDay, error, sent_at: null, updated_at: at });
          logActivity(db, c.projectId, 'deemed_reminder_failed', { title: c.title, n: c.n, to: client.email, error }, at);
          console.error(`[mail] deemed-approval reminder for version ${c.versionId} failed: ${err && err.code ? err.code : 'error'}`);
          out.failed += 1;
          continue;
        }
        upsert.run({ version_id: c.versionId, project_id: c.projectId, status: 'sent', to_email: client.email,
          last_day: c.lastDay, error: '', sent_at: at, updated_at: at });
        logActivity(db, c.projectId, 'deemed_reminder_sent', { title: c.title, n: c.n, to: client.email, lastDay: c.lastDay }, at);
        out.sent += 1;
      }
    } finally {
      running = false;
    }
    return out;
  }

  function kick() {
    runDue().catch((err) => console.error('[mail] deemed-approval reminder pass failed:', err.message));
  }

  return {
    runDue,
    /** A pass now, then one an hour. */
    start() {
      kick();
      timer = setInterval(kick, env.tickMs || HOUR_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** Where each version's reminder stands, for the studio: `{ [versionId]: row }`. */
function remindersOf(db, projectId) {
  return Object.fromEntries(db.prepare('SELECT * FROM deemed_reminders WHERE project_id = ?').all(projectId)
    .map((r) => [r.version_id, { status: r.status, to: r.to_email, sentAt: r.sent_at, attempts: r.attempts, error: r.error }]));
}

module.exports = { createDeemedReminders, remindersOf, MAX_ATTEMPTS };
