'use strict';

/**
 * Emails to the studio about what a client did in the portal (merged-admin C6).
 * Built from the database when it happens, so each says only what was recorded:
 * the counts, the version and the round come from the saved rows, not from the
 * request. Best effort: the client's action has already been saved, so a mail
 * that can't go is logged and never turns their save into an error. Needs you
 * shows the same notes either way.
 */

const { readSettings } = require('./ratecard');
const { notesSubmittedEmail } = require('./mail');
const { projectNameOf } = require('./portal-invite');
const { ROUNDS_INCLUDED } = require('./delivery');

/**
 * A set of notes was sent (hub submit route). Never rejects.
 *
 * @param {{ mailer:object, appUrl:string }} env
 * @param {{ submissionId:string }} ev
 * @returns {Promise<boolean>} whether an email went
 */
let warnedNoAppUrl = false;

async function notesSubmitted(db, env, ev) {
  try {
    const owner = env.mailer && env.mailer.configured ? env.mailer.replyTo : '';
    if (!owner) return false;
    // Without APP_URL the notice still goes, just with no link back to the project.
    if (!env.appUrl && !warnedNoAppUrl) {
      warnedNoAppUrl = true;
      console.warn('[mail] APP_URL isn\'t set, so the studio\'s notes notices go without a link to the project');
    }
    const s = db.prepare(`
      SELECT s.*, d.title, v.n AS version_n, p.upid, c.business_name, c.contact_name
        FROM client_submissions s
        JOIN deliverables d ON d.id = s.deliverable_id
        JOIN deliverable_versions v ON v.id = s.version_id
        JOIN projects p ON p.id = s.project_id
        LEFT JOIN clients c ON c.id = s.client_id
       WHERE s.id = ?
    `).get(ev.submissionId);
    if (!s) return false;
    const round = s.stage === 'final'
      ? db.prepare(`
        SELECT COUNT(*) AS n FROM client_submissions
         WHERE deliverable_id = ? AND stage = 'final' AND (submitted_at < ? OR (submitted_at = ? AND id <= ?))
      `).get(s.deliverable_id, s.submitted_at, s.submitted_at, s.id).n
      : undefined;
    const mail = notesSubmittedEmail({
      business: readSettings(db).business || {},
      appUrl: env.appUrl,
      clientName: s.business_name || s.contact_name || '',
      projectName: projectNameOf(db, s.project_id),
      upid: s.upid || '',
      itemTitle: s.title,
      versionN: s.version_n,
      stage: s.stage,
      noteCount: s.note_count,
      round,
      included: ROUNDS_INCLUDED,
      link: env.appUrl ? `${env.appUrl}#/projects/${s.project_id}` : '',
    });
    await env.mailer.send({ to: owner, ...mail });
    return true;
  } catch (err) {
    console.error(`[mail] notes-submitted notice failed: ${err && err.code ? err.code : (err && err.message) || 'error'}`);
    return false;
  }
}

module.exports = { notesSubmitted };
