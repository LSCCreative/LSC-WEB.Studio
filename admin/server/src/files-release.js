'use strict';

/**
 * The client's files, emailed once the job is paid (merged-admin C10; the user's
 * rule of 2026-11-26: "when the final invoice has been paid, the Drive backup
 * links are emailed to the client automatically, with a notice to me").
 *
 * WHEN. Both of these, whichever comes last:
 *   - the job is paid: every live invoice paid (void ones don't count), and one
 *     of them bills the end of the job (a final, a single or a legacy invoice), so
 *     a paid deposit alone never sends;
 *   - every needed item is approved (the client's approval or a deemed one,
 *     delivery.js itemApproved), and there is at least one.
 * It is looked at only when something that can complete it happens: Mark paid,
 * the client's approval in the portal, and the studio's checklist writes (Mark
 * approved, Not needed, a new Drive link). Nothing sweeps old projects, and v32
 * recorded every job already paid and approved as `baseline` (the client has
 * those files), so a job finished before this existed never sends on its own. A
 * later "paid" from Hnry (F6) calls check() too. An item the old hub delivered
 * (R4's hub_status 'delivered') is the client's already: it is never in the email.
 *
 * WHAT. Each approved Final with its Drive backup link, and its master on Bunny
 * when one landed there (Bunny Slice 8: the user's call of 2026-11-27, this email is
 * the only place that link goes until F3/F5); an item with neither is named and the
 * studio's copy flags it. A master that lands after the email went sends an update.
 * The master's link is hub-api's download route (Slice 9), signed for 90 days when
 * the email is built, so the set key names the upload (`masterKey`), not the link.
 *
 * ONCE. files_releases (v32) keeps one row per project: the set it last tried
 * (`set_key`: each item's approved version and its links). The same set never goes
 * twice, so marking paid again or a second approval changes nothing; a new set (a
 * newer Final approved, or a link added or changed) sends an update. A failed send
 * is tried again by the hourly pass, up to MAX_ATTEMPTS, then the studio is told.
 * A client with no email is recorded as no_email: the studio is told once, and the
 * hourly pass sends as soon as an address is added.
 */

const crypto = require('crypto');
const { nowIso, newId } = require('./db');
const { readSettings } = require('./ratecard');
const { isEmail, filesReadyEmail, filesSentOwnerEmail, filesNotSentOwnerEmail } = require('./mail');
const { readChecklist, itemApproved } = require('./delivery');
const { projectNameOf } = require('./portal-invite');
const { sydneyDay } = require('./deemed');

const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/* How long Mark paid waits for the files email before answering "still sending":
   well inside Cloudflare's 100 s, since the mailer may take a minute to give up. */
const WAIT_MS = 20000;
/* The invoices that bill the end of a job (delivery.js CLOSING_KINDS). */
const CLOSING_KINDS = ['final', 'single', 'legacy'];

function logActivity(db, projectId, kind, detail, at) {
  db.prepare('INSERT INTO activity (id, project_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(newId('act'), projectId, at, kind, JSON.stringify(detail));
}

const errorText = (err) => String((err && err.message) || err || 'error').slice(0, 300);

/**
 * The set an email carries, as one key: each file's item, version and link, in
 * checklist order. v32's baseline computes the same key from the same rows
 * (test-files-release.js checks the two agree).
 * @param {Array<[itemId:string, versionId:string|null, driveLink:string]>} files
 */
function setKeyOf(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 32);
}

const hasLink = (f) => /^https?:\/\//i.test(f.driveLink);
const hasAnyLink = (f) => hasLink(f) || Boolean(f.masterLink);
/* A file's part of the set key. The master's link joins only when there is one, so
   every set recorded before masters existed (v32's baselines, emails sent) keeps the
   key it had and never sends again on its own. */
const keyPart = (f) => (f.masterKey ? [f.itemId, f.versionId, f.driveLink, f.masterKey] : [f.itemId, f.versionId, f.driveLink]);

