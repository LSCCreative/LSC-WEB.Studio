# Feature Spec

> Ephemeral intake file for the CURRENT feature only. Overwritten each time a
> new feature starts. Do not accumulate history here — that belongs in git.

## Feature Name & Goal

**Bunny delivery layer** — the NAS stays the master archive, Bunny becomes the
client-facing copy, and Client Hub plays/serves from Bunny.

```
Desktop widget ──► NAS (master files, client-hub-api holds the Bunny keys)
                     │  publish
                     ▼
               Bunny Stream (video, HLS)  +  Bunny Edge Storage (photos, masters)
                     │  CDN
                     ▼
               Client Hub (review → approve → agreement → final delivery)
```

Why: today clients stream the raw master straight off the office upload link
(no adaptive bitrate), photo grids load full-size JPGs scaled by CSS, every
file URL is permanent, and delivery dies whenever the NAS or office internet
does. Publishing is manual (SMB drop + NAS LINK).

Background: Bunny Stream was cancelled in Sept (`23da500`, `c6ae678`) and a
"migrate the database to Bunny" slice was dropped on 2026-10-17 — the NAS
stays the backend. This feature is the user's specific new ask: **Bunny for
client-facing media delivery only.** Records, auth, agreements and the
SQLite DB stay on the NAS, unchanged.

---

## Non-negotiable: the review player contract

The user's words: the player is huge to maintain — the client pausing, the
app stamping the time, and a field to write the revision is the most
important part of the review stage.

So **the player stays our own `<video id="asset-video">`**. No Bunny iframe
embed, no third-party player UI. Bunny only changes where the bytes come
from: hls.js attaches the HLS stream to the same element (Safari/iOS use
native HLS). Every existing behaviour keeps working because it's all driven
off that element's events and `currentTime`:

1. Pausing before `COMMENT REVISIONS` is clicked shows no timestamp pill.
2. Clicking `COMMENT REVISIONS` while parked on a frame stamps that frame;
   pausing again while the panel is open re-stamps it; playing clears it.
3. `SUBMIT REVISION` saves `{text, timestamp}`, leaves the panel open with an
   empty box, and the video does not reload or jump to 0
   (`refreshAssetInteraction()` only repaints `#asset-interaction`).
4. `APPROVE CONTENT` is absent while the revision panel is open.
5. A video that can't load falls back to the Google Drive card
   (`state.videoFailed`).
6. Timestamps are accurate to the frame the client is looking at (HLS
   `currentTime` == the same timeline as the source file).

**Every [WEB] slice must re-run this checklist** on desktop Chrome, desktop
Safari and an iPhone-width viewport before it's marked done. A slice that
breaks any item is not done.

Relevant code today: `renderVideoCanvas` (~L1340), `bindClientAsset`
(~L1984), `setPausePill` (~L2140), `bindAssetInteraction` (~L2157),
`refreshAssetInteraction` (~L1338).

---

## Decisions

### Player (HLS into the existing element)
- hls.js from a CDN, **exact pinned version**, loaded only by
  `client-hub-app/index.html`.
- One helper, `attachReviewSource(video, url)`: `.m3u8` + native HLS
  support → set `src`; `.m3u8` + `Hls.isSupported()` → hls.js; anything else
  → plain `src` (so existing projects on NAS `/hub/files/` links keep
  working untouched).
- Exactly one live `Hls` instance; destroy it before attaching a new one and
  whenever the asset screen is left or re-rendered — no leaked instances.
- hls.js fatal errors try one recovery, then route to the same
  `videoFailed` path as `video.onerror`.
- Keep `controlsList="nodownload"`, `disablePictureInPicture`, and the
  context-menu block.

### Linking widget ↔ editor: by NAS path
Admin project data lives in the admin browser's `localStorage`; the NAS only
sees published records. So nothing outside the editor can write into an
asset. The link between "published to Bunny" and "this asset" is the **NAS
relative path** — the same `deliverablePath` the editor already stores and
the same key `deliverable_tokens` uses. Publishing is idempotent per path:
the widget publishes a path, and the editor asking about that same path gets
the existing result back instantly.

### NAS API (`nas/client-hub-api`)
- New `src/bunny.js`: the only file that talks to Bunny. Native `fetch`, no
  SDK, no new npm deps.
