'use strict';

/**
 * v34: the client's own PIN (portal first sign-in).
 *
 * client_logins.code_chosen_at  When the client last replaced the studio's Client
 *                  code with a PIN of their own, from the portal; NULL while they
 *                  still sign in with the code the studio emailed. The portal asks
 *                  for a PIN while it is NULL. The PIN takes the code's place
 *                  (`code_hash`), so the studio issuing a new code (a reset) sets
 *                  this back to NULL and the client is asked again.
 *
 * Every row already here is a studio-issued code, so it starts NULL. Safe to run twice.
 */
function migrateV34(db) {
  const cols = db.prepare('PRAGMA table_info(client_logins)').all().map((c) => c.name);
  if (!cols.includes('code_chosen_at')) db.exec('ALTER TABLE client_logins ADD COLUMN code_chosen_at TEXT');
}

module.exports = { migrateV34 };
