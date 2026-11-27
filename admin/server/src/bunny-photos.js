'use strict';

/**
 * A photo library to Bunny Edge Storage (Bunny Slice 6). bunny-publish.js hands a
 * photo version here; a video goes to Stream there.
 *
 * Each photo in the version's NAS folder (the same list and 200-photo cap as adding
 * it, `listDeliverableFolderImages`) goes up three times, under
 *   /<projectId>/<itemId>/<versionId>/original-<tag>/<file>   untouched, the download
 *   /<projectId>/<itemId>/<versionId>/600/<file>              the grid's size
 *   /<projectId>/<itemId>/<versionId>/2400/<file>             the lightbox's size
 * The originals' folder carries a random tag, kept per version in the row's
 * publish_tag: until Slice 9 signs Bunny's links they are public, and a client who
 * sees a lightbox link must not reach the full-size original (the paid download,
 * C10/F3) by swapping `2400` for `original`. The client's reply leaves the original
 * out for the same reason: nothing in it is a download (C2).
 * No Bunny Optimizer (the user, 2026-11-07): the two sizes are made here with `sharp`,
 * JPEG, turned upright from the photo's EXIF, never larger than the original. A size
 * of a .png or .webp is named `<file>.jpg`, so it can't collide with a JPEG of the
 * same stem.
 *
 * A background job: the publish answers at once and the status reads n/total. Its
 * state is in the database, one bunny_photo_files row per photo (v36), so a restart
 * picks the job up where it stopped (resume(), at start-up) and a publish again only
 * sends what Bunny hasn't got: a photo that's done and unchanged on the NAS is
 * skipped, and an original Bunny already holds with the same bytes isn't sent again.
 * Four photos at a time. A photo that fails leaves the others; the library is
 * `failed` with the reason until a publish again sends what's left. A photo replaced
 * on the NAS while it was going up is sent again, once; changing again, it fails.
 *
 * The client sees a library from Bunny only once every photo is there (`ready`):
 * a library half on Bunny would show some photos and not others. Until then the
 * portal shows it from the NAS, as before. Photos taken out of the folder lose their
 * row when it is published again; their files stay on Bunny until cleanup (Slice 11).
 */

const crypto = require('crypto');
const fs = require('fs');
const { MAX_PHOTOS_PER_FOLDER } = require('./hub/deliverables');

/* The grid's size by width (a tile is a column wide), the lightbox's by its longer
   side (a portrait fills the screen's height). */
const SIZES = [
  { folder: '600', resize: { width: 600, withoutEnlargement: true }, quality: 80 },
  { folder: '2400', resize: { width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }, quality: 85 },
];
const CONCURRENCY = 4;
/* How many times a photo is sent while it keeps changing under the job. */
const TRIES_WHILE_CHANGING = 2;

const sizedName = (name) => (/\.jpe?g$/i.test(name) ? name : `${name}.jpg`);
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const sha256OfBuffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(path).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * @param {object} db
 * @param {{ bunny: object, nas: object, now: () => number, sharpImpl?: Function, concurrency?: number }} opts
 *   bunny  hub/bunny.js (putObject, listFolder, storageUrl); nas  hub/deliverables.js
 */
