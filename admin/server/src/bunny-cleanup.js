'use strict';

/**
 * Taking files off Bunny (Bunny Slice 11): the daily cleanup, and Take offline.
 * bunny-publish.js builds this with its own Bunny client and hands both out.
 *
 * ── The daily cleanup only removes what no client reply refers to any more.
 * A version's files on Bunny (its Stream video, its photos or master in Edge
 * Storage under /<projectId>/<itemId>/<versionId>/) are removed when:
 *   - its project, deliverable or version no longer exists, or
 *   - it was replaced more than BUNNY_RETENTION_DAYS (90) ago: the client was given
 *     a newer version then (its published_at), or, for one the client never had, a
 *     newer one was added then.
 * Never removed: the item's newest version, its newest published one (what the
 * client sees, archived projects under Past projects included), and an approved
 * version while no newer one has gone to the client (the approval stands, S12).
 * Also removed, once they're older than the window: what nothing records any more,
 * so nothing can hand it out. A Republish's old Stream video (a force publish
 * moves the row to the new one) and a Republish's old master folder, and photos
 * taken out of a library that was sent again.
 * A row whose files are gone stays, as `expired` with removed_at. The NAS is never
 * touched: it's the master archive, and the deliverables mount is read-only anyway.
 *
 * Modes (BUNNY_CLEANUP): 'dry' (the default) logs what it would remove and removes
 * nothing, which is what the first deploy runs, so the log can be read first; 'on'
 * removes; 'off' doesn't run. Once a day, the first run 15 minutes after start.
 *
 * ── Take offline (the user, 2026-11-07) removes an archived project's files from
 * Bunny on purpose, to save cost: every Stream video in its collection and the
 * collection, and everything under /<projectId>/ in Edge Storage. Its rows become
 * `offline` (kept), and projects.files_offline_at makes the portal show the files
 * as offline wherever they'd be. Bring back online is bunny-publish.js's: it sends
 * the current versions again from the NAS.
 */

const { sizedName } = require('./bunny-photos');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const FIRST_RUN_MS = 15 * 60 * 1000;
/* A video row's tag can still be adopted for this long after it failed (bunny-publish's
   source link): a failed row with no video id is looked up by its tag before removal. */
const LATE_ADOPT_MS = 6 * 60 * 60 * 1000;
/* Rows whose files are on Bunny (or may be, part-sent). Processing ones are left:
   their job is still writing. */
const ON_BUNNY = "('ready', 'failed')";

const versionFolder = (row) => row.storage_path || `${row.project_id}/${row.item_id}/${row.version_id}`;

/**
 * @param {object} db
 * @param {object} opts
 *   bunny          hub/bunny.js's client
 *   now            ms clock
 *   retentionDays  BUNNY_RETENTION_DAYS (90)
 *   mode           'dry' | 'on' | 'off'
 *   busy(versionId) true while a publish of that version is running: left alone
 *   projectBusy(projectId) true while a publish of any of the project's versions is
 *                  running (bunny-publish.js also keeps Take offline and Bring back
 *                  online apart)
 *   log            { info, error } (console)
 */