- New table `bunny_assets` (`relative_path`, `kind` video|photo|master,
  `bunny_video_id` / `storage_path`, `collection_id`, `status`,
  `error`, timestamps; UNIQUE on `relative_path, kind`). Plus
  `bunny_collections` (project folder name → Stream collection id).
- Video publish = Stream **fetch-from-URL**: the NAS mints (or reuses) the
  existing `/hub/files/<token>` URL and Bunny pulls it. No upload code, no
  laptop has to stay awake. Fall back to a server-side PUT/TUS only if fetch
  turns out not to support collections or hits limits (check the OpenAPI
  at `https://video.bunnycdn.com/openapi/bunnynet-video-api.public.json`
  before coding).
- One Stream collection per project, named after the top-level NAS project
  folder.
- Photos and video masters → Edge Storage via `PUT`, streamed from the
  read-only deliverables mount at `/<project folder>/<file path>`.
- Status: Stream webhook (`POST /hub/bunny-webhook`, HMAC-SHA256 over the
  raw body with the library's read-only key, constant-time compare) plus a
  polling route for the editor and the widget.
- The deliverables mount stays **read-only**. The NAS never writes media.

### Client Hub data model
Video asset gains `bunnyVideoId`, `posterLink`, `publishStatus`.
`reviewLink` becomes the Bunny HLS URL, and `downloadLink` the Edge Storage
master URL. Photos keep `{name, reviewLink, downloadLink}`, where
`reviewLink` is the CDN URL without size params (the UI adds them).
`buildPublishedRecord` whitelist and the `loadProjects` normaliser must carry
the new fields.

### Photos
Bunny Optimizer on the storage pull zone: grid `?width=600`, lightbox
`?width=2400`, download = original. Replaces CSS-scaled full-size JPGs.

### Security (late slice)
Token authentication on both pull zones. Records store **unsigned** Bunny
URLs; `GET /hub/records/:projectId` signs them on the way out (HLS needs a
directory/path token so every segment under `/<videoId>/` is covered).
Gated downloads (`gated !== false` and no signed agreement) are **omitted
server-side**, not just hidden in the UI. Long enough TTL for a review
session. On a 403 mid-session the player re-fetches the record and resumes
at the same `currentTime`.

### Desktop widget
macOS menu-bar app (SwiftUI `MenuBarExtra`) in a new `desktop-publisher/`
folder. Drag a file/folder on → if it's not already on the mounted NAS share,
copy it into the chosen project folder there first → call the publish route
→ show progress → copy the NAS path to the clipboard for the editor. Logs in
with the existing admin email + PIN (`/hub/admin-auth`). Holds no Bunny key.

### Secrets
Bunny keys live in a 1Password Environment and the NAS `.env` only:
`BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READ_KEY`,
`BUNNY_STREAM_CDN_HOST`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`,
`BUNNY_STORAGE_HOST`, `BUNNY_STORAGE_CDN_HOST`, `BUNNY_CDN_TOKEN_KEY`
(names only — never values in repo, chat or logs). Never in
`client-hub-app`, the widget, or `docker-compose.yml` (it's mirrored to a
public repo).

---

## Acceptance Criteria

1. The **player contract** above passes on an HLS asset on desktop Chrome,
   desktop Safari and iPhone Safari, and on an old NAS-linked asset.
2. Publishing a NAS video path gets a playable Bunny HLS asset in the
   project's collection; the editor shows Processing → Ready (or Failed with
   the reason), and re-publishing the same path doesn't create a duplicate.
3. A photo folder publishes to Edge Storage; the client grid loads resized
   thumbnails and the lightbox loads a screen-sized image, and the download is
   the untouched original.
4. Final delivery downloads the original master (incl. 4K) from Bunny.
5. With token auth on, a copied media URL stops working after its TTL, a
   gated download is absent from the record until the agreement is signed,
   and an expiry mid-review doesn't lose the playhead or the revision draft.
6. The widget publishes a dragged folder end to end without the admin opening
   the NAS share or the browser.
7. No Bunny key appears in any tracked file, the client app or the widget.
8. Existing projects on NAS links keep working with no migration.

## Out of Scope

- Moving records, auth, agreements or the DB off the NAS.
- Separate watermarked "Review" vs clean "Final" Stream libraries (good
  follow-up once this lands).
- Auto-captions, Stream view statistics, chapters.
- Zipped photo-library downloads.
- Uploading from the browser editor (publish is NAS-side only).
- Migrating existing NAS-linked projects to Bunny.
