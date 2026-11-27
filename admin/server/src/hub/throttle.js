'use strict';

/* Wrong sign-in codes per key (a client's address, hashed), for the portal's sign-in,
   counted over several windows at once: 10 in 15 minutes stops a burst, and a day's
   cap stops patient guessing, which a 4-digit PIN would otherwise fall to in days.
   Kept in SQLite (`portal_code_failures`, v35) so a restart or a deploy never hands a
   guesser a fresh count. Rows older than the longest window are pruned as new ones
   come in. */

/**
 * @param {object} db
 * @param {{ windows: { name: string, limit: number, windowMs: number }[], now?: () => number }} opts
 */
function createAttemptThrottle(db, { windows, now = Date.now }) {
  if (!windows || !windows.length) throw new Error('The sign-in throttle needs at least one window.');
  const longest = Math.max(...windows.map((w) => w.windowMs));
  const countSince = db.prepare('SELECT COUNT(*) FROM portal_code_failures WHERE email_hash = ? AND at > ?').pluck();
  const insert = db.prepare('INSERT INTO portal_code_failures (email_hash, at) VALUES (?, ?)');
  const prune = db.prepare('DELETE FROM portal_code_failures WHERE at <= ?');
  const drop = db.prepare('DELETE FROM portal_code_failures WHERE email_hash = ?');
  const size = db.prepare('SELECT COUNT(*) FROM portal_code_failures').pluck();

  return {
    /** The name of the first window `key` has used up, or null while it may try. */
    limitedBy(key) {
      const t = now();
      const hit = windows.find((w) => countSince.get(key, t - w.windowMs) >= w.limit);
      return hit ? hit.name : null;
    },
    record(key) {
      const t = now();
      db.transaction(() => {
        prune.run(t - longest);
        insert.run(key, t);
      })();
    },
    clear(key) {
      drop.run(key);
    },
    /** How many wrong tries are held, for the tests. */
    size: () => size.get(),
  };
}

module.exports = { createAttemptThrottle };