function createBunnyCleanup(db, {
  bunny, now = Date.now, retentionDays = DEFAULT_RETENTION_DAYS, mode = 'dry', busy = () => false,
  projectBusy = () => false, log = console,
} = {}) {
  const days = Number(retentionDays) > 0 ? Number(retentionDays) : DEFAULT_RETENTION_DAYS;
  const windowMs = days * DAY_MS;
  const isoNow = () => new Date(now()).toISOString();

  const liveRows = db.prepare(`
    SELECT b.*, v.id AS v_id, v.n AS v_n, d.id AS d_id, d.title AS d_title, p.id AS p_id, p.files_offline_at AS p_offline
      FROM bunny_assets b
      LEFT JOIN deliverable_versions v ON v.id = b.version_id
      LEFT JOIN deliverables d ON d.id = v.deliverable_id AND d.project_id = b.project_id
      LEFT JOIN projects p ON p.id = b.project_id
     WHERE b.status IN ${ON_BUNNY}
     ORDER BY b.project_id, b.item_id, b.version_id, b.kind
  `);
  const versionsOfItem = db.prepare('SELECT id, n, published_at, created_at FROM deliverable_versions WHERE deliverable_id = ? ORDER BY n');
  const approvedIn = db.prepare('SELECT version_id FROM client_approvals WHERE deliverable_id = ?').pluck();
  const projectRows = db.prepare(`SELECT * FROM bunny_assets WHERE project_id = ? AND status IN ${ON_BUNNY}`);
  const processingIn = db.prepare("SELECT COUNT(*) FROM bunny_assets WHERE project_id = ? AND status = 'processing'").pluck();
  const markRemoved = db.prepare(`
    UPDATE bunny_assets SET status = ?, removed_at = ?, error = NULL, progress_done = 0, updated_at = ?
     WHERE version_id = ? AND status IN ${ON_BUNNY}
  `);
  const markProjectRemoved = db.prepare(`
    UPDATE bunny_assets SET status = ?, removed_at = ?, error = NULL, progress_done = 0, updated_at = ?
     WHERE project_id = ? AND status IN ${ON_BUNNY}
  `);
  const dropPhotoFiles = db.prepare('DELETE FROM bunny_photo_files WHERE version_id = ?');
  const dropProjectPhotoFiles = db.prepare('DELETE FROM bunny_photo_files WHERE version_id IN (SELECT version_id FROM bunny_assets WHERE project_id = ?)');
  const collectionOf = db.prepare('SELECT * FROM bunny_collections WHERE project_id = ?');
  const dropCollection = db.prepare('DELETE FROM bunny_collections WHERE project_id = ?');
  const goneCollections = db.prepare('SELECT * FROM bunny_collections c WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id)');
  const keptCollections = db.prepare(`
    SELECT c.* FROM bunny_collections c JOIN projects p ON p.id = c.project_id WHERE p.files_offline_at IS NULL
  `);
  const videoRefs = db.prepare(`
    SELECT bunny_video_id, publish_tag FROM bunny_assets
     WHERE project_id = ? AND kind = 'video' AND status IN ('processing', 'ready', 'failed')
  `);
  const keptStorageRows = db.prepare(`
    SELECT b.* FROM bunny_assets b JOIN projects p ON p.id = b.project_id
     WHERE p.files_offline_at IS NULL
       AND ((b.kind = 'master' AND b.status IN ${ON_BUNNY}) OR (b.kind = 'photos' AND b.status = 'ready'))
  `);
  const doneFiles = db.prepare("SELECT file_name FROM bunny_photo_files WHERE version_id = ? AND status = 'done'").pluck();

  const older = (at) => {
    const t = Date.parse(at || '');
    return Number.isFinite(t) && now() - t > windowMs;
  };

  /* Why one version should stay on Bunny, or its removal: { reason, replacedAt }. */
  function judge(first) {
    if (!first.p_id) return { reason: 'its project was deleted' };
    if (!first.v_id || !first.d_id) return { reason: 'its deliverable or version was deleted' };
    if (first.p_offline) return null; // Take offline's, not cleanup's
    const versions = versionsOfItem.all(first.d_id);
    const at = versions.findIndex((v) => v.id === first.version_id);
    const me = versions[at];
    const newest = versions[versions.length - 1];
    const shown = [...versions].reverse().find((v) => v.published_at);
    if (me.id === newest.id || (shown && me.id === shown.id)) return null;
    const later = versions.slice(at + 1);
    const laterShown = later.find((v) => v.published_at);
    // An approval stands until the client is given something newer (S12).
    if (approvedIn.all(first.d_id).includes(me.id) && !laterShown) return null;
    const replacedAt = me.published_at ? laterShown && laterShown.published_at : later[0] && later[0].created_at;
    if (!replacedAt || !older(replacedAt)) return null;
    return { reason: `replaced by v${(me.published_at ? laterShown : later[0]).n} on ${replacedAt.slice(0, 10)}`, replacedAt };
  }

  /* The versions to take off Bunny now: [{ versionId, projectId, label, reason, rows }]. */
  function dueVersions() {
    const byVersion = new Map();
    for (const row of liveRows.all()) {
      if (!byVersion.has(row.version_id)) byVersion.set(row.version_id, []);
      byVersion.get(row.version_id).push(row);
    }
    const due = [];
    for (const [versionId, rows] of byVersion) {
      if (busy(versionId)) continue;
      const verdict = judge(rows[0]);
      if (!verdict) continue;
      const first = rows[0];
      const label = first.d_title ? `“${first.d_title}” v${first.v_n}` : `version ${versionId}`;
      due.push({ versionId, projectId: first.project_id, label, reason: verdict.reason, rows });
    }
    return due;
  }

  /* A failed video row with no id may still have a video Bunny listed late. */
  async function videoIdsOf(row) {
    if (row.kind !== 'video') return [];
    if (row.bunny_video_id) return [row.bunny_video_id];
    if (!row.publish_tag || !row.collection_id) return [];
    if (now() - Date.parse(row.updated_at) < LATE_ADOPT_MS) return [];
    const found = await bunny.findVideoByTag(row.publish_tag, row.collection_id, { includeFailed: true });
    return found ? [found.guid] : [];
  }

  /* Takes one version's files off Bunny and marks its rows `status`. */
  async function removeVersion(unit, status) {
    for (const row of unit.rows) {
      for (const id of await videoIdsOf(row)) await bunny.deleteVideo(id);
    }
    const stored = unit.rows.find((r) => r.kind === 'photos' || r.kind === 'master');
    if (stored) await bunny.deleteObject(versionFolder(stored), { folder: true });
    const at = isoNow();
    db.transaction(() => {
      markRemoved.run(status, at, at, unit.versionId);
      dropPhotoFiles.run(unit.versionId);
    })();
  }

  /* What nothing records any more, older than the window (see the top). Each is
     { what, remove() }. A listing that fails is logged and skipped. */
  async function strays() {
    const found = [];
    for (const c of goneCollections.all()) {
      found.push({
        what: `everything of deleted project ${c.project_id} (collection ${c.collection_id})`,
        remove: async () => {
          for (const v of await bunny.listCollectionVideos(c.collection_id)) await bunny.deleteVideo(v.guid);
          await bunny.deleteCollection(c.collection_id);
          await bunny.deleteObject(c.project_id, { folder: true });
          const at = isoNow();
          db.transaction(() => {
            dropProjectPhotoFiles.run(c.project_id);
            markProjectRemoved.run('expired', at, at, c.project_id);
            dropCollection.run(c.project_id);
          })();
        },
      });
    }
    for (const c of keptCollections.all()) {
      try {
        const refs = videoRefs.all(c.project_id);
        const ids = new Set(refs.map((r) => r.bunny_video_id).filter(Boolean));
        const tags = refs.map((r) => r.publish_tag).filter(Boolean);
        for (const v of await bunny.listCollectionVideos(c.collection_id)) {
          if (ids.has(v.guid) || tags.some((t) => v.title.includes(t)) || !older(v.dateUploaded)) continue;
          found.push({ what: `stray video “${v.title}” (${v.guid}) of project ${c.project_id}`, remove: () => bunny.deleteVideo(v.guid) });
        }
      } catch (err) {
        log.error(`[bunny-cleanup] couldn’t list collection ${c.collection_id}:`, err.message);
      }
    }
    for (const row of keptStorageRows.all()) {
      const base = versionFolder(row);
      try {
        if (row.kind === 'master') {
          for (const e of await bunny.listEntries(base)) {
            if (!e.isDirectory || !e.name.startsWith('master-') || e.name === `master-${row.publish_tag}` || !older(e.changedAt)) continue;
            found.push({ what: `old master ${base}/${e.name}`, remove: () => bunny.deleteObject(`${base}/${e.name}`, { folder: true }) });
          }
        } else {
          const names = doneFiles.all(row.version_id);
          const wanted = {
            [`original-${row.publish_tag}`]: new Set(names),
            600: new Set(names.map(sizedName)),
            2400: new Set(names.map(sizedName)),
          };
          for (const [folder, keep] of Object.entries(wanted)) {
            for (const e of await bunny.listEntries(`${base}/${folder}`)) {
              if (e.isDirectory || keep.has(e.name) || !older(e.changedAt)) continue;
              found.push({ what: `photo taken out ${base}/${folder}/${e.name}`, remove: () => bunny.deleteObject(`${base}/${folder}/${e.name}`) });
            }
          }
        }
      } catch (err) {
        log.error(`[bunny-cleanup] couldn’t list ${base}:`, err.message);
      }
    }
    return found;
  }

  let running = null;

  /**
   * One cleanup pass. `dryRun` (the default unless mode is 'on') removes nothing and
   * logs what it would. Answers { dryRun, versions: [{ versionId, label, reason, removed, error }],
   * strays: [{ what, removed, error }] }. One at a time: a second call joins the first.
   */
  function run({ dryRun = mode !== 'on' } = {}) {
    if (running) return running;
    running = (async () => {
      const result = { dryRun, versions: [], strays: [] };
      const verb = dryRun ? 'would remove' : 'removed';
      for (const unit of dueVersions()) {
        const entry = { versionId: unit.versionId, projectId: unit.projectId, label: unit.label, reason: unit.reason, removed: false, error: null };
        try {
          if (!dryRun) await removeVersion(unit, 'expired');
          entry.removed = !dryRun;
          log.info(`[bunny-cleanup] ${verb} ${unit.label} of project ${unit.projectId}: ${unit.reason}`);
        } catch (err) {
          entry.error = err.message;
          log.error(`[bunny-cleanup] couldn’t remove ${unit.label} of project ${unit.projectId}:`, err.message);
        }
        result.versions.push(entry);
      }
      for (const stray of await strays()) {
        const entry = { what: stray.what, removed: false, error: null };
        try {
          if (!dryRun) await stray.remove();
          entry.removed = !dryRun;
          log.info(`[bunny-cleanup] ${verb} ${stray.what}`);
        } catch (err) {
          entry.error = err.message;
          log.error(`[bunny-cleanup] couldn’t remove ${stray.what}:`, err.message);
        }
        result.strays.push(entry);
      }
      const failed = [...result.versions, ...result.strays].filter((e) => e.error).length;
      log.info(`[bunny-cleanup] ${dryRun ? 'dry run' : 'run'} done: ${result.versions.length} version(s), ` +
        `${result.strays.length} stray(s)${failed ? `, ${failed} failed` : ''} (keeping ${days} days)`);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  let timer = null;
  /* Daily, unless mode is 'off'. Never keeps the process alive. */
  function start() {
    if (mode === 'off' || timer) return;
    const tick = () => run().catch((err) => log.error('[bunny-cleanup] the run failed:', err.message));
    timer = setTimeout(function again() {
      tick();
      timer = setTimeout(again, DAY_MS);
      if (timer.unref) timer.unref();
    }, FIRST_RUN_MS);
    if (timer.unref) timer.unref();
    log.info(`[bunny-cleanup] daily, ${mode === 'on' ? 'removing' : 'as a dry run (BUNNY_CLEANUP=on to remove)'}, keeping replaced versions ${days} days`);
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  /* What of a project is still on Bunny: rows with files there, and its collection. */
  function onBunny(projectId) {
    return { rows: projectRows.all(projectId).length, collection: Boolean(collectionOf.get(projectId)) };
  }

  /**
   * Takes an archived project's files off Bunny (Take offline). The caller has
   * checked it's archived. Refused while a send is still going (its job would put
   * files back): { refusal: [status, code, message] }. Otherwise the project is
   * marked offline first, so the client never sees half of it, then every version,
   * the collection's videos (strays too), the collection and the project's storage
   * folder go. Answers { removed, error }: error is why Bunny stopped it, with what
   * it hadn't removed left for another try. projects.files_offline_left holds that
   * reason until a try gets everything off, so the admin keeps offering it.
   */
  async function takeOffline(project) {
    if (processingIn.get(project.id) || projectBusy(project.id)) {
      return { refusal: [409, 'bunny_busy', 'Something of this project is still going to Bunny. Wait for it to finish, then take it offline.'] };
    }
    const at = isoNow();
    db.prepare('UPDATE projects SET files_offline_at = COALESCE(files_offline_at, ?), files_offline_left = ? WHERE id = ?')
      .run(at, 'Taking the files off Bunny hasn’t finished.', project.id);
    let removed = 0;
    try {
      const byVersion = new Map();
      for (const row of projectRows.all(project.id)) {
        if (!byVersion.has(row.version_id)) byVersion.set(row.version_id, []);
        byVersion.get(row.version_id).push(row);
      }
      for (const [versionId, rows] of byVersion) {
        await removeVersion({ versionId, rows }, 'offline');
        removed += 1;
      }
      const c = collectionOf.get(project.id);
      if (c) {
        for (const v of await bunny.listCollectionVideos(c.collection_id)) await bunny.deleteVideo(v.guid);
        await bunny.deleteCollection(c.collection_id);
        dropCollection.run(project.id);
      }
      await bunny.deleteObject(project.id, { folder: true });
      // Only now is everything off Bunny: until then the admin offers to finish it.
      db.prepare('UPDATE projects SET files_offline_left = NULL WHERE id = ?').run(project.id);
      log.info(`[bunny-cleanup] took project ${project.id} offline: ${removed} version(s) off Bunny`);
      return { removed, error: null };
    } catch (err) {
      db.prepare('UPDATE projects SET files_offline_left = ? WHERE id = ?').run(err.message, project.id);
      log.error(`[bunny-cleanup] taking project ${project.id} offline stopped:`, err.message);
      return { removed, error: err.message };
    }
  }

  return { run, start, stop, takeOffline, onBunny, dueVersions, mode, retentionDays: days };
}

module.exports = { createBunnyCleanup, DEFAULT_RETENTION_DAYS };
