'use strict';

/**
 * A Final video's untouched master to Bunny Edge Storage (Bunny Slice 8), so the
 * client's download is the file itself, 4K included, not Stream's transcode.
 * bunny-publish.js starts it when a Final goes to Stream; a Draft Cut never sends
 * one (it is never downloadable, per the brief).
 *
 * One bunny_assets row (kind 'master', v33) per version, the file at
 *   /<projectId>/<itemId>/<versionId>/master-<tag>/<file>
 * The tag is random, as the photo originals' is (Slice 6): Bunny's links are public
 * until Slice 9 signs them, so the path can't be worked out from a review link.
 * A Republish (the NAS file replaced before the client had it) takes a new tag, so
 * the pull zone can't keep serving the old file under the old address. The old one
 * stays on Bunny until cleanup (Slice 11), as a replaced video does.
 *
 * Who gets the link: only C10's paid email (the user, 2026-11-27), beside the Drive
 * backup link. The portal's reply carries no download until F3/F5 builds one.
 *
 * A background job, like the photos': the publish answers at once. Masters are big
 * and the NAS's upload is one line, so one goes at a time, in the order asked. Its
 * progress counts the file read twice, once for its SHA-256 (Bunny checks every
 * byte against it) and once going up, so n/total moves through both. Edge Storage
 * has no resumable upload: a restart sends it again from the start (resume(), at
 * start-up), unless Bunny already holds the same bytes, which isn't sent twice. A
 * file saved over while it went up is sent again, once; changing again, it fails.
 * An upload whose bytes stop moving for STALL_MS is ended, not left hanging.
 */

const crypto = require('crypto');
const fs = require('fs');
const { basename } = require('path');
const { PassThrough } = require('stream');

/* No bytes moving for this long ends the upload (a dead line, not a slow one). */
const STALL_MS = 5 * 60 * 1000;
/* Once every byte is up, how long Bunny may take to check them and answer. */
const ANSWER_MS = 15 * 60 * 1000;
/* At most one progress write a second: a master is millions of chunks. */
const PROGRESS_EVERY_MS = 1000;
const TRIES_WHILE_CHANGING = 2;

const newTag = () => crypto.randomBytes(12).toString('hex');

/**
 * @param {object} db
 * @param {{ bunny: object, nas: object, now?: () => number, onReady?: (projectId: string) => void,
 *           stallMs?: number }} opts
 *   bunny  hub/bunny.js (putObject, listFolder, storageUrl); nas  hub/deliverables.js.
 *   onReady  a master just landed: the paid email (C10) may now carry its link.
 */