/**
 * Where a project stands for its files. Pure reads.
 *
 * @returns {null | {
 *   paid: boolean,          every live invoice paid, one of them closing the job
 *   hasClosing: boolean,    a live final, single or legacy invoice exists
 *   unpaid: string[],       the live invoices not yet paid (ids)
 *   approved: boolean,      every needed item approved, and at least one
 *   needed: number,         items not marked Not needed
 *   open: number,           needed items not approved yet
 *   files: Array<{ itemId, title, versionId, versionN, driveLink, masterLink, masterKey }>,
 *                           the approved items, less what the old hub delivered;
 *                           masterLink is the download link for the Final's master on
 *                           Bunny and masterKey which upload it is, or both null
 *   setKey: string,
 *   client: object|null,
 *   email: string,          the client's address, '' when it isn't one
 *   badEmail: string,       what the client has instead, when it isn't an address
 *   record: object|null }}  the files_releases row
 */
function releasePlan(db, projectId, { master = () => null } = {}) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return null;
  const live = db.prepare("SELECT id, kind, status FROM invoices WHERE project_id = ? AND status != 'void'").all(projectId);
  const unpaid = live.filter((i) => i.status !== 'paid').map((i) => i.id);
  const hasClosing = live.some((i) => CLOSING_KINDS.includes(i.kind));
  const needed = readChecklist(db, projectId).filter((d) => !d.notNeededAt);
  const done = needed.filter(itemApproved);
  // What the old hub delivered the client has already: never sent again.
  const files = done.filter((d) => d.hubStatus !== 'delivered').map((d) => {
    const v = d.versions[d.versions.length - 1] || null;
    const m = v ? master(v.id) : null;
    return {
      itemId: d.id,
      title: d.title || '',
      versionId: v ? v.id : null,
      versionN: v ? v.n : null,
      driveLink: v ? String(v.driveLink || '').trim() : '',
      masterLink: m ? m.url : null,
      masterKey: m ? m.key : null,
    };
  });
  const setKey = setKeyOf(files.map(keyPart));
  const client = p.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id) : null;
  const raw = client ? String(client.email || '').trim() : '';
  const email = isEmail(raw) ? raw : '';
  return {
    project: p,
    paid: live.length > 0 && unpaid.length === 0 && hasClosing,
    hasClosing,
    unpaid,
    approved: needed.length > 0 && done.length === needed.length,
    needed: needed.length,
    open: needed.length - done.length,
    files,
    setKey,
    client,
    email,
    // An address on the client that isn't one, so the studio is told to fix it, not to add one.
    badEmail: raw && !email ? raw : '',
    record: db.prepare('SELECT * FROM files_releases WHERE project_id = ?').get(projectId) || null,
  };
}

/**
 * What the studio's screens say (the invoice's Mark paid, the folder): the facts
 * that decide whether marking the last invoice paid sends the files.
 */
function releaseView(db, projectId, mailer, { master } = {}) {
  const plan = releasePlan(db, projectId, { master });
  if (!plan) return null;
  const r = plan.record;
  const current = Boolean(r && r.set_key === plan.setKey);
  return {
    hasClosing: plan.hasClosing,
    unpaid: plan.unpaid,
    approved: plan.approved,
    needed: plan.needed,
    open: plan.open,
    // Every approved item was delivered by the old hub: nothing to send.
    nothingNew: plan.approved && plan.files.length === 0,
    noLink: plan.files.filter((f) => !hasAnyLink(f)).map((f) => f.title),
    email: plan.email,
    badEmail: plan.badEmail,
    mail: Boolean(mailer && mailer.configured),
    // The files as they stand are the client's already (a new set would send again):
    // emailed (`sentOn`, the Sydney day), or the job was done before C10 (`baseline`).
    delivered: current && (r.status === 'sent' || r.status === 'baseline'),
    baseline: current && r.status === 'baseline',
    sentOn: current && r.status === 'sent' ? sydneyDay(r.sent_at) : null,
    last: r ? { status: r.status, to: r.to_email, sentAt: r.sent_at, attempts: r.attempts, error: r.error, current } : null,
  };
}

/**
 * @param {object} env  { mailer, appUrl, tickMs?, master? (versionId → { key, url } of a ready master, or null) }
 */
