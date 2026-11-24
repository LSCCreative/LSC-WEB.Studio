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
  assert.match(page, /attachReviewSource\(video, video\.dataset\.src, videoFailed\)/);
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