function createMasterPublisher(db, { bunny, nas, now = Date.now, onReady = () => {}, stallMs = STALL_MS }) {
  const isoNow = () => new Date(now()).toISOString();

  const getAsset = db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'master'");
  const startAsset = db.prepare(`
    INSERT INTO bunny_assets (version_id, kind, project_id, item_id, source_path, source_size, source_mtime,
                              storage_path, publish_tag, status, error, progress_done, progress_total, created_at, updated_at)
    VALUES (@version_id, 'master', @project_id, @item_id, @source_path, @size, @mtime,
            @storage_path, @tag, 'processing', NULL, 0, @total, @now, @now)
    ON CONFLICT(version_id, kind) DO UPDATE SET
      source_path = excluded.source_path, source_size = excluded.source_size, source_mtime = excluded.source_mtime,
      storage_path = excluded.storage_path, publish_tag = excluded.publish_tag, status = 'processing',
      error = NULL, progress_done = 0, progress_total = excluded.progress_total, updated_at = excluded.updated_at
  `);
  const setProgress = db.prepare("UPDATE bunny_assets SET progress_done = ?, progress_total = ?, updated_at = ? WHERE version_id = ? AND kind = 'master'");
  const finishAsset = db.prepare(`
    UPDATE bunny_assets SET status = ?, error = ?, source_size = COALESCE(?, source_size), source_mtime = COALESCE(?, source_mtime),
           progress_done = ?, progress_total = ?, updated_at = ?
     WHERE version_id = ? AND kind = 'master'
  `);
  const processingAssets = db.prepare("SELECT version_id FROM bunny_assets WHERE kind = 'master' AND status = 'processing' ORDER BY updated_at").pluck();
  const getVersion = db.prepare('SELECT * FROM deliverable_versions WHERE id = ?');

  const jobs = new Map(); // versionId → its job, queued or running
  let tail = Promise.resolve();

  /* Whether a version sends a master: a Final's video with a NAS file. */
  const wants = (version) => Boolean(version && version.kind === 'video' && version.stage === 'final' && version.source_path);

  const fileName = (row) => basename(row.source_path);
  const pathOf = (row) => `${row.storage_path}/master-${row.publish_tag}/${fileName(row)}`;

  function view(versionId) {
    const row = getAsset.get(versionId);
    if (!row) return { status: 'none', error: null, progress: { done: 0, total: 0 } };
    return { status: row.status, error: row.error || null, progress: { done: row.progress_done, total: row.progress_total } };
  }

  /* Reads the file through, counting each chunk into `tick`. */
  function hashFile(path, tick) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(path).on('error', reject)
        .on('data', (c) => { hash.update(c); tick(c.length); })
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  /* One PUT of the file, ended if its bytes stop moving or Bunny never answers. */
  async function upload(row, absolute, size, checksum, tick) {
    const controller = new AbortController();
    let why = null;
    let last = Date.now();
    const stop = (reason) => {
      why = reason;
      controller.abort();
    };
    const watch = setInterval(() => {
      if (Date.now() - last > stallMs) stop(`The upload stopped moving for ${Math.round(stallMs / 60000)} minutes.`);
    }, Math.min(stallMs, 30000));
    if (watch.unref) watch.unref();
    let answerTimer = null;
    const counter = new PassThrough();
    counter.on('data', (c) => {
      last = Date.now();
      tick(c.length);
    });
    counter.on('end', () => {
      clearInterval(watch);
      answerTimer = setTimeout(() => stop('Bunny took too long to confirm the upload.'), ANSWER_MS);
      if (answerTimer.unref) answerTimer.unref();
    });
    const source = fs.createReadStream(absolute);
    source.on('error', (err) => counter.destroy(err));
    source.pipe(counter);
    try {
      await bunny.putObject(pathOf(row), counter, { length: size, checksum, signal: controller.signal });
    } catch (err) {
      throw why ? new Error(why) : err;
    } finally {
      clearInterval(watch);
      clearTimeout(answerTimer);
      source.destroy();
    }
  }

  async function runJob(versionId) {
    const row = getAsset.get(versionId);
    if (!row || row.status !== 'processing') return;
    const fail = (error) => {
      const at = getAsset.get(versionId);
      finishAsset.run('failed', String(error).slice(0, 500), null, null, 0, at ? at.progress_total : 0, isoNow(), versionId);
    };
    if (!getVersion.get(versionId)) return fail('This version no longer exists.');

    // What Bunny holds already: a master a restart cut off after it landed isn't sent twice.
    let held = null;
    try {
      held = (await bunny.listFolder(`${row.storage_path}/master-${row.publish_tag}`)).find((f) => f.name === fileName(row)) || null;
    } catch (err) {
      console.warn('[bunny-masters] couldn’t list what Bunny holds, so the master goes up:', err.message);
    }

    for (let attempt = 1; ; attempt += 1) {
      const found = nas.resolveDeliverablePath(row.source_path);
      if (!found) return fail('The file isn’t on the NAS any more.');
      const before = found.stat;
      const size = before.size;
      const unchanged = () => {
        const now2 = nas.resolveDeliverablePath(row.source_path);
        return Boolean(now2) && now2.stat.size === size && Math.round(now2.stat.mtimeMs) === Math.round(before.mtimeMs);
      };
      const total = size * 2;
      let done = 0;
      let wrote = 0;
      const tick = (n) => {
        done = Math.min(total, done + n);
        if (Date.now() - wrote >= PROGRESS_EVERY_MS) {
          wrote = Date.now();
          setProgress.run(done, total, isoNow(), versionId);
        }
      };
      setProgress.run(0, total, isoNow(), versionId);
      let failure = null;
      try {
        const checksum = await hashFile(found.absolute, tick);
        const same = held && held.length === size && String(held.checksum || '').toLowerCase() === checksum;
        if (!same) await upload(row, found.absolute, size, checksum, tick);
      } catch (err) {
        failure = err;
      }
      if (unchanged()) {
        if (failure) return fail(failure.message || failure);
        finishAsset.run('ready', null, size, Math.round(before.mtimeMs), total, total, isoNow(), versionId);
        try {
          onReady(row.project_id);
        } catch (err) {
          console.error('[bunny-masters] after a master landed:', err.message);
        }
        return undefined;
      }
      // Saved over while it went up: what Bunny has (if anything) is the old file.
      if (attempt >= TRIES_WHILE_CHANGING) return fail('It kept changing on the NAS while it was being sent.');
      held = null;
    }
  }

  function start(versionId) {
    if (jobs.has(versionId)) return jobs.get(versionId);
    const job = tail
      .then(() => runJob(versionId))
      .catch((err) => {
        console.error('[bunny-masters] a master job stopped:', err.message);
        const row = getAsset.get(versionId);
        if (row) finishAsset.run('failed', `The master job stopped: ${err.message}`, null, null, 0, row.progress_total, isoNow(), versionId);
      })
      .finally(() => jobs.delete(versionId));
    tail = job;
    jobs.set(versionId, job);
    return job;
  }

  /**
   * Sends the version's master if it should go and hasn't: nothing for a Draft Cut
   * or a photo library, nothing while one is queued or going, nothing for one Bunny
   * has unless `force` (a Republish: the NAS file was replaced), and a failed one
   * again. `stat` is the file as the publish checked it. Answers the master's view.
   */
  function publish(project, version, stat, { force = false } = {}) {
    if (!wants(version)) return view(version.id);
    if (jobs.has(version.id)) return view(version.id);
    const existing = getAsset.get(version.id);
    if (existing && existing.status === 'processing') {
      start(version.id); // a row left processing with no job (a restart not yet resumed)
      return view(version.id);
    }
    if (existing && existing.status === 'ready' && !force) return view(version.id);
    startAsset.run({
      version_id: version.id,
      project_id: project.id,
      item_id: version.deliverable_id,
      source_path: version.source_path,
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      storage_path: `${project.id}/${version.deliverable_id}/${version.id}`,
      // A retry after a failure keeps its folder, so a master that did land isn't sent twice.
      tag: existing && existing.publish_tag && !force ? existing.publish_tag : newTag(),
      total: stat.size * 2,
      now: isoNow(),
    });
    start(version.id);
    return view(version.id);
  }

  /** Every master a restart interrupted goes again, in the order they were asked. */
  function resume() {
    for (const versionId of processingAssets.all()) start(versionId);
    return idle();
  }

  /**
   * A ready master's CDN address, signed (Slice 9) for `ttlSeconds`, or null. Only
   * the download route hands it out, as a redirect: the paid email carries that
   * route's link, never this one. Built when it is needed, never stored.
   */
  function linkOf(versionId, { ttlSeconds } = {}) {
    const row = getAsset.get(versionId);
    return row && row.status === 'ready' ? bunny.storageUrl(pathOf(row), ttlSeconds ? { ttlSeconds } : undefined) : null;
  }

  /* A ready master as the paid email names it: which upload it is (its folder's
     tag, so a Republish is a new file) and the file's name, or null. */
  function readyOf(versionId) {
    const row = getAsset.get(versionId);
    return row && row.status === 'ready' ? { tag: row.publish_tag, name: fileName(row) } : null;
  }

  const idle = () => Promise.all([...jobs.values()]).then(() => undefined);

  return { wants, publish, view, resume, linkOf, readyOf, idle };
}

module.exports = { createMasterPublisher, STALL_MS };
