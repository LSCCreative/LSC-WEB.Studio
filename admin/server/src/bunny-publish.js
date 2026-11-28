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

const crypto = require('crypto');
const { basename, extname } = require('path');
const { createBunny, missingBunnySettings, statusFromVideo } = require('./hub/bunny');
const { createUrlSigner } = require('./hub/url-signing');
const { createDeliverables, VIDEO_EXTENSIONS } = require('./hub/deliverables');
const { sha256Hex } = require('./hub/tokens');
const { createPhotoPublisher } = require('./bunny-photos');
const { createMasterPublisher } = require('./bunny-masters');
const { createBunnyCleanup } = require('./bunny-cleanup');

/* How long a publish may wait for Bunny to list the fetched video before it is
   failed. Without it a lost fetch job stays "processing" forever. */
const UNLISTED_VIDEO_LIMIT_MS = 30 * 60 * 1000;
const VIDEO_LOOKUP_ATTEMPTS = 3;
/* Long enough for Bunny to pull a big master through the tunnel, short enough
   that a copied link is soon useless. */
const SOURCE_TTL_SECONDS = 6 * 60 * 60;
/* The paid email's download link (Slice 9; the user's call, 2026-11-27): it goes
   through hub-api, which can refuse it later (F3), and lasts this long. Each click
   gets a Bunny link of its own for DOWNLOAD_REDIRECT_SECONDS, long enough for a
   big master to finish downloading. */
const DOWNLOAD_LINK_SECONDS = 90 * 24 * 60 * 60;
const DOWNLOAD_REDIRECT_SECONDS = 24 * 60 * 60;
const downloadSignedPath = (versionId) => `/hub/download/${versionId}`;

/* What the signature covers: the version, never a path, so a signed URL can only
   ever serve the file that version names. */
const sourceSignedPath = (versionId) => `/hub/source/${versionId}`;

function publishTag(seed) {
  return `lsc-${sha256Hex(seed).slice(0, 16)}`;
}

/* Why Bunny gave up on a video, from its REST status: 6 is the pull itself
   failing (the NAS or the tunnel unreachable from Bunny), 5 the transcode. */
const TRANSCODE_FAILED = 'Bunny couldn’t transcode the file. Check it plays, then send it to Bunny again.';
const PULL_FAILED = 'Bunny couldn’t fetch the file from the NAS. Check hub-api is reachable, then send it to Bunny again.';
const failReasonOf = (video) => (video.status === 6 ? PULL_FAILED : TRANSCODE_FAILED);
const DELETED_ON_BUNNY = 'The video was deleted on Bunny. Send it to Bunny again.';
/* A row with nothing playable on Bunny: publishing it again sends it afresh. */
const GONE_OR_FAILED = new Set(['failed', 'expired', 'offline']);

/* A webhook's Status (Bunny's docs, "Webhooks"), which is NOT the REST enum
   statusFromVideo reads: here 3 is finished and 4 one resolution done. What it
   means for a row; codes not listed (captions, chapters, presigned uploads) say
   nothing about whether the video plays, and are ignored. */
const WEBHOOK_STATUS = {
  0: 'processing', 1: 'processing', 2: 'processing', 4: 'processing',
  3: 'ready',
  5: 'failed',
  32: 'deleted',
};