function createPhotoPublisher(db, { bunny, nas, now = Date.now, sharpImpl, concurrency = CONCURRENCY }) {
  const sharp = sharpImpl || require('sharp');
  const isoNow = () => new Date(now()).toISOString();

  const getAsset = db.prepare("SELECT * FROM bunny_assets WHERE version_id = ? AND kind = 'photos'");
  const startAsset = db.prepare(`
    INSERT INTO bunny_assets (version_id, kind, project_id, item_id, source_path, storage_path, publish_tag, status, error,
                              progress_done, progress_total, created_at, updated_at)
    VALUES (@version_id, 'photos', @project_id, @item_id, @source_path, @storage_path, @tag, 'processing', NULL,
            @done, @total, @now, @now)
    ON CONFLICT(version_id, kind) DO UPDATE SET
      source_path = excluded.source_path, storage_path = excluded.storage_path, status = 'processing',
      publish_tag = COALESCE(bunny_assets.publish_tag, excluded.publish_tag),
      error = NULL, progress_done = excluded.progress_done, progress_total = excluded.progress_total,
      updated_at = excluded.updated_at
  `);
  const setProgress = db.prepare("UPDATE bunny_assets SET progress_done = ?, updated_at = ? WHERE version_id = ? AND kind = 'photos'");
  const finishAsset = db.prepare(`
    UPDATE bunny_assets SET status = ?, error = ?, progress_done = ?, progress_total = ?, updated_at = ?
     WHERE version_id = ? AND kind = 'photos'
  `);
  const processingAssets = db.prepare("SELECT version_id FROM bunny_assets WHERE kind = 'photos' AND status = 'processing'").pluck();

  const filesOf = db.prepare('SELECT * FROM bunny_photo_files WHERE version_id = ?');
  const putFile = db.prepare(`
    INSERT INTO bunny_photo_files (version_id, file_name, source_size, source_mtime, status, error, updated_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?)
    ON CONFLICT(version_id, file_name) DO UPDATE SET
      source_size = excluded.source_size, source_mtime = excluded.source_mtime,
      status = 'pending', error = NULL, updated_at = excluded.updated_at
  `);
  const dropFile = db.prepare('DELETE FROM bunny_photo_files WHERE version_id = ? AND file_name = ?');
  const fileDone = db.prepare(`
    UPDATE bunny_photo_files SET status = 'done', error = NULL, source_size = ?, source_mtime = ?, width = ?, height = ?, updated_at = ?
     WHERE version_id = ? AND file_name = ?
  `);
  const fileFailed = db.prepare(`
    UPDATE bunny_photo_files SET status = 'failed', error = ?, updated_at = ? WHERE version_id = ? AND file_name = ?
  `);

  const jobs = new Map(); // versionId → the running job's promise

  /* The photos in the version's folder now, as { name, size, mtime }, or a refusal
     as [status, code, message]. The same rules as adding the folder (R3). */
  async function scan(version) {
    if (!version.source_path) {
      return { refusal: [409, 'no_nas_file', 'This version is a link the old Client Hub stored, with no NAS folder to send.'] };
    }
    const names = nas.listDeliverableFolderImages(version.source_path);
    if (!names) {
      const health = await nas.health();
      return {
        refusal: health.ok
          ? [409, 'folder_missing', 'That photo folder isn’t on the NAS any more.']
          : [503, 'nas_unreachable', 'The NAS’s deliverables folder can’t be read right now.'],
      };
    }
    if (!names.length) return { refusal: [422, 'no_photos', 'That folder has no photos in it (.jpg, .png or .webp).'] };
    if (names.length > MAX_PHOTOS_PER_FOLDER) {
      return { refusal: [422, 'too_many_images', `That folder has ${names.length} images (the limit is ${MAX_PHOTOS_PER_FOLDER}). Point at a single delivery folder.`] };
    }
    const photos = [];
    for (const name of names) {
      const found = nas.resolveDeliverablePath(`${version.source_path}/${name}`);
      if (found) photos.push({ name, size: found.stat.size, mtime: Math.round(found.stat.mtimeMs) });
    }
    return { photos };
  }

  /**
   * Whether the version's folder can go to Bunny: { refusal } or { file }, where
   * file.stat is the folder taken as one file (its bytes in all and its newest
   * photo's time), so the routes' "changed since the client had it" check reads
   * the same for a library as for a video, and file.photos is what scan found.
   */
  async function check(version) {
    const found = await scan(version);
    if (found.refusal) return found;
    const { photos } = found;
    return {
      file: {
        stat: { size: photos.reduce((n, p) => n + p.size, 0), mtimeMs: Math.max(...photos.map((p) => p.mtime)) },
        photos,
      },
    };
  }

  const storageBase = (asset) => asset.storage_path;
  const originals = (asset) => `${storageBase(asset)}/original-${asset.publish_tag}`;
  const pathOf = (asset, folder, name) => (folder === 'original' ? `${originals(asset)}/${name}` : `${storageBase(asset)}/${folder}/${name}`);

  /* Whether the folder differs from what Bunny has: a photo added, taken out or
     replaced since it was sent. Only for a finished library. */
  async function folderChanged(row, version) {
    if (!row || row.status !== 'ready' || !version) return false;
    const found = await scan(version);
    if (found.refusal) return false;
    const sent = new Map(filesOf.all(row.version_id).map((f) => [f.file_name, f]));
    if (sent.size !== found.photos.length) return true;
    return found.photos.some((p) => {
      const f = sent.get(p.name);
      return !f || f.status !== 'done' || f.source_size !== p.size || f.source_mtime !== p.mtime;
    });
  }

  async function view(row, version) {
    if (!row) return { status: 'none', error: null, sourceChanged: false, posterUrl: null, progress: { done: 0, total: 0 } };
    return {
      status: row.status,
      error: row.error || null,
      sourceChanged: await folderChanged(row, version),
      posterUrl: null,
      progress: { done: row.progress_done, total: row.progress_total },
    };
  }

  /* One photo up: the original (unless Bunny holds the same bytes), then the two
     sizes. Returns { width, height, size, mtime } as it was sent. A photo saved over
     while it went up is sent again, once. */
  async function sendPhoto(asset, version, name, held) {
    for (let attempt = 1; ; attempt += 1) {
      const found = nas.resolveDeliverablePath(`${version.source_path}/${name}`);
      if (!found) throw new Error('It isn’t in the folder any more.');
      const before = found.stat;
      const unchanged = () => {
        const now = nas.resolveDeliverablePath(`${version.source_path}/${name}`);
        return Boolean(now) && now.stat.size === before.size && Math.round(now.stat.mtimeMs) === Math.round(before.mtimeMs);
      };
      let sent;
      try {
        sent = await sendOnce(asset, name, found.absolute, before, held);
      } catch (err) {
        // Saved over part-way (Bunny refuses bytes that don't match their checksum, or
        // sharp reads half a file): that is the file changing, not failing.
        if (unchanged()) throw err;
      }
      if (sent && unchanged()) return { ...sent, size: before.size, mtime: Math.round(before.mtimeMs) };
      if (attempt >= TRIES_WHILE_CHANGING) throw new Error('It kept changing on the NAS while it was being sent.');
      held.delete(name); // what went up is the old file: send all of it again
    }
  }

  async function sendOnce(asset, name, absolute, before, held) {
    const hash = await sha256OfFile(absolute);
    const onBunny = held.get(name);
    if (!onBunny || onBunny.length !== before.size || String(onBunny.checksum || '').toLowerCase() !== hash) {
      await bunny.putObject(pathOf(asset, 'original', name), fs.createReadStream(absolute), { length: before.size, checksum: hash });
    }
    let meta;
    try {
      meta = await sharp(absolute).metadata();
    } catch (err) {
      throw new Error(`It couldn’t be read as an image (${err.message}).`);
    }
    // EXIF orientations 5-8 are a quarter turn: the photo stands the other way up.
    const turned = meta.orientation >= 5;
    for (const size of SIZES) {
      const jpeg = await sharp(absolute)
        .rotate()
        .resize(size.resize)
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: size.quality, progressive: true, mozjpeg: true })
        .toBuffer();
      await bunny.putObject(pathOf(asset, size.folder, sizedName(name)), jpeg, { length: jpeg.length, checksum: sha256OfBuffer(jpeg) });
    }
    return { width: turned ? meta.height : meta.width, height: turned ? meta.width : meta.height };
  }

  async function runJob(versionId) {
    const asset = getAsset.get(versionId);
    if (!asset || asset.status !== 'processing') return;
    const version = db.prepare('SELECT * FROM deliverable_versions WHERE id = ?').get(versionId);
    if (!version) {
      finishAsset.run('failed', 'This version no longer exists.', asset.progress_done, asset.progress_total, isoNow(), versionId);
      return;
    }
    const files = filesOf.all(versionId);
    const todo = files.filter((f) => f.status !== 'done').map((f) => f.file_name).sort(byName);
    let done = files.length - todo.length;
    setProgress.run(done, isoNow(), versionId);

    // What Bunny already holds of the originals: a job stopped part-way through a
    // big file, or a row lost, needn't send those bytes again.
    let held = new Map();
    try {
      held = new Map((await bunny.listFolder(originals(asset))).map((f) => [f.name, f]));
    } catch (err) {
      console.warn('[bunny-photos] couldn’t list what Bunny holds, so every original goes up:', err.message);
    }

    const queue = [...todo];
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          const sent = await sendPhoto(asset, version, name, held);
          fileDone.run(sent.size, sent.mtime, sent.width, sent.height, isoNow(), versionId, name);
          done += 1;
          setProgress.run(done, isoNow(), versionId);
        } catch (err) {
          fileFailed.run(String(err.message || err).slice(0, 500), isoNow(), versionId, name);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) || 1 }, worker));

    const after = filesOf.all(versionId);
    const failed = after.filter((f) => f.status !== 'done').sort((a, b) => byName(a.file_name, b.file_name));
    const doneNow = after.length - failed.length;
    if (failed.length) {
      const first = failed[0];
      const error = `${failed.length} of ${after.length} photos couldn’t go to Bunny (first, ${first.file_name}: ${first.error || 'not sent'}). Send it to Bunny again to retry them.`;
      finishAsset.run('failed', error, doneNow, after.length, isoNow(), versionId);
    } else {
      finishAsset.run('ready', null, doneNow, after.length, isoNow(), versionId);
    }
  }

  function start(versionId) {
    if (jobs.has(versionId)) return jobs.get(versionId);
    const job = runJob(versionId)
      .catch((err) => {
        console.error('[bunny-photos] a photo job stopped:', err.message);
        const row = getAsset.get(versionId);
        if (row) finishAsset.run('failed', `The photo job stopped: ${err.message}`, row.progress_done, row.progress_total, isoNow(), versionId);
      })
      .finally(() => jobs.delete(versionId));
    jobs.set(versionId, job);
    return job;
  }

  /**
   * Starts (or restarts) the version's library on Bunny and answers at once with
   * its view. `photos` is check()'s scan. A library already ready is left alone
   * unless `force`, which brings it in line with the folder: new and replaced
   * photos go up, ones taken out lose their row, and the rest are kept. A failed one
   * is retried. One already running is answered as it stands.
   */
  async function publish(project, version, photos, { force = false } = {}) {
    if (jobs.has(version.id)) return view(getAsset.get(version.id), version);
    const existing = getAsset.get(version.id);
    if (existing && existing.status === 'ready' && !force) return view(existing, version);

    const at = isoNow();
    const known = new Map(filesOf.all(version.id).map((f) => [f.file_name, f]));
    const wanted = new Set(photos.map((p) => p.name));
    let done = 0;
    db.transaction(() => {
      for (const p of photos) {
        const f = known.get(p.name);
        if (f && f.status === 'done' && f.source_size === p.size && f.source_mtime === p.mtime) done += 1;
        else putFile.run(version.id, p.name, p.size, p.mtime, at);
      }
      for (const name of known.keys()) if (!wanted.has(name)) dropFile.run(version.id, name);
      startAsset.run({
        version_id: version.id,
        project_id: project.id,
        item_id: version.deliverable_id,
        source_path: version.source_path,
        storage_path: `${project.id}/${version.deliverable_id}/${version.id}`,
        tag: crypto.randomBytes(12).toString('hex'),
        done,
        total: photos.length,
        now: at,
      });
    })();
    start(version.id);
    return view(getAsset.get(version.id), version);
  }

  /** The library's publish as it stands. */
  async function status(version) {
    return view(getAsset.get(version.id), version);
  }

  /* Every library a restart interrupted goes on from where it stopped. */
  function resume() {
    for (const versionId of processingAssets.all()) start(versionId);
    return idle();
  }

  /**
   * A ready library's photos, in the folder's order, as
   * { name, width, height, grid, review, download } (download is the original, for
   * the server's own use: the client's reply leaves it out until a download gate
   * gives it, F3/F5), or null while it isn't all on Bunny. Built when the portal answers, never
   * stored, so Slice 9 can sign them in one place.
   */
  function photosOf(versionId) {
    const asset = getAsset.get(versionId);
    if (!asset || asset.status !== 'ready') return null;
    return filesOf.all(versionId)
      .filter((f) => f.status === 'done')
      .sort((a, b) => byName(a.file_name, b.file_name))
      .map((f) => ({
        name: f.file_name,
        width: f.width,
        height: f.height,
        grid: bunny.storageUrl(pathOf(asset, '600', sizedName(f.file_name))),
        review: bunny.storageUrl(pathOf(asset, '2400', sizedName(f.file_name))),
        download: bunny.storageUrl(pathOf(asset, 'original', f.file_name)),
      }));
  }

  const idle = () => Promise.all([...jobs.values()]).then(() => undefined);

  return { check, publish, status, resume, photosOf, idle };
}

module.exports = { createPhotoPublisher, SIZES, sizedName };
