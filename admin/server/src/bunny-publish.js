'use strict';

/**
 * Publishing a deliverable version to Bunny (Bunny Slice 2): the studio's routes
 * call this, and later slices (photos, masters, the webhook, cleanup) build on it.
 * Moved out of hub/routes.js, where its first cut keyed everything by NAS path.
 *
 * A video version goes to Bunny Stream: Bunny pulls the file itself from a
 * short-lived signed URL on hub-api (GET /hub/source/<versionId>/<name>, 6 hours),
 * never a permanent /hub/files link, so publishing mints nothing payment (F3) has
 * to shut later. One row per (version, kind) in bunny_assets (v33).
 *
 * Bunny's fetch call answers without the new video's id. So the title carries a
 * tag, "<file> [lsc-<16 hex>]", and the id comes from searching for it. A video
 * Bunny hasn't listed yet leaves the row `processing` with no id; every status
 * read looks again, and after 30 minutes unlisted the row is failed.
 *
 * - The first publish's tag is a hash of the version id, so a crash between the
 *   fetch and the row being written adopts that video rather than pulling the file
 *   a second time. A repeat publish (force, or a retry after a failure) gets a
 *   time-salted tag, so it can't find the video it replaces.
 * - `force` replaces a working video. The old one stays on Bunny, because a client
 *   reply may still point at it; only cleanup (Slice 11) takes it off. A force that
 *   Bunny refuses keeps the working row as it was.
 * - One Node process: the in-flight maps stop a double click, or a whole checklist
 *   published at once, from fetching twice or making two collections.
 *
 * Without every Bunny setting (and the portal's secret, which signs the source
 * URL) `ready` is false and the routes answer 503: the server still starts.
 */

const { basename, extname } = require('path');
const { createBunny, missingBunnySettings, statusFromVideo } = require('./hub/bunny');
const { createUrlSigner } = require('./hub/url-signing');
const { createDeliverables, VIDEO_EXTENSIONS } = require('./hub/deliverables');
const { sha256Hex } = require('./hub/tokens');

/* How long a publish may wait for Bunny to list the fetched video before it is
   failed. Without it a lost fetch job stays "processing" forever. */
const UNLISTED_VIDEO_LIMIT_MS = 30 * 60 * 1000;
const VIDEO_LOOKUP_ATTEMPTS = 3;
/* Long enough for Bunny to pull a big master through the tunnel, short enough
   that a copied link is soon useless. */
const SOURCE_TTL_SECONDS = 6 * 60 * 60;

/* What the signature covers: the version, never a path, so a signed URL can only
   ever serve the file that version names. */
const sourceSignedPath = (versionId) => `/hub/source/${versionId}`;

function publishTag(seed) {
  return `lsc-${sha256Hex(seed).slice(0, 16)}`;
}

/* Why Bunny gave up on a video, from its REST status: 6 is the pull itself
   failing (the NAS or the tunnel unreachable from Bunny), 5 the transcode. */
const TRANSCODE_FAILED = 'Bunny couldn’t transcode the file. Check it plays, then publish again.';
const PULL_FAILED = 'Bunny couldn’t fetch the file from the NAS. Check hub-api is reachable, then publish again.';
const failReasonOf = (video) => (video.status === 6 ? PULL_FAILED : TRANSCODE_FAILED);

/**
 * opts:
 *   bunny            Bunny settings (config.hub.bunny)
 *   signingSecret    HUB_SIGNING_SECRET: signs the source URL Bunny pulls from
 *   publicBaseUrl    hub-api's public address, where Bunny pulls from
 *   deliverablesDir  the read-only NAS deliverables folder
 * Tests only: bunnyFetch (Bunny's API), videoLookupGapMs, now (ms clock).
 */
