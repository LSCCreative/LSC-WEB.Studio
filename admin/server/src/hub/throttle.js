'use strict';

/* A sliding-window count of attempts per key, for the portal's sign-ins: the
   editor's PIN (by address) and a client's code (by email). In memory: one
   process, and a restart forgetting the counts is harmless. Keys that have
   stopped trying are swept out, since this lives as long as the admin does. */

const SWEEP_AT = 500;

function createAttemptThrottle({ limit, windowMs, now = Date.now }) {
  const attempts = new Map();

  function recent(key, t) {
    const times = (attempts.get(key) || []).filter((at) => t - at < windowMs);
    if (times.length) attempts.set(key, times);
    else attempts.delete(key);
    return times;
  }

  return {
    /** True once `key` has used up its attempts in the window. */
    isLimited(key) {
      return recent(key, now()).length >= limit;
    },
    record(key) {
      const t = now();
      if (attempts.size >= SWEEP_AT) {
        for (const [k, times] of attempts) {
          if (t - times[times.length - 1] >= windowMs) attempts.delete(k);
        }
      }
      const times = attempts.get(key) || [];
      times.push(t);
      attempts.set(key, times);
    },
    clear(key) {
      attempts.delete(key);
    },
    /** How many keys are held, for the tests. */
    size: () => attempts.size,
  };
}

module.exports = { createAttemptThrottle };