function createFilesRelease(db, env) {
  let timer = null;
  /* One check per project at a time; a check asked for meanwhile runs after it,
     so a payment and an approval in the same moment send once. */
  const busy = new Map();

  const upsert = db.prepare(`
    INSERT INTO files_releases (project_id, set_key, status, to_email, attempts, error, owner_told, sent_at, updated_at)
    VALUES (@project_id, @set_key, @status, @to_email, @attempts, @error, @owner_told, @sent_at, @updated_at)
    ON CONFLICT(project_id) DO UPDATE SET
      set_key = excluded.set_key, status = excluded.status, to_email = excluded.to_email,
      attempts = excluded.attempts, error = excluded.error, owner_told = excluded.owner_told,
      sent_at = excluded.sent_at, updated_at = excluded.updated_at
  `);

  const owner = () => (env.mailer && env.mailer.configured ? env.mailer.replyTo || '' : '');
  const projectLink = (projectId) => (env.appUrl ? `${env.appUrl}#/projects/${projectId}` : '');

  /* The studio's email: best effort, never fails the client's. */
  async function tellOwner(mail) {
    const to = owner();
    if (!to) return false;
    try {
      await env.mailer.send({ to, ...mail });
      return true;
    } catch (err) {
      console.error(`[mail] files notice to the studio failed: ${err && err.code ? err.code : 'error'}`);
      return false;
    }
  }

  /**
   * Sends the files if they are due and haven't gone.
   * @returns {Promise<{ sent:boolean, reason?:string, to?:string, update?:boolean, error?:string }>}
   */
  async function attempt(projectId) {
    if (!env.mailer || !env.mailer.configured) return { sent: false, reason: 'no_mail' };
    const plan = releasePlan(db, projectId, { master: env.master });
    if (!plan) return { sent: false, reason: 'no_project' };
    if (!plan.paid) return { sent: false, reason: 'not_paid' };
    if (!plan.approved) return { sent: false, reason: 'not_approved' };
    if (!plan.files.length) return { sent: false, reason: 'nothing_new' };
    const rec = plan.record;
    const same = Boolean(rec && rec.set_key === plan.setKey);
    if (same && (rec.status === 'sent' || rec.status === 'baseline')) return { sent: false, reason: 'already' };
    const business = readSettings(db).business || {};
    const projectName = projectNameOf(db, projectId);
    const upid = plan.project.upid || '';
    const clientName = (plan.client && (plan.client.business_name || plan.client.contact_name)) || '';
    const at = nowIso();
    if (same && rec.status === 'gave_up') {
      // The studio's notice that it gave up is the one thing left to deliver.
      if (rec.owner_told !== 1 && await tellOwner(filesNotSentOwnerEmail({
        business, appUrl: env.appUrl, reason: 'gave_up', to: rec.to_email, error: rec.error, attempts: rec.attempts,
        projectName, upid, link: projectLink(projectId),
      }))) {
        db.prepare('UPDATE files_releases SET owner_told = 1, updated_at = ? WHERE project_id = ?').run(at, projectId);
      }
      return { sent: false, reason: 'gave_up' };
    }
    // An update when an earlier set reached the client (a baseline's too: they had it).
    const update = Boolean(rec && rec.sent_at);
    const base = { project_id: projectId, set_key: plan.setKey, sent_at: rec ? rec.sent_at : null, updated_at: at };

    if (!plan.email) {
      // The studio hears once per set; a notice that didn't reach them is tried again.
      if (same && rec.status === 'no_email' && rec.owner_told === 1) return { sent: false, reason: 'no_email' };
      const ok = await tellOwner(filesNotSentOwnerEmail({
        business, appUrl: env.appUrl, reason: 'no_email', clientName, badEmail: plan.badEmail, projectName, upid,
        link: projectLink(projectId),
      }));
      upsert.run({ ...base, status: 'no_email', to_email: '', attempts: 0, error: '', owner_told: ok ? 1 : 0 });
      if (!same || rec.status !== 'no_email') {
        logActivity(db, projectId, 'files_not_sent', { reason: 'no_email', badEmail: plan.badEmail }, at);
      }
      return { sent: false, reason: 'no_email', badEmail: plan.badEmail };
    }

    const attempts = (same && rec.status === 'failed' ? rec.attempts : 0) + 1;
    const mail = filesReadyEmail({
      business, appUrl: env.appUrl, contactName: plan.client.contact_name, projectName, upid, files: plan.files, update,
    });
    try {
      await env.mailer.send({ to: plan.email, ...mail });
    } catch (err) {
      const error = errorText(err);
      const gaveUp = attempts >= MAX_ATTEMPTS;
      const told = gaveUp && await tellOwner(filesNotSentOwnerEmail({
        business, appUrl: env.appUrl, reason: 'gave_up', to: plan.email, error, attempts, projectName, upid,
        link: projectLink(projectId),
      }));
      upsert.run({ ...base, status: gaveUp ? 'gave_up' : 'failed', to_email: plan.email, attempts, error, owner_told: told ? 1 : 0 });
      logActivity(db, projectId, 'files_failed', { to: plan.email, error, attempts, gaveUp }, at);
      console.error(`[mail] files email for project ${projectId} failed: ${err && err.code ? err.code : 'error'}`);
      return { sent: false, reason: gaveUp ? 'gave_up' : 'failed', to: plan.email, error };
    }
    const missing = plan.files.filter((f) => !hasAnyLink(f)).map((f) => f.title);
    upsert.run({ ...base, status: 'sent', to_email: plan.email, attempts, error: '', owner_told: 0, sent_at: at });
    logActivity(db, projectId, 'files_sent', { to: plan.email, count: plan.files.length, missing, update }, at);
    // The studio's copy in the background: the client's email is what the caller waits on.
    tellOwner(filesSentOwnerEmail({
      business, appUrl: env.appUrl, clientName, to: plan.email, projectName, upid, files: plan.files, update,
      link: projectLink(projectId),
    }));
    return { sent: true, to: plan.email, update };
  }

  /**
   * Looks at one project now. Never rejects.
   * @returns {Promise<object>} attempt()'s answer
   */
  function check(projectId) {
    const running = busy.get(projectId);
    if (running) {
      // Run once more after the one under way: whatever changed meanwhile is seen.
      if (!running.again) running.again = running.done.then(() => check(projectId));
      return running.again;
    }
    const entry = {};
    entry.done = attempt(projectId)
      .catch((err) => {
        console.error(`[mail] files check for project ${projectId} failed: ${errorText(err)}`);
        return { sent: false, reason: 'error' };
      })
      .finally(() => {
        if (busy.get(projectId) === entry) busy.delete(projectId);
      });
    busy.set(projectId, entry);
    return entry.done;
  }

  /**
   * check(), but answering `{ reason: 'sending' }` if it takes longer than `ms`
   * (Mark paid: a slow mail server mustn't make a saved payment look failed). The
   * send carries on, and its outcome lands in the project's Activity.
   */
  function checkWithin(projectId, ms = env.waitMs || WAIT_MS) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ sent: false, reason: 'sending' }), ms);
      timer.unref();
    });
    return Promise.race([check(projectId), late]).finally(() => clearTimeout(timer));
  }

  /** The hourly pass: retries a failed send, sends once a client's email is fixed, and
      retries the studio's give-up notice if that didn't reach them. */
  async function runDue() {
    const rows = db.prepare(`
      SELECT project_id FROM files_releases
       WHERE status IN ('failed', 'no_email') OR (status = 'gave_up' AND owner_told = 0)
    `).all();
    const out = { sent: 0, failed: 0 };
    for (const r of rows) {
      const res = await check(r.project_id);
      if (res.sent) out.sent += 1;
      else if (res.reason === 'failed' || res.reason === 'gave_up') out.failed += 1;
    }
    return out;
  }

  function kick() {
    runDue().catch((err) => console.error('[mail] files pass failed:', errorText(err)));
  }

  return {
    check,
    checkWithin,
    runDue,
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

module.exports = { createFilesRelease, releasePlan, releaseView, setKeyOf, MAX_ATTEMPTS };
