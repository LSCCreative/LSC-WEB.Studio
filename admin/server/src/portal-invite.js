'use strict';

/**
 * The Client Portal invite (merged-admin C6). It goes out once per client: with
 * the first publish on a project (the studio confirms it, naming who gets it) or
 * by hand before that. A later publish never re-invites.
 *
 * WHY IT ISN'T IN THE SEND QUEUE. The email carries the Client code, and the
 * server keeps only a hash of it, so the message can't be rebuilt later from a
 * queued row. It is sent in the request that issues the code. If that send
 * fails, the studio is handed the code and link once, to pass on themselves, and
 * the failure is logged on the project.
 *
 * Issuing a code is a reset (C1): it signs the client out and retires their old
 * codes. So an invite is only offered to a client who has no way in yet and has
 * not been invited before. The one exception is an invite whose email failed
 * (`retry`): it can be sent again while the code it issued is still the newest and
 * nobody has ever signed in as that client. Sending again retires that code, so a
 * code the studio passed on by hand stops working, and the dialog says so.
 */

const { newId, nowIso } = require('./db');
const { readSettings } = require('./ratecard');
const { createPortalAccess, accessStatus } = require('./portal-access');
const { emailSharedWith } = require('./clients');
const { isEmail, portalInviteEmail } = require('./mail');

/* One invite per client at a time: a double click can't issue two codes, the
   second of which would kill the first's email. */
const inFlight = new Set();

function logActivity(db, projectId, kind, detail, at) {
  db.prepare('INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(newId('act'), projectId, at, kind, JSON.stringify(detail));
}

/** A project's name: its first estimate's, else its own (an imported hub project has no estimate). */
function projectNameOf(db, projectId) {
  const est = db.prepare('SELECT name FROM estimates WHERE project_id = ? ORDER BY created_at, id LIMIT 1').get(projectId);
  if (est && est.name && est.name.trim()) return est.name.trim();
  const own = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
  return own && own.name ? own.name.trim() : '';
}

/**
 * Where a project's client stands for an invite, and what the studio's dialog
 * should say.
 *
 * @param {{ portalSecret?:string, mailer?:{configured:boolean} }} env
 * @returns {{ state:string, to?:string, name?:string, at?:string, failedAt?:string }}
 *   state: `ready` | `retry` | `sent` | `has_access` | `no_client` | `no_email` |
 *          `email_shared` | `no_portal` | `no_mail`
 */
function inviteOffer(db, project, env) {
  const client = project.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(project.client_id) : null;
  if (!client) return { state: 'no_client' };
  const lastOf = (kind) => db.prepare(`
    SELECT a.at FROM activity a JOIN projects p ON p.id = a.project_id
     WHERE p.client_id = ? AND a.kind = ? ORDER BY a.at DESC LIMIT 1
  `).get(client.id, kind);
  const sent = lastOf('portal_invite_sent');
  if (sent) return { state: 'sent', at: sent.at };
  const access = accessStatus(db, client.id);
  // A failed invite's code, still the newest, that nobody has ever signed in with. A PIN
  // the client chose proves they did, though their sessions may have ended since.
  const failed = lastOf('portal_invite_failed');
  const retry = Boolean(failed && access.hasCode && access.codeSetAt && access.codeSetAt <= failed.at
    && !access.pinChosenAt
    && !db.prepare('SELECT 1 FROM client_sessions WHERE client_id = ? LIMIT 1').get(client.id));
  if ((access.hasCode || access.oldCodes > 0) && !retry) return { state: 'has_access' };
  if (!client.email || !isEmail(client.email)) return { state: 'no_email' };
  if (emailSharedWith(db, client).length) return { state: 'email_shared' };
  if (!env.portalSecret) return { state: 'no_portal' };
  if (!env.mailer || !env.mailer.configured) return { state: 'no_mail' };
  return {
    state: retry ? 'retry' : 'ready', to: client.email, name: client.contact_name || client.business_name,
    ...(retry ? { failedAt: failed.at } : {}),
  };
}

/* What the client will find when they open the invite: the stage of the newest version
   they've been given, or null when nothing is published yet (an invite sent by hand). */
function shownStage(db, projectId) {
  const v = db.prepare(`
    SELECT v.stage FROM deliverable_versions v JOIN deliverables d ON d.id = v.deliverable_id
     WHERE d.project_id = ? AND v.published_at IS NOT NULL AND d.not_needed_at IS NULL
     ORDER BY v.published_at DESC, v.n DESC LIMIT 1
  `).get(projectId);
  return v ? v.stage : null;
}

/* The portal's settings, per database, set when the app is built: every reply that
   carries the folder (readFolder) reads the invite state, not just the deliverables routes. */
const envs = new WeakMap();
const setEnv = (db, env) => envs.set(db, env);

/** inviteOffer, plus whether publishing now would be the project's first publish. */
function inviteView(db, project) {
  const first = !db.prepare(`
    SELECT 1 FROM deliverable_versions v JOIN deliverables d ON d.id = v.deliverable_id
     WHERE d.project_id = ? AND v.published_at IS NOT NULL LIMIT 1
  `).get(project.id);
  return { ...inviteOffer(db, project, envs.get(db) || {}), firstPublish: first };
}

/**
 * Issues the client's code and emails the invite. Only for a `ready` or `retry`
 * offer; anything else is refused with the reason and nothing is issued.
 *
 * @param {object} env  { portalSecret, portalUrl, appUrl, mailer }
 * @returns {Promise<{sent:true, to:string}
 *   |{sent:false, state:string}
 *   |{sent:false, failed:true, error:string, code:string, inviteUrl:string, to:string}>}
 */
async function sendInvite(db, project, env, { now = nowIso() } = {}) {
  const offer = inviteOffer(db, project, env);
  if (offer.state !== 'ready' && offer.state !== 'retry') return { sent: false, state: offer.state };
  if (inFlight.has(project.client_id)) return { sent: false, state: 'busy' };
  inFlight.add(project.client_id);
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(project.client_id);
    const { code, invite } = createPortalAccess(db, { secret: env.portalSecret })
      .issue(client.id, { projectId: project.id, now });
    // In the fragment, so the token never reaches a server's log or a Referer.
    const inviteUrl = `${env.portalUrl || ''}#/invite/${invite}`;
    const mail = portalInviteEmail({
      business: readSettings(db).business || {},
      appUrl: env.appUrl,
      contactName: client.contact_name,
      email: client.email,
      projectName: projectNameOf(db, project.id),
      upid: project.upid || '',
      shown: shownStage(db, project.id),
      code,
      link: inviteUrl,
    });
    try {
      await env.mailer.send({ to: client.email, ...mail });
    } catch (err) {
      const error = String((err && err.message) || err).slice(0, 300);
      logActivity(db, project.id, 'portal_invite_failed', { to: client.email, error }, nowIso());
      console.error(`[mail] portal invite to client ${client.id} failed: ${err && err.code ? err.code : 'error'}`);
      return { sent: false, failed: true, error, code, inviteUrl, to: client.email };
    }
    logActivity(db, project.id, 'portal_invite_sent', { to: client.email, clientId: client.id }, nowIso());
    return { sent: true, to: client.email };
  } finally {
    inFlight.delete(project.client_id);
  }
}

module.exports = { inviteOffer, inviteView, setEnv, sendInvite, projectNameOf };
