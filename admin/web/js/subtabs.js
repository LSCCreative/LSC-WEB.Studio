'use strict';

/* Sub-tabs inside a record (merged-admin R2; IA "Component Reuse Map": a client,
 * and from R3 a project). Real tabs, whose panels are addresses.
 *
 * Manual activation, as the shell's area tabs (js/shell.js) and for the same
 * reason: an arrow press only moves focus, because activating one is a route,
 * and a route can put up the unsaved-edit prompt. Enter or Space goes there.
 *
 * The screen keeps these tabs on the page across a move between them and redraws
 * only the panel, so focus stays on the tab that was chosen. mark() says which
 * tab the address now names.
 */

const LSCSubTabs = (() => {
  const { esc } = LSCUtil;

  /* `tabs` is [{ id, label, path }]; `panelId` the id of the panel they control. */
  function markup({ label, tabs, current, panelId }) {
    return (
      '<div class="subtabs" role="tablist" aria-label="' + esc(label) + '">' +
      tabs.map((t) => {
        const on = t.id === current;
        return (
          '<button type="button" class="subtab" role="tab" id="subtab-' + esc(t.id) + '"' +
          ' data-tab="' + esc(t.id) + '" data-path="' + esc(t.path) + '"' +
          ' aria-controls="' + esc(panelId) + '" aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '">' +
          esc(t.label) + '</button>'
        );
      }).join('') +
      '</div>'
    );
  }

  /* On a phone the row scrolls sideways; the chosen tab is brought into it. */
  function reveal(row, tab) {
    if (!tab || row.scrollWidth <= row.clientWidth) return;
    const left = tab.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + tab.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, left - 16);
    }
  }

  function mark(container, current) {
    const row = container.querySelector('.subtabs');
    if (!row) return;
    let chosen = null;
    row.querySelectorAll('.subtab').forEach((tab) => {
      const on = tab.dataset.tab === current;
      if (on) chosen = tab;
      tab.setAttribute('aria-selected', String(on));
      tab.setAttribute('tabindex', on ? '0' : '-1');
    });
    reveal(row, chosen);
  }

  function bind(container) {
    const row = container.querySelector('.subtabs');
    if (!row) return;
    const tabs = () => Array.from(row.querySelectorAll('.subtab'));
    row.addEventListener('click', (e) => {
      const tab = e.target.closest('.subtab');
      if (tab) LSCRouter.go(tab.dataset.path);
    });
    row.addEventListener('keydown', (e) => {
      const all = tabs();
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % all.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + all.length) % all.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = all.length - 1;
      if (n === null) return;
      e.preventDefault();
      all.forEach((t, k) => t.setAttribute('tabindex', k === n ? '0' : '-1'));
      all[n].focus();
    });
    // Focus leaving the row puts the roving stop back on the chosen tab.
    row.addEventListener('focusout', (e) => {
      if (row.contains(e.relatedTarget)) return;
      const chosen = tabs().find((t) => t.getAttribute('aria-selected') === 'true') || tabs()[0];
      tabs().forEach((t) => t.setAttribute('tabindex', t === chosen ? '0' : '-1'));
    });
  }

  return { markup, mark, bind };
})();