function createBunnyPublisher(db, opts = {}) {
  const missing = [
    ...missingBunnySettings(opts.bunny),
    ...(opts.signingSecret ? [] : ['HUB_SIGNING_SECRET']),
    ...(opts.publicBaseUrl ? [] : ['HUB_PUBLIC_BASE_URL']),
    ...(opts.deliverablesDir ? [] : ['DELIVERABLES_DIR']),
  ];
  const ready = missing.length === 0;
  const now = opts.now || Date.now;
  const isoNow = () => new Date(now()).toISOString();
  const lookupGapMs = opts.videoLookupGapMs ?? 1000;
  const bunny = ready ? createBunny(opts.bunny, { fetchImpl: opts.bunnyFetch }) : null;
  const signer = ready ? createUrlSigner(opts.signingSecret, { now }) : null;
  const nas = opts.deliverablesDir ? createDeliverables(opts.deliverablesDir) : null;

  const getAsset = db.prepare('SELECT * FROM bunny_assets WHERE version_id = ? AND kind = ?');
  const upsertAsset = db.prepare(`
    INSERT INTO bunny_assets (
      version_id, kind, project_id, item_id, source_path, source_size, source_mtime,
      bunny_video_id, collection_id, publish_tag, status, error, progress_done, progress_total,
      created_at, updated_at
    ) VALUES (
      @version_id, @kind, @project_id, @item_id, @source_path, @source_size, @source_mtime,
      @bunny_video_id, @collection_id, @publish_tag, @status, @error, @progress_done, 1,
      @now, @now
    )
    ON CONFLICT(version_id, kind) DO UPDATE SET
      source_path    = excluded.source_path,
      source_size    = excluded.source_size,
      source_mtime   = excluded.source_mtime,
      bunny_video_id = excluded.bunny_video_id,
      collection_id  = excluded.collection_id,
      publish_tag    = excluded.publish_tag,
      status         = excluded.status,
      error          = excluded.error,
      progress_done  = excluded.progress_done,
      progress_total = excluded.progress_total,
      updated_at     = excluded.updated_at
  `);
  const setVideo = db.prepare(`
    UPDATE bunny_assets SET bunny_video_id = ?, status = ?, error = NULL, progress_done = ?, updated_at = ?
     WHERE version_id = ? AND kind = ?
  `);
  const failAsset = db.prepare(`
    UPDATE bunny_assets SET status = 'failed', error = ?, progress_done = 0, updated_at = ?
     WHERE version_id = ? AND kind = ?
  `);
  const setServed = db.prepare(`
    UPDATE bunny_assets SET source_size = ?, source_mtime = ? WHERE version_id = ? AND kind = 'video'
  `);
  const getCollection = db.prepare('SELECT collection_id FROM bunny_collections WHERE project_id = ?');
  const insertCollection = db.prepare(`
    INSERT INTO bunny_collections (project_id, collection_id, name, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET collection_id = excluded.collection_id, name = excluded.name
  `);
  const leadEstimateName = db.prepare(`
    SELECT name FROM estimates WHERE project_id = ? ORDER BY (status = 'accepted') DESC, created_at, id LIMIT 1
  `).pluck();

  const publishesInFlight = new Map();
  const collectionsInFlight = new Map();

  /* "<projectId> <name>": the id is what finds it again, the name is for a person
     looking in Bunny's dashboard. */
  function collectionName(project) {
    const label = String(project.name || leadEstimateName.get(project.id) || project.upid || '').trim();
    return label ? `${project.id} ${label}` : project.id;
  }

  function collectionFor(project) {
    const row = getCollection.get(project.id);
    if (row) return Promise.resolve(row.collection_id);
    if (collectionsInFlight.has(project.id)) return collectionsInFlight.get(project.id);
    const owns = (name) => name === project.id || name.startsWith(`${project.id} `);
    const pending = bunny.findOrCreateCollection(collectionName(project), { key: project.id, owns })
      .then(({ id, name }) => {
        insertCollection.run(project.id, id, name, isoNow());
        return id;
      })
      .finally(() => collectionsInFlight.delete(project.id));
    collectionsInFlight.set(project.id, pending);
    return pending;
  }

  /* The URL Bunny pulls the version's file from. The file's name rides along
     after the signed part, so Bunny sees a sensible name and extension. */
  function sourceUrl(version) {
    const { token, expires } = signer.signPath(sourceSignedPath(version.id), SOURCE_TTL_SECONDS);
    const name = encodeURIComponent(basename(version.source_path));
    return `${opts.publicBaseUrl}${sourceSignedPath(encodeURIComponent(version.id))}/${name}?token=${token}&expires=${expires}`;
  }

  /* Whether a signed source request is genuine: for the hub router's route. */
  function verifySource(versionId, token, expires) {
    return Boolean(signer) && signer.verifyPath(sourceSignedPath(versionId), token, expires);
  }

  /* The file as Bunny pulled it, which may be later than the publish (a retry
     within the link's 6 hours): sourceChanged compares against what Bunny has.
     A pull that lands before the row exists leaves the publish's own stat,
     taken a moment before the fetch call. */
  function servedSource(versionId, stat) {
    setServed.run(stat.size, Math.round(stat.mtimeMs), versionId);
  }

  /* Why a version can't go to Bunny Stream, as [status, code, message], or the
     NAS file it would send: { file }. The same rules as adding the file (R3). */
  async function check(version) {
    if (version.kind !== 'video') {
      return { refusal: [422, 'not_a_video', 'Only a video goes to Bunny Stream. Photo libraries come later.'] };
    }
    if (!version.source_path) {
      return { refusal: [409, 'no_nas_file', 'This version is a link the old Client Hub stored, with no NAS file to send.'] };
    }
    if (!version.source_path.includes('/')) {
      return { refusal: [422, 'not_in_project_folder', 'That file is at the top of the share. It needs to be inside a project’s folder.'] };
    }
    if (!VIDEO_EXTENSIONS.has(extname(version.source_path).toLowerCase())) {
      return { refusal: [422, 'not_a_video', 'That file isn’t a video (.mp4, .mov, .webm or .m4v).'] };
    }
    const file = nas.resolveDeliverablePath(version.source_path);
    if (file) return { file };
    const health = await nas.health();
    return {
      refusal: health.ok
        ? [409, 'file_missing', `${version.file_name || 'That file'} isn’t on the NAS any more.`]
        : [503, 'nas_unreachable', 'The NAS’s deliverables folder can’t be read right now.'],
    };
  }

  /* What the studio's screen shows. URLs for the client are built when the portal
     answers (Slice 4), not stored, so Slice 9 can sign them in one place. */
  function view(row, stat) {
    if (!row) return { status: 'none', error: null, sourceChanged: false, posterUrl: null, progress: { done: 0, total: 1 } };
    const id = row.bunny_video_id;
    return {
      status: row.status,
      error: row.error || null,
      // The NAS file was replaced after publishing, so Bunny still has the old cut.
      // Only force republishes it, so the studio needs telling.
      sourceChanged: Boolean(stat)
        && (stat.size !== row.source_size || Math.round(stat.mtimeMs) !== row.source_mtime),
      posterUrl: id && row.status === 'ready' ? bunny.posterUrl(id) : null,
      progress: { done: row.progress_done, total: row.progress_total },
    };
  }

  /* Brings a row up to date with Bunny: finds a video it hasn't listed yet, or
     reads a known one's transcoding state. A failed lookup leaves the row for the
     next read. The webhook (Slice 3) is the quick path; this is the fallback. */
  async function refresh(row) {
    if (!row || row.status !== 'processing') return row;
    try {
      if (!row.bunny_video_id) {
        // The row's own tag is unique to this attempt, so a failed match is this
        // attempt failing: say why now rather than after 30 minutes.
        const video = await bunny.findVideoByTag(row.publish_tag, row.collection_id, { includeFailed: true });
        if (video && statusFromVideo(video) === 'failed') {
          failAsset.run(failReasonOf(video), isoNow(), row.version_id, row.kind);
        } else if (video) {
          const status = statusFromVideo(video);
          setVideo.run(video.guid, status, status === 'ready' ? 1 : 0, isoNow(), row.version_id, row.kind);
        } else if (now() - new Date(row.updated_at).getTime() > UNLISTED_VIDEO_LIMIT_MS) {
          failAsset.run('Bunny never listed the fetched video. Publish again.', isoNow(), row.version_id, row.kind);
        }
      } else {
        const video = await bunny.getVideo(row.bunny_video_id);
        if (!video) {
          failAsset.run('Bunny no longer has this video. Publish again.', isoNow(), row.version_id, row.kind);
        } else {
          const status = statusFromVideo(video);
          if (status === 'failed') {
            failAsset.run(failReasonOf(video), isoNow(), row.version_id, row.kind);
          } else if (status !== row.status) {
            setVideo.run(row.bunny_video_id, status, status === 'ready' ? 1 : 0, isoNow(), row.version_id, row.kind);
          }
        }
      }
    } catch (err) {
      console.error('[bunny-publish] status lookup failed:', err.message);
    }
    return getAsset.get(row.version_id, row.kind);
  }

  async function publishVideo(project, version, file, force) {
    const existing = getAsset.get(version.id, 'video');
    // A failed row has nothing playable, so publishing again retries it.
    if (existing && !force && existing.status !== 'failed') return refresh(existing);

    const base = {
      version_id: version.id,
      kind: 'video',
      project_id: project.id,
      item_id: version.deliverable_id,
      source_path: version.source_path,
      source_size: file.stat.size,
      source_mtime: Math.round(file.stat.mtimeMs),
    };
    try {
      const collectionId = await collectionFor(project);
      const tag = publishTag(existing ? `${version.id}\n${now()}` : version.id);

      // First publish only: a crash after an earlier fetch left a video on Bunny
      // but no row here. Adopt it rather than pulling the file again.
      let video = existing ? null : await bunny.findVideoByTag(tag, collectionId);
      if (!video) {
        await bunny.fetchVideo({
          url: sourceUrl(version),
          title: `${version.file_name || basename(version.source_path)} [${tag}]`,
          collectionId,
        });
        for (let attempt = 0; !video && attempt < VIDEO_LOOKUP_ATTEMPTS; attempt += 1) {
          await new Promise((done) => setTimeout(done, lookupGapMs));
          video = await bunny.findVideoByTag(tag, collectionId, { includeFailed: true });
        }
      }
      const status = video ? statusFromVideo(video) : 'processing';
      upsertAsset.run({
        ...base,
        bunny_video_id: video ? video.guid : null,
        collection_id: collectionId,
        publish_tag: tag,
        status,
        error: status === 'failed' ? failReasonOf(video) : null,
        progress_done: status === 'ready' ? 1 : 0,
        now: isoNow(),
      });
    } catch (err) {
      console.error('[bunny-publish] publish failed:', err.message);
      // A failed force must not overwrite a video that's still working.
      if (existing && existing.status !== 'failed') {
        const kept = new Error(err.message);
        kept.keptExisting = true;
        throw kept;
      }
      upsertAsset.run({
        ...base,
        bunny_video_id: null,
        collection_id: existing ? existing.collection_id : null,
        publish_tag: existing ? existing.publish_tag : null,
        status: 'failed',
        error: `Bunny refused the publish: ${err.message}`,
        progress_done: 0,
        now: isoNow(),
      });
    }
    return getAsset.get(version.id, 'video');
  }

  /**
   * Publishes one version's video. Resolves to { httpStatus, body }: 200 with the
   * row's view, 502 when Bunny refused (a kept video says so in `error`).
   * The caller has already checked the version is this project's and passed check().
   */
  async function publish(project, version, file, { force = false } = {}) {
    // A repeat while one is running joins it, unless it's a force behind a plain
    // publish: that one runs after it, or the Republish would be lost.
    let entry = publishesInFlight.get(version.id);
    if (!entry || (force && !entry.force)) {
      const before = entry ? entry.promise.catch(() => null) : Promise.resolve();
      const mine = {
        force,
        promise: before.then(() => publishVideo(project, version, file, force)).finally(() => {
          if (publishesInFlight.get(version.id) === mine) publishesInFlight.delete(version.id);
        }),
      };
      publishesInFlight.set(version.id, mine);
      entry = mine;
    }
    try {
      const row = await entry.promise;
      return { httpStatus: row.status === 'failed' ? 502 : 200, body: view(row, file.stat) };
    } catch (err) {
      if (!err.keptExisting) throw err;
      const kept = getAsset.get(version.id, 'video');
      return { httpStatus: 502, body: { ...view(kept, file.stat), error: `Bunny refused the republish, so the published video stays: ${err.message}` } };
    }
  }

  /** The version's publish as it stands, looked up on Bunny if still processing. Needs no NAS file. */
  async function status(version) {
    const row = await refresh(getAsset.get(version.id, 'video'));
    const file = version.source_path ? nas.resolveDeliverablePath(version.source_path) : null;
    return view(row, file && file.stat);
  }

  return { ready, missing, check, publish, status, verifySource, servedSource, refresh, view };
}

module.exports = { createBunnyPublisher, UNLISTED_VIDEO_LIMIT_MS, SOURCE_TTL_SECONDS };
