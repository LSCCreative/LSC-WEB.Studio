'use strict';

/* The Client Portal's page (merged-admin C2), read as files: it has no build
 * step and no test runner of its own, so the rules that keep it safe and on
 * the shared tokens are checked here, beside the routes it calls.
 *   S6   no unpinned third-party script, and no styling script at all
 *   one token file, copied at deploy: never kept in git, every token it reads exists
 *   11px minimum, and the admin's code is gone
 *   the player's partial repaint: the <video> lives outside what a revision repaints */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
/* These are the website's files, beside admin/ in the repo. A copy of admin/ on
   its own (the NAS's) has none of them, and skips this file rather than failing. */
const SKIP = !fs.existsSync(path.join(ROOT, 'client-hub-app', 'index.html')) && 'the portal page isn’t beside this copy of admin/';
const read = (p) => (SKIP ? '' : fs.readFileSync(path.join(ROOT, p), 'utf8'));
const page = read('client-hub-app/index.html');
const tokens = read('admin/web/css/tokens.css');
const workflow = read('.github/workflows/deploy-pages.yml');
const copier = read('scripts/copy-portal-tokens.sh');
const check = (name, fn) => test(name, { skip: SKIP }, fn);

/* The body of one top-level function in the page's script: up to its closing
   brace, the first one at the start of a line. */
