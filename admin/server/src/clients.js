'use strict';

/**
 * A client's email is their portal login (merged-admin S13; IA "Client code":
 * one per client). So it has one spelling, and one client holds it.
 *
 * ONE SPELLING: trimmed and lower-cased on every write (and by v23 for what was
 * already there), in JS, because SQLite's lower() folds only ASCII.
 *
 * ONE HOLDER: a save that gives a client an address another client has is
 * refused. There is no unique index, on purpose: the live list may already hold
 * two clients with one address, and refusing a boot, or a save that only changes
 * their phone number, would fix nothing. Those stay until someone changes one;
 * `emailSharedWith` lets the record say so.
 *
 * THE LOGIN FOLLOWS THE CLIENT: changing the address moves any portal login
 * their projects hold, in the same transaction, so a client can't be left
 * signing in with an address the studio has replaced.
 */

const { sha256Hex } = require('./hub/tokens');

const normEmail = (value) => String(value == null ? '' : value).trim().toLowerCase();

/** Another client holding this address, oldest first, or null. `own` is left out. */
function emailHolder(db, email, own) {
  if (!email) return null;
  return db.prepare(`
    SELECT id, business_name FROM clients
     WHERE email = ? AND id <> ? ORDER BY created_at, id LIMIT 1
  `).get(email, own || '') || null;
}

/** The other clients on this client's address: only ones from before the rule. */
function emailSharedWith(db, client) {
  if (!client.email) return [];
  return db.prepare('SELECT id, business_name FROM clients WHERE email = ? AND id <> ? ORDER BY created_at, id')
    .all(client.email, client.id)
    .map((c) => ({ id: c.id, businessName: c.business_name }));
}

function emailTakenReply(email, holder) {
  return {
    error: 'email_taken',
    holder: { id: holder.id, businessName: holder.business_name },
    message: `${email} is already on ${holder.business_name}. A client signs in to the portal with their email, ` +
      'so each client needs their own.',
  };
}

/** Does a project of this client have a portal login? */
function hasPortalLogin(db, clientId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM private_auth a JOIN projects p ON p.id = a.project_id WHERE p.client_id = ? LIMIT 1
  `).get(clientId));
}

/** The client's new address onto their projects' logins, inside the caller's transaction. */
function moveLogin(db, clientId, email, now) {
  db.prepare(`
    UPDATE private_auth SET client_email = ?, email_hash = ?, updated_at = ?
     WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)
  `).run(email, sha256Hex(email), now, clientId);
}

module.exports = { normEmail, emailHolder, emailSharedWith, emailTakenReply, hasPortalLogin, moveLogin };