/**
 * opts:
 *   bunny            Bunny settings (config.hub.bunny)
 *   signingSecret    HUB_SIGNING_SECRET: signs the source URL Bunny pulls from
 *   publicBaseUrl    hub-api's public address, where Bunny pulls from
 *   deliverablesDir  the read-only NAS deliverables folder
 * Tests only: bunnyFetch (Bunny's API), videoLookupGapMs, adoptGapMs, now (ms clock),
 * photoConcurrency, resumePhotos (false: a test starts them itself; masters too),
 * masterStallMs.
 *   onMasterReady    (projectId) a Final's master just landed on Bunny (Slice 8)
 *   cleanup          { mode: 'dry'|'on'|'off', retentionDays } (Slice 11, bunny-cleanup.js)
 *
 * A photo library goes to Edge Storage instead (Slice 6, bunny-photos.js): check,
 * publish and status hand a `photos` version there, and photosOf gives the client's
 * URLs. Libraries a restart interrupted go on from where they stopped.
 *
 * A Final's video also sends its untouched master to Edge Storage (Slice 8,
 * bunny-masters.js), beside Stream: publish starts it, a plain publish again sends
 * one that's missing or failed, and a Republish sends the new file. The video's
 * view carries it as `master`. Only C10's paid email gives its link out (linkOf).
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
  const bunny = ready ? createBunny(opts.bunny, { fetchImpl: opts.bunnyFetch, now }) : null;
  const signer = ready ? createUrlSigner(opts.signingSecret, { now }) : null;
  const nas = opts.deliverablesDir ? createDeliverables(opts.deliverablesDir) : null;
  const photos = ready ? createPhotoPublisher(db, { bunny, nas, now, concurrency: opts.photoConcurrency }) : null;
  const masters = ready ? createMasterPublisher(db, {
    bunny, nas, now, onReady: opts.onMasterReady, stallMs: opts.masterStallMs,
  }) : null;
  const publishesInFlight = new Map();
  const collectionsInFlight = new Map();
  /* The daily cleanup and Take offline (Slice 11): a version being published is left alone. */
  /* Take offline and Bring back online, by project id, while one runs: never both at
     once, and never a Take offline while a publish of the project is still going. */
  const projectOps = new Set();
  const publishing = (projectId) => [...publishesInFlight.values()].some((entry) => entry.projectId === projectId);
  const cleanup = ready ? createBunnyCleanup(db, {
    bunny, now, ...(opts.cleanup || {}), busy: (versionId) => publishesInFlight.has(versionId), projectBusy: publishing,
  }) : null;
  if (photos && opts.resumePhotos !== false) setImmediate(() => photos.resume());
  if (masters && opts.resumePhotos !== false) setImmediate(() => masters.resume());

  const getAsset = db.prepare('SELECT * FROM bunny_assets WHERE version_id = ? AND kind = ?');
  const upsertAsset = db.prepare(`
    INSERT INTO bunny_assets (
      version_id, kind, project_id, item_id, source_path, source_size, source_mtime,
      bunny_video_id, collection_id, publish_tag, status, error, progress_done, progress_total,
      last_event_at, created_at, updated_at
    ) VALUES (
      @version_id, @kind, @project_id, @item_id, @source_path, @source_size, @source_mtime,
      @bunny_video_id, @collection_id, @publish_tag, @status, @error, @progress_done, 1,
      @now, @now, @now
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
      last_event_at  = excluded.last_event_at,
      updated_at     = excluded.updated_at
  `);
  /* Every state written from what Bunny's REST API showed also moves last_event_at
     to when it was seen, so a webhook older than that observation can't undo it
     (a delayed retry of an earlier event, Bunny retrying for up to 4 hours). */
  const setVideo = db.prepare(`
    UPDATE bunny_assets SET bunny_video_id = ?, status = ?, error = NULL, progress_done = ?, updated_at = ?,
           last_event_at = MAX(COALESCE(last_event_at, ''), ?)
     WHERE version_id = ? AND kind = ?
  `);
  const failAsset = db.prepare(`
    UPDATE bunny_assets SET status = 'failed', error = ?, progress_done = 0, updated_at = ?,
           last_event_at = MAX(COALESCE(last_event_at, ''), ?)
     WHERE version_id = ? AND kind = ?
  `);
  const markVideo = (videoId, status, done, versionId, kind) => {
    const at = isoNow();
    setVideo.run(videoId, status, done, at, at, versionId, kind);
  };
  const markFailed = (error, versionId, kind) => {
    const at = isoNow();
    failAsset.run(error, at, at, versionId, kind);
  };
  const getByVideo = db.prepare('SELECT * FROM bunny_assets WHERE bunny_video_id = ?');
  const setFromEvent = db.prepare(`
    UPDATE bunny_assets SET status = ?, error = ?, progress_done = ?, last_event_at = ?, updated_at = ?
     WHERE version_id = ? AND kind = ? AND bunny_video_id = ?
  `);
  /* Video rows with no video id yet: still processing, or failed with nothing Bunny
     listed (the 30-minute limit, a slow queue) inside the 6 hours a webhook can still
     come. Videos only: a photo library's row has no video id and a publish_tag of its
     own (its originals' folder, Slice 6), and isn't Stream's to look up or fail. */
  const waitingForId = db.prepare(`
    SELECT * FROM bunny_assets
     WHERE kind = 'video' AND bunny_video_id IS NULL AND publish_tag IS NOT NULL
       AND (status = 'processing' OR (status = 'failed' AND updated_at >= ?))
     ORDER BY created_at
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
    if (version.kind === 'photos') return photos.check(version);
    if (version.kind !== 'video') {
      return { refusal: [422, 'not_a_video', 'Only a video or a photo library goes to Bunny.'] };
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

  /* Where the client plays a ready video from, built when the portal answers and
     never stored (Slice 9 signs these in one place). Null when Bunny is off. */
  function playback(videoId) {
    if (!bunny || !videoId) return null;
    return { url: bunny.hlsUrl(videoId), poster: bunny.posterUrl(videoId) };
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
          markFailed(failReasonOf(video), row.version_id, row.kind);
        } else if (video) {
          const status = statusFromVideo(video);
          markVideo(video.guid, status, status === 'ready' ? 1 : 0, row.version_id, row.kind);
        } else if (now() - new Date(row.updated_at).getTime() > UNLISTED_VIDEO_LIMIT_MS) {
          markFailed('Bunny never listed the fetched video. Send it to Bunny again.', row.version_id, row.kind);
        }
      } else {
        const video = await bunny.getVideo(row.bunny_video_id);
        if (!video) {
          markFailed('Bunny no longer has this video. Send it to Bunny again.', row.version_id, row.kind);
        } else {
          const status = statusFromVideo(video);
          if (status === 'failed') {
            markFailed(failReasonOf(video), row.version_id, row.kind);
          } else if (status !== row.status) {
            markVideo(row.bunny_video_id, status, status === 'ready' ? 1 : 0, row.version_id, row.kind);
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
    // A failed row has nothing playable, so publishing again retries it, as it does
    // one whose video was taken off Bunny (expired by cleanup, or offline, Slice 11).
    if (existing && !force && !GONE_OR_FAILED.has(existing.status)) return refresh(existing);

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
      if (existing && !GONE_OR_FAILED.has(existing.status)) {
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
   * row's view, and `refused: true` when Bunny refused (a kept video says so in
   * `error`). Never a 5xx for that: Bunny saying no is an answer, not this server
   * failing, and the admin reads any 5xx as the server being down (connection.js).
   * The caller has already checked the version is this project's and passed check().
   */
  async function publish(project, version, file, { force = false } = {}) {
    if (version.kind === 'photos') {
      const body = await photos.publish(project, version, file.photos, { force });
      return { httpStatus: 200, body: { ...body, refused: false } };
    }
    // A Final's master goes beside the video, whatever Stream answers: the download
    // is the file itself, and Stream refusing it says nothing about Edge Storage.
    const master = () => masters.view(version.id);
    masters.publish(project, version, file.stat, { force });
    // A repeat while one is running joins it, unless it's a force behind a plain
    // publish: that one runs after it, or the Republish would be lost.
    let entry = publishesInFlight.get(version.id);
    if (!entry || (force && !entry.force)) {
      const before = entry ? entry.promise.catch(() => null) : Promise.resolve();
      const mine = {
        force,
        projectId: project.id,
        promise: before.then(() => publishVideo(project, version, file, force)).finally(() => {
          if (publishesInFlight.get(version.id) === mine) publishesInFlight.delete(version.id);
        }),
      };
      publishesInFlight.set(version.id, mine);
      entry = mine;
    }
    try {
      const row = await entry.promise;
      return { httpStatus: 200, body: { ...view(row, file.stat), master: master(), refused: row.status === 'failed' } };
    } catch (err) {
      if (!err.keptExisting) throw err;
      const kept = getAsset.get(version.id, 'video');
      return {
        httpStatus: 200,
        body: { ...view(kept, file.stat), master: master(), refused: true, error: `Bunny refused the republish, so the published video stays: ${err.message}` },
      };
    }
  }

  /** The version's publish as it stands, looked up on Bunny if still processing. Needs no NAS file. */
  async function status(version) {
    if (version.kind === 'photos') return photos.status(version);
    const row = await refresh(getAsset.get(version.id, 'video'));
    const file = version.source_path ? nas.resolveDeliverablePath(version.source_path) : null;
    return { ...view(row, file && file.stat), master: masters.view(version.id) };
  }

  /**
   * Whether a webhook is Bunny's: X-BunnyStream-Signature is the lowercase hex
   * HMAC-SHA256 of the raw body, keyed with the library's read-only key, beside a
   * v1 / hmac-sha256 version and algorithm. `raw` must be the bytes as received:
   * a body a JSON parser has read is refused, since re-serialising changes them.
   */
  function verifyWebhook(raw, headers = {}) {
    if (!ready || !Buffer.isBuffer(raw)) return false;
    if (String(headers['x-bunnystream-signature-version'] || '') !== 'v1') return false;
    if (String(headers['x-bunnystream-signature-algorithm'] || '').toLowerCase() !== 'hmac-sha256') return false;
    const given = String(headers['x-bunnystream-signature'] || '');
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    const expected = crypto.createHmac('sha256', opts.bunny.streamReadKey).update(raw).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  }

  /* The rows still waiting for Bunny to list their video: a webhook can beat the
     tag lookup, so an unknown id sends them to look again. In the background,
     after the webhook is answered; one look at a time. `adopting` is that look,
     for the tests to wait on. */
  let adopting = Promise.resolve();
  let scheduled = null;
  let lastPassAt = -Infinity;
  const adoptGapMs = opts.adoptGapMs ?? 15000;
  function adoptWaiting() {
    // At most one pass every adoptGapMs, and one waiting covers every webhook that
    // asks meanwhile: a Republish's old video sends a run of events over its encode,
    // and each needn't look up every waiting row again.
    if (scheduled) return scheduled;
    const wait = Math.max(0, lastPassAt + adoptGapMs - Date.now());
    scheduled = new Promise((resolve) => {
      const timer = setTimeout(resolve, wait);
      if (timer.unref) timer.unref();
    }).then(async () => {
      scheduled = null;
      lastPassAt = Date.now();
      const since = new Date(now() - SOURCE_TTL_SECONDS * 1000).toISOString();
      for (const row of waitingForId.all(since)) {
        if (row.status === 'processing') await refresh(row);
        else await adoptLate(row);
      }
    }).catch((err) => console.error('[bunny-publish] adopting after a webhook failed:', err.message));
    adopting = scheduled;
    return scheduled;
  }

  /* A row the unlisted limit failed whose video Bunny has listed after all: take it
     up, so a slow queue doesn't need a second pull. A failed match stays failed. */
  async function adoptLate(row) {
    try {
      const video = await bunny.findVideoByTag(row.publish_tag, row.collection_id);
      if (video) {
        const status = statusFromVideo(video);
        markVideo(video.guid, status, status === 'ready' ? 1 : 0, row.version_id, row.kind);
      }
    } catch (err) {
      console.error('[bunny-publish] late lookup failed:', err.message);
    }
  }

  /**
   * One verified webhook, parsed. Answers what happened, for the log and the tests:
   * 'applied', 'ignored' (another library, a live stream, a code that says
   * nothing, or an event older than the row's last), 'unchanged' (it would only
   * move a finished video back to processing) or 'unknown' (no row has that
   * video: an old one replaced by a Republish, or one whose id we haven't
   * learned yet, so the waiting rows look again).
   * Events can arrive out of order and more than once: the row keeps the newest
   * Timestamp it applied, and a progress event never undoes ready.
   */
  async function applyWebhook(event) {
    if (!event || typeof event !== 'object') return 'ignored';
    if (event.IsLiveStreamWebhook === true) return 'ignored';
    if (String(event.VideoLibraryId) !== String(opts.bunny.libraryId)) return 'ignored';
    const meaning = WEBHOOK_STATUS[event.Status];
    const videoId = typeof event.VideoGuid === 'string' ? event.VideoGuid : '';
    if (!meaning || !videoId) return 'ignored';
    const row = getByVideo.get(videoId);
    if (!row) {
      adoptWaiting();
      return 'unknown';
    }
    // Its video was taken off Bunny on purpose (Slice 11): the deletion's own event,
    // or a late one about it, changes nothing.
    if (row.status === 'expired' || row.status === 'offline') return 'ignored';
    const stamp = typeof event.Timestamp === 'string' ? event.Timestamp.trim() : '';
    const at = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(stamp) || !stamp ? stamp : `${stamp}Z`);
    const eventAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
    if (eventAt && row.last_event_at && eventAt < row.last_event_at) return 'ignored';
    if (meaning === 'processing' && row.status === 'ready') return 'unchanged';
    const next = {
      processing: ['processing', null, 0],
      ready: ['ready', null, 1],
      failed: ['failed', TRANSCODE_FAILED, 0],
      deleted: ['failed', DELETED_ON_BUNNY, 0],
    }[meaning];
    setFromEvent.run(...next, eventAt || row.last_event_at, isoNow(), row.version_id, row.kind, videoId);
    return 'applied';
  }

  /* What the client is shown of each needed item: its newest published version, when
     it has a NAS file a publish can send. */
  const currentVersions = db.prepare(`
    SELECT v.*, d.title AS item_title FROM deliverable_versions v JOIN deliverables d ON d.id = v.deliverable_id
     WHERE d.project_id = ? AND d.not_needed_at IS NULL AND v.published_at IS NOT NULL AND v.kind IN ('video', 'photos')
       AND v.n = (SELECT MAX(n) FROM deliverable_versions WHERE deliverable_id = d.id AND published_at IS NOT NULL)
     ORDER BY d.position, d.created_at, d.id
  `);

  /**
   * Bring back online (Slice 11): sends each current version to Bunny again from the
   * NAS, then lifts the project's offline mark, so the client sees its files again
   * (from the NAS until Bunny has each). Refused, with nothing changed, while the
   * NAS can't be read: { refusal }. Otherwise { sent: [{ title, n }], missing:
   * [{ title, n, fileName, reason }] }: missing is what isn't on the NAS any more,
   * which the client can't be shown, and refused what Bunny said no to.
   */
  const BUSY = [409, 'bunny_busy', 'This project’s files are already being taken offline or brought back. Wait for that to finish.'];
  async function bringOnline(project) {
    if (projectOps.has(project.id)) return { refusal: BUSY };
    projectOps.add(project.id);
    try {
      return await bringOnlineNow(project);
    } finally {
      projectOps.delete(project.id);
    }
  }
  /* A refusal is a 409, never a 5xx: the admin reads any 5xx as the server down. */
  async function bringOnlineNow(project) {
    const health = await nas.health();
    if (!health.ok) return { refusal: [409, 'nas_unreachable', 'The NAS’s deliverables folder can’t be read right now, so nothing was sent. Try again once it’s back.'] };
    const sent = [];
    const notOnNas = [];
    const refused = [];
    // Every version settles (sent, missing or refused) before the offline mark lifts,
    // whatever one of them throws.
    await Promise.all(currentVersions.all(project.id).map(async (v) => {
      const label = { title: v.item_title || '', n: v.n, fileName: v.file_name || basename(v.source_path || '') };
      try {
        const checked = await check(v);
        if (checked.refusal) {
          notOnNas.push({ ...label, reason: checked.refusal[2] });
          return;
        }
        const { body } = await publish(project, v, checked.file, { force: false });
        if (body.refused) refused.push({ ...label, reason: body.error || 'Bunny refused it.' });
        else sent.push(label);
      } catch (err) {
        refused.push({ ...label, reason: err.message });
      }
    }));
    db.prepare('UPDATE projects SET files_offline_at = NULL, files_offline_left = NULL WHERE id = ?').run(project.id);
    const byOrder = (a, b) => a.title.localeCompare(b.title) || a.n - b.n;
    return { sent: sent.sort(byOrder), missing: notOnNas.sort(byOrder), refused: refused.sort(byOrder) };
  }

  return {
    ready, missing, check, publish, status, playback, verifySource, servedSource, refresh, view, verifyWebhook, applyWebhook,
    adopted: () => adopting,
    /** A ready photo library's URLs for the client, or null (bunny-photos.js). */
    photosOf: (versionId) => (photos ? photos.photosOf(versionId) : null),
    /** Every photo job running now, done: for the tests, and resuming at start-up. */
    photoJobs: () => (photos ? photos.idle() : Promise.resolve()),
    resumePhotos: () => (photos ? photos.resume() : Promise.resolve()),
    /**
     * A ready master as C10's paid email carries it, or null: `key` names the upload
     * (stable, for the email's set key) and `url` is the download route on hub-api,
     * signed for 90 days (Slice 9). Never Bunny's own link.
     */
    masterForEmail(versionId) {
      const m = masters ? masters.readyOf(versionId) : null;
      if (!m) return null;
      const { token, expires } = signer.signPath(downloadSignedPath(versionId), DOWNLOAD_LINK_SECONDS);
      return {
        key: `master:${versionId}:${m.tag}`,
        url: `${opts.publicBaseUrl}${downloadSignedPath(encodeURIComponent(versionId))}/${encodeURIComponent(m.name)}?token=${token}&expires=${expires}`,
      };
    },
    /** Whether a download link is genuine and unexpired: for the hub router's route. */
    verifyDownload: (versionId, token, expires) => Boolean(signer) && signer.verifyPath(downloadSignedPath(versionId), token, expires),
    /** Where a download goes: the master on Bunny, signed for one download, or null. */
    downloadTarget: (versionId) => (masters ? masters.linkOf(versionId, { ttlSeconds: DOWNLOAD_REDIRECT_SECONDS }) : null),
    /** The daily cleanup (Slice 11, bunny-cleanup.js), or null when Bunny is off. */
    cleanup,
    async takeOffline(project) {
      if (projectOps.has(project.id)) return { refusal: BUSY };
      projectOps.add(project.id);
      try {
        return await cleanup.takeOffline(project);
      } finally {
        projectOps.delete(project.id);
      }
    },
    bringOnline,
    /** Every master job queued or running, done: for the tests. */
    masterJobs: () => (masters ? masters.idle() : Promise.resolve()),
    resumeMasters: () => (masters ? masters.resume() : Promise.resolve()),
  };
}

module.exports = { createBunnyPublisher, UNLISTED_VIDEO_LIMIT_MS, SOURCE_TTL_SECONDS, DOWNLOAD_LINK_SECONDS };