function fnBody(name) {
  const start = page.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the page`);
  return page.slice(start, page.indexOf('\n}\n', start) + 2);
}

check('S6: no styling script, and every third-party script is pinned with its hash', () => {
  assert.doesNotMatch(page, /tailwind/i);
  assert.doesNotMatch(page, /<script[^>]+src=/i, 'no script tag loads anything');
  // hls.js is the one script fetched, on demand: an exact version and an integrity hash.
  const urls = page.match(/https:\/\/cdn\.[^'"\s]+/g) || [];
  assert.deepEqual(urls, ['https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.light.min.js']);
  assert.match(page, /integrity: 'sha384-[\w+/=]{64}'/);
  assert.doesNotMatch(page, /fonts\.googleapis|fonts\.gstatic/);
});

check('the portal reads the admin’s tokens, copied at deploy, and every token it names exists', () => {
  assert.match(page, /<link rel="stylesheet" href="css\/tokens\.css">/);
  assert.match(copier, /cp admin\/web\/css\/tokens\.css client-hub-app\/css\/tokens\.css/);
  // The fonts tokens.css points the portal at (../fonts/ from css/).
  for (const font of tokens.match(/url\('\.\.\/fonts\/[^']+'\)/g).map((u) => u.slice(14, -2))) {
    if (/Metro/.test(font)) continue; // the client pages' face; the portal never names it
    assert.ok(copier.includes(`admin/web/fonts/${font}`), `${font} is copied`);
    assert.ok(fs.existsSync(path.join(ROOT, 'admin/web/fonts', font)), `${font} exists`);
  }
  // Copied before the site is put together, so the copy is what's published.
  const copyAt = workflow.indexOf('sh scripts/copy-portal-tokens.sh');
  assert.ok(copyAt > 0 && copyAt < workflow.indexOf('cp -R'), 'the workflow copies the tokens first');
  assert.match(workflow, /cp -R [^\n]*client-hub-app _site\//);
  assert.doesNotMatch(workflow, /cp -R [^\n]*\bscripts\b/, 'the script itself isn’t published');
  const ignored = read('.gitignore');
  assert.match(ignored, /^client-hub-app\/css\/$/m);
  assert.match(ignored, /^client-hub-app\/fonts\/$/m);

  const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...page.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], 'every var() the portal reads is in tokens.css');
  assert.doesNotMatch(page, /--lsc-/, 'the hub’s own colour names are gone');
});

check('nothing on the portal is smaller than 11px', () => {
  const sizes = [...page.matchAll(/font-size\s*:\s*([\d.]+)(px|rem|em)\b/g)];
  for (const [whole, n, unit] of sizes) {
    const px = unit === 'px' ? Number(n) : Number(n) * 16;
    assert.ok(px >= 11, `${whole} is under 11px`);
  }
  assert.doesNotMatch(page, /text-\[(?:[0-9]|10)px\]/, 'no leftover utility sizes');
  // Every size the page reads from the tokens is one of the scale's, all 11px and up.
  for (const [, name] of page.matchAll(/font-size:\s*var\((--font-size-[\w]+)\)/g)) {
    const value = new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens);
    assert.ok(value && Number(value[1]) >= 11, name);
  }
});

check('the admin’s code is gone, and its door leads to the admin', () => {
  for (const gone of ['/hub/admin-auth', '/hub/publish', '/hub/records', '/hub/notify', 'renderTracker', 'renderEditor', 'renderLock',
    'impersonat', 'localStorage', 'sessionStorage', 'emailService', 'clientCode', 'inviteToken', 'SIMULATE']) {
    assert.ok(!page.includes(gone), `${gone} is still in the page`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'client-hub-app/emailService.js')), 'the email stub went with it');
  // ?admin=1 goes to Scope & Sales before anything else runs.
  const head = page.slice(0, page.indexOf('</head>'));
  assert.match(head, /get\('admin'\) === '1'\) location\.replace\('https:\/\/app\.lsccreative\.studio\/'\)/);
});

check('the portal signs in through the server’s session, holding no token of its own', () => {
  assert.match(fnBody('api'), /credentials: 'include'/);
  for (const route of ["'/hub/auth'", "'/hub/session'", "'/hub/invite'", "'/hub/sign-out'", "'/hub/projects'"]) {
    assert.ok(page.includes(route), `${route} is called`);
  }
  // The invite comes in the fragment (or the old hub's ?invite=) and leaves the address bar.
  const boot = fnBody('boot');
  assert.match(boot, /#\\\/invite\\\//);
  assert.match(boot, /history\.replaceState/);
  assert.match(page, /edgeBase: [^\n]*'https:\/\/hub-api\.lsccreative\.studio'/);
  // A working invite is read before the session, so it can end someone else's sign-in on a shared computer.
  assert.ok(boot.indexOf("'/hub/invite'") < boot.indexOf("'/hub/session'"), 'the invite comes first');
  assert.match(boot, /'\/hub\/sign-out'/);
  // Signing out says so only once the server has ended the session.
  assert.match(fnBody('signOut'), /catch\(_\)\{[^}]*toast\([^)]*\);\s*return;/);
  // A video that fails asks whether the session ended before showing the broken-video card.
  assert.match(fnBody('videoFailed'), /'\/hub\/session'[\s\S]*401[\s\S]*signedOut/);
  assert.match(page, /attachReviewSource\(video, video\.dataset\.src, \(info\) => relinkVideo\(video, a\.id, info\)\)/);
});

check('a review link that ran out is renewed in place, once, before the failure card (Bunny Slice 9)', () => {
  const relink = fnBody('relinkVideo');
  // Once per link, then the old path (which checks the session).
  assert.match(relink, /relinkedFrom === failed\)\{ relinking = null; return videoFailed\(\); \}/);
  // The project is asked for again, and only the same version's new link is taken.
  assert.match(relink, /await freshAssetOf\(project\.id, assetId\)/);
  assert.match(fnBody('freshAssetOf'), /api\('\/hub\/projects\/' \+ encodeURIComponent\(projectId\)\)/);
  assert.match(relink, /fresh\.versionId !== a\.versionId[\s\S]{0,160}return videoFailed\(\);/);
  // The same <video>, at the same time, playing or paused as it was: no render().
  assert.doesNotMatch(relink, /render\(|setState\(/);
  assert.match(relink, /video\.currentTime = at/);
  assert.match(relink, /if\(playing\) video\.play\(\)/);
  assert.match(relink, /attachReviewSource\(video, fresh\.reviewLink, \(info\) => relinkVideo\(video, assetId, info\)\)/);
  // hls.js hands over the playhead before anything resets the element, and tears nothing down itself.
  const hls = fnBody('attachHls');
  assert.match(hls, /onFail\(\{ at: video\.currentTime \|\| 0, playing: !video\.paused && !video\.ended \}\)/);
  assert.doesNotMatch(hls.slice(hls.indexOf('const fatal')), /detachReviewSource\(\)|hls\.destroy\(\)/);
  // The swap's own pause never stamps the pill.
  assert.match(fnBody('bindClientAsset'), /if\(video === relinking\) return;/);
  // Renewed before it runs out (an iPhone's player can stall without an error), and again
  // in a minute if the server can't give a new one yet; a thrown-away <video> takes its timer.
  assert.match(fnBody('bindClientAsset'), /scheduleRenewal\(video, a\.id\);/);
  assert.match(fnBody('scheduleRenewal'), /expires - Date\.now\(\) - RENEW_EARLY_MS/);
  assert.match(relink, /if\(early\) return scheduleRenewal\(video, assetId, 60 \* 1000\);/);
  assert.match(relink, /scheduleRenewal\(video, assetId\);\s*\}$/);
  assert.match(fnBody('detachReviewSource'), /clearTimeout\(renewTimer\)/);
  // Try again reads the project first and opens the once-per-link renewal again.
  assert.match(fnBody('bindClientAsset'), /retry\.onclick = \(\) => retryVideo\(a\.id, retry\)/);
  const retry = fnBody('retryVideo');
  assert.match(retry, /relinkedFrom = null;[\s\S]*freshAssetOf\([\s\S]*setState\(\{ videoFailed:false \}\)/);
  assert.match(retry, /fresh\.versionId === live\.versionId/);
  // A client who left the video meanwhile is left alone.
  assert.match(relink, /if\(reviewVideo !== video \|\| video\.dataset\.src !== failed\)\{ if\(!early\) relinking = null; return; \}/);
});

check('a photo whose signed Bunny link ran out is renewed once before the NAS copy (Bunny Slice 9)', () => {
  const fb = fnBody('photoFallback');
  // Only a link that has run out is renewed, once per image; anything else goes to the NAS as before.
  assert.match(fb, /nas && !img\.dataset\.renewed && expires && expires <= Date\.now\(\)/);
  assert.match(fb, /renewPhotoLinks\(\)\.then/);
  assert.match(fb, /if\(nas\)\{ img\.removeAttribute\('data-nas'\); img\.src = nas; return; \}/);
  // One read of the project for a burst of failing tiles, matched by each photo's NAS link.
  const renew = fnBody('renewPhotoLinks');
  assert.match(renew, /if\(!photoRenewal\)/);
  assert.match(renew, /byLink\.get\(ph\.reviewLink\)/);
  assert.match(fnBody('photoImg'), /data-ph="\$\{escapeAttr\(ph\.reviewLink\)\}" data-size="\$\{size\}"/);
});

check('the review player plays inline on an iPhone (the user, 2026-11-27)', () => {
  // Without playsinline every iPhone play goes full screen and the client must leave it to comment.
  // The attribute, wherever it sits in the tag: reordering the tag mustn't fail this.
  const tag = (/<video id="asset-video"[^>]*>/.exec(fnBody('renderVideoCanvas')) || [''])[0];
  assert.ok(tag, 'the review player is built in renderVideoCanvas');
  assert.match(tag, /\splaysinline(?=[\s>])/);
});

check('the player survives a revision: the <video> sits outside the partial repaint', () => {
  const interaction = fnBody('renderAssetInteraction');
  assert.doesNotMatch(interaction, /<video|asset-video|pause-pill/, 'the repainted part never builds the player');
  assert.match(fnBody('renderVideoCanvas'), /<video id="asset-video"/);
  assert.match(fnBody('renderVideoCanvas'), /id="pause-pill"/);
  const refresh = fnBody('refreshAssetInteraction');
  assert.match(refresh, /getElementById\('asset-interaction'\)/);
  assert.doesNotMatch(refresh, /render\(\)|setState/);
  // What a revision does never re-renders the screen.
  const bind = fnBody('bindAssetInteraction');
  const revisionHandlers = bind.slice(bind.indexOf("'want-revisions'"));
  assert.doesNotMatch(revisionHandlers, /setState|render\(\)/);
  // The lightbox repaints only its own host.
  assert.match(fnBody('refreshLightbox'), /getElementById\('lightbox-host'\)/);
  assert.doesNotMatch(fnBody('refreshLightbox'), /render\(\)|setState/);
});

check('the portal’s addresses: dashboard, project, review and photo, by id (C3)', () => {
  // parseRoute runs as the page runs it.
  const parseRoute = new Function(`${fnBody('parseRoute')}; return parseRoute;`)();
  assert.deepEqual(parseRoute(''), { name: 'dashboard' });
  assert.deepEqual(parseRoute('#/'), { name: 'dashboard' });
  assert.deepEqual(parseRoute('#/nonsense/here'), { name: 'dashboard' }, 'an unknown address is the dashboard');
  assert.deepEqual(parseRoute('#/p/prj_1'), { name: 'project', projectId: 'prj_1' });
  assert.deepEqual(parseRoute('#/p/prj%201/'), { name: 'project', projectId: 'prj 1' });
  assert.deepEqual(parseRoute('#/p/prj_1/d/dlv_2'), { name: 'review', projectId: 'prj_1', itemId: 'dlv_2', photo: null });
  assert.deepEqual(parseRoute('#/p/prj_1/d/dlv_2/3'), { name: 'review', projectId: 'prj_1', itemId: 'dlv_2', photo: 3 });
  assert.deepEqual(parseRoute('#/invite/abc'), { name: 'invite' });
  // Signed out, the address is kept for after sign-in: route() waits for a client.
  assert.match(fnBody('route'), /if\(!state\.client\) return;/);
  // Photos move in place, so Back leaves the deliverable rather than walking the photos.
  assert.match(fnBody('photoAddress'), /history\.replaceState/);
});

check('a project is read fresh on arrival, and its approvals are the server’s (C5)', () => {
  // Nothing the page decided on its own survives a read: approval comes from the version's record.
  assert.doesNotMatch(page, /function carryOver/);
  assert.match(fnBody('portalProject'), /approvedAt: v\.approvedAt \|\| null/);
  assert.match(fnBody('loadProject'), /fresh\.loadedAt = Date\.now\(\)/);
  // Only the project already on screen, read within the minute, is used as it is.
  assert.match(fnBody('loadProject'), /state\.project === held && Date\.now\(\) - held\.loadedAt < PROJECT_FRESH_MS/);
  // CONFIRM APPROVAL posts to the server and marks nothing approved until it answers.
  const bind = fnBody('bindClientAsset');
  const approve = bind.slice(bind.indexOf("'confirm-approve'"), bind.indexOf("'confirm-send'"));
  assert.match(approve, /await api\('\/hub\/projects\/'[^;]*'\/approve'/);
  assert.ok(approve.indexOf('await api') < approve.indexOf('a.approvedAt = r.approval.approvedAt'));
  // Its date is Sydney's (S19), and a refusal that can't change on a retry re-reads instead of saying "Try again".
  assert.match(fnBody('renderAssetInteraction'), /fmtSydneyDay\(a\.approvedAt\)/);
  assert.match(approve, /archived: '/);
  assert.match(approve, /not_found: '/);
});

check('the rounds-used notice comes before the note box, and only #asset-interaction repaints for it (C5)', () => {
  const bind = fnBody('bindAssetInteraction');
  const want = bind.slice(bind.indexOf("'want-revisions'"), bind.indexOf("'rounds-back'"));
  assert.match(want, /roundsOut\(a\) && !state\.roundsOk\[a\.versionId\]/);
  assert.ok(want.indexOf('state.roundsNotice = true') < want.indexOf('toggleRevisions()'), 'the notice before the box');
  assert.match(want, /refreshAssetInteraction\(\)/);
  assert.doesNotMatch(want, /setState|render\(\)/);
  // The brief's wording, with the agreement's rate or none.
  assert.match(page, /You’ve used both revision rounds/);
  assert.match(page, /Further revisions are charged at \$\{escapeHtml\(rateWords\(p\)\)\}, and we’ll send you a quote to approve before any work starts\./);
  assert.match(page, /const rateWords = \(p\) => 'our hourly rate' \+ \(p\.hourlyRate \? ' of AUD ' \+ p\.hourlyRate : ''\);/);
});

check('no download anywhere on the portal, and notes are saved on the server as they are added (C4)', () => {
  assert.doesNotMatch(page, /\sdownload[\s=>]/, 'no download attribute');
  assert.doesNotMatch(page, /downloadLink|DOWNLOAD/);
  // Adding a note posts it, and only #asset-interaction repaints (contract point 3).
  const bind = fnBody('bindAssetInteraction');
  const add = bind.slice(bind.indexOf("'submit-revision'"), bind.indexOf("'cancel-revision'"));
  assert.match(add, /await saveNote\(a, \{[^}]*key: state\.noteKey/, 'with its key, so a retry isn’t saved twice');
  assert.match(add, /refreshAssetInteraction\(\)/);
  assert.doesNotMatch(add, /setState|render\(\)/);
  // A failure keeps the text: the draft is cleared only after the save succeeds.
  assert.ok(add.indexOf('await saveNote') < add.indexOf("state.revisionDraft = ''"));
  assert.match(add, /state\.noteError = noteFailure\(e\)/);
  // Approve is off while notes are unsent.
  assert.match(fnBody('renderAssetInteraction'), /unsent\.length \? 'disabled/);
});

check('a video on Bunny Stream shows its poster and plays through the same player (Bunny Slice 4)', () => {
  // The poster comes only with an HLS review, and the review link is the reply's url either way.
  assert.match(fnBody('portalProject'), /poster: \(!photo && review && review\.type === 'hls' && review\.poster\) \|\| ''/);
  assert.match(fnBody('portalProject'), /reviewLink: \(!photo && review && review\.url\) \|\| ''/);
  // A card shows the poster as an <img>: no card pulls a playlist or a segment.
  const thumb = fnBody('renderAssetThumb');
  assert.ok(thumb.indexOf('if(a.poster)') < thumb.indexOf('isHlsUrl(a.reviewLink)'));
  assert.match(thumb, /<img src="\$\{escapeAttr\(a\.poster\)\}"[^>]*onerror="this\.remove\(\)"/);
  // The review player is still the one <video id="asset-video">, fed by attachReviewSource.
  assert.match(fnBody('renderVideoCanvas'), /<video id="asset-video"[^>]*\$\{a\.poster \? ` poster="\$\{escapeAttr\(a\.poster\)\}"` : ''\}/);
  assert.match(page, /attachReviewSource\(video, video\.dataset\.src, \(info\) => relinkVideo\(video, a\.id, info\)\)/);
});

check('a photo library on Bunny shows its sizes, keyed and noted as the NAS links are (Bunny Slice 7)', async () => {
  const key = (n) => String(n).repeat(16);
  const url = (n) => `https://hub.example/hub/projects/p/versions/v/review?photo=${key(n)}`;
  const { photosOf, photoSrc } = new Function(`const PHOTO_KEY = /photo=([0-9a-f]{16})/; ${fnBody('photosOf')} ${fnBody('photoSrc')}; return { photosOf, photoSrc };`)();
  // On the NAS only: as before, each photo is its NAS link.
  const nas = photosOf({ urls: [url(1), url(2)] });
  assert.deepEqual(nas.map((ph) => [ph.name, photoSrc(ph, 'grid'), photoSrc(ph, 'full')]),
    [['Photo 1', url(1), url(1)], ['Photo 2', url(2), url(2)]]);
  // All on Bunny: the grid size and the full-screen size, matched by key whatever the order.
  const bunny = photosOf({ urls: [url(1), url(2)], photos: [
    { key: key(2), grid: 'https://cdn.example/b/600/two.jpg', review: 'https://cdn.example/b/2400/two.jpg' },
    { key: key(1), grid: 'https://cdn.example/b/600/one.jpg', review: 'https://cdn.example/b/2400/one.jpg' },
  ] });
  assert.deepEqual(bunny.map((ph) => [ph.reviewLink, photoSrc(ph, 'grid'), photoSrc(ph, 'full')]), [
    [url(1), 'https://cdn.example/b/600/one.jpg', 'https://cdn.example/b/2400/one.jpg'],
    [url(2), 'https://cdn.example/b/600/two.jpg', 'https://cdn.example/b/2400/two.jpg'],
  ], 'the NAS link stays each photo’s identity: notes and drafts go by it');
  // Where each size shows: the grid in the contact sheet and the landing strip, the full one in the lightbox.
  assert.match(fnBody('renderPhotoCanvas'), /<img \$\{photoImg\(ph, 'grid'\)\}/);
  assert.match(fnBody('renderPhotoLightbox'), /<img \$\{photoImg\(ph, 'full'\)\}/);
  assert.doesNotMatch(fnBody('renderPhotoCanvas') + fnBody('renderPhotoLightbox'), /src="\$\{escapeAttr\(ph\.reviewLink\)\}"/);
  assert.match(page, /shots\.map\(ph => `<img \$\{photoImg\(ph, 'grid', true\)\}/);
  // A Bunny size that won't load swaps once to the NAS link; the strip drops it only after that.
  const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  let renewed = null; // what the stubbed project read answers (Slice 9)
  const renewPhotoLinks = () => Promise.resolve(renewed);
  const { photoImg, photoFallback } = new Function('escapeAttr', 'renewPhotoLinks',
    `${fnBody('photoSrc')} ${fnBody('photoImg')} ${fnBody('linkExpiresAt')} ${fnBody('photoFallback')}; return { photoImg, photoFallback };`)(escapeAttr, renewPhotoLinks);
  assert.match(photoImg(bunny[0], 'grid'), /data-nas="https:\/\/hub\.example\/[^"]+photo=1{16}"/);
  assert.doesNotMatch(photoImg(nas[0], 'grid'), /data-nas/, 'a NAS photo has nowhere else to go');
  const attrs = new Map([['data-nas', url(1)], ['data-drop', '']]);
  const img = { src: 'bunny', removed: false, dataset: {}, getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k), remove() { this.removed = true; } };
  photoFallback(img);
  assert.deepEqual([img.src, img.removed], [url(1), false], 'first failure (not an expired link): the NAS copy');
  photoFallback(img);
  assert.equal(img.removed, true, 'the NAS copy failing too: the strip drops it');

  // A signed link that ran out (Slice 9) is renewed first, once, then the NAS copy.
  const expired = 'https://cdn.example/p/600/a.jpg?token=HS256-x&expires=1000';
  const fresh = 'https://cdn.example/p/600/a.jpg?token=HS256-y&expires=9999999999';
  const a2 = new Map([['data-nas', url(1)], ['src', expired]]);
  const img2 = { isConnected: true, dataset: { ph: url(1), size: 'grid' }, getAttribute: (k) => (a2.has(k) ? a2.get(k) : null),
    removeAttribute: (k) => a2.delete(k), hasAttribute: (k) => a2.has(k), remove() {},
    set src(v) { a2.set('src', v); }, get src() { return a2.get('src'); } };
  renewed = new Map([[url(1), { grid: fresh, full: 'f' }]]);
  photoFallback(img2);
  await new Promise((r) => setImmediate(r));
  assert.equal(img2.src, fresh, 'the photo’s fresh link, not the NAS copy');
  photoFallback(img2);
  assert.equal(img2.src, url(1), 'the fresh link failing too: the NAS copy, without asking again');
  // Never the original: the page doesn't read a download from the reply.
  assert.doesNotMatch(fnBody('photosOf'), /download|original/);
});

check('their own PIN: asked after sign-in, typed twice, outside the page, never in a preview', () => {
  const dialog = fnBody('renderPinDialog');
  assert.match(dialog, /field\('pin-new'/);
  assert.match(dialog, /field\('pin-again'/);
  assert.match(dialog, /inputmode="numeric"/);
  assert.match(dialog, /aria-modal="true"/);
  const ask = fnBody('askForPin');
  assert.match(ask, /!state\.preview/, 'a preview never asks');
  assert.match(ask, /\.inert = on/, 'the page behind waits');
  assert.match(page, /<div id="pin-host"><\/div>/, 'outside #app, so a repaint keeps it');
  const save = fnBody('savePin');
  assert.match(save, /one\.value !== two\.value/, 'the two must match');
  assert.match(save, /api\('\/hub\/pin'/);
  assert.match(fnBody('signedOut'), /askForPin\(false\)/);
  assert.match(fnBody('submitSignIn'), /askForPin\(r\.choosePin\)/);
  assert.match(fnBody('boot'), /askForPin\(session\.choosePin\)/);
  // Four digits, and the same obvious ones the server refuses.
  assert.match(page, /const PIN_FORMAT = \/\^\\d\{4\}\$\/;/);
  const commonPins = /const COMMON_PINS = new Set\(\[[^\]]*\]\);/.exec(page);
  assert.ok(commonPins, 'the page lists the common PINs');
  const pageObvious = new Function(`${commonPins[0]} ${fnBody('obviousPin')}; return obviousPin;`)();
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/portal-access.js'), 'utf8');
  assert.equal(/const COMMON_PINS = new Set\(\[[^\]]*\]\);/.exec(serverSrc)[0], commonPins[0], 'the same list as the server’s');
  const { obviousPin } = require('../src/portal-access');
  for (const pin of ['0000', '1234', '9876', '0123', '4826', '1122', '1357', '9090', '5555', '7890', '1212', '3344', '1990', '2024', '1899', '2580', '6969', '9021', '482619', '123456', '111111']) {
    assert.equal(pageObvious(pin), obviousPin(pin), pin);
  }
  assert.doesNotMatch(page, /6 numbers/, 'no copy left from the 6-digit PIN');
  assert.match(fnBody('bindPinDialog'), /slice\(0, 4\)/);
});

check('a 4-digit PIN signs in after a pause, but never on the welcome screen and only once if wrong', () => {
  const bind = fnBody('bindSignIn');
  assert.match(bind, /state\.code\.length === 4 && !state\.invite && !state\.pinAutoMissed/);
  assert.match(bind, /setTimeout\([\s\S]*PIN_AUTO_MS\)/);
  assert.match(fnBody('submitSignIn'), /state\.pinAuto\) state\.pinAutoMissed = true;\s*if\(e\.status === 401\) return/, 'marked before the 401 returns');
  assert.match(fnBody('submitSignIn'), /too_many_today/, 'the day’s cap has its own message');
});
