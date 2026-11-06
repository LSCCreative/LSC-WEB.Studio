'use strict';

/* The "app has been updated" banner (merge task M4).
 *
 * The server stamps every script with its contents, so a reload always runs
 * the current files. But the admin never reloads on its own: a tab left open
 * across a deploy would keep pricing with the calc.js it loaded, while the
 * server prices with the new one. So the page carries its version (a meta tag
 * the server fills in, server/src/web.js) and every /api reply carries the
 * current one; when they differ, this offers a reload. It never reloads by
 * itself: Reload goes through the browser's unsaved-edits question
 * (js/unsaved.js's beforeunload), so nothing typed is lost unasked.
 *
 * Served any other way (the old two-origin setup) the meta tag is empty and
 * the replies carry no version, and this does nothing.
 */

const UpdateBanner = (() => {
  const meta = document.querySelector('meta[name="lsc-version"]');
  const mine = meta ? meta.getAttribute('content') : '';
  const root = document.getElementById('update-banner');
  const reload = document.getElementById('update-banner-reload');
  let shown = false;

  function show() {
    if (shown || !root) return;
    shown = true;
    root.classList.add('show');
  }

  if (mine && root) {
    LSCApi.onVersion((current) => {
      if (current !== mine) show();
    });
    reload.addEventListener('click', () => window.location.reload());
  }

  return { isShown: () => shown };
})();
