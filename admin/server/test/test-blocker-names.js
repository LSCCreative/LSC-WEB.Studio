'use strict';
/* Ad blockers hide elements by name on every site, whatever the site is. The
   day dialog's form was .ad-box: EasyList hid it, and a click on the calendar
   left only the dark backdrop. So no class, id or anything else in the frontend
   starts with these words. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', '..', 'web');
const BLOCKED = /(^|[^A-Za-z0-9_-])(ads?|advert|sponsor)-/;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(js|css|html)$/.test(e.name) ? [p] : [];
  });
}

test('no frontend name starts with a word ad blockers hide', () => {
  const hits = [];
  sources(WEB).forEach((file) => {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (BLOCKED.test(line)) hits.push(path.relative(WEB, file) + ':' + (i + 1) + ' ' + line.trim());
    });
  });
  assert.deepEqual(hits, []);
});
