'use strict';

/* Needs you (merged-admin R5; IA "Needs you"): the queue of what is waiting on
 * the studio. Two places show it, from one fetch: the count beside the account
 * menu (every screen, both tabs) and the card that leads the Dashboard.
 *
 * The server works the queue out fresh each time (GET /api/needs), so an item
 * is gone the moment the thing behind it is resolved. This file only asks again:
 * on every screen change (refresh(), from app.js) and when the Dashboard draws.
 * A failed ask keeps the count it had and says so on the Dashboard; it never
 * shows a made-up zero.
 *
 * Each row opens where you act. A kind this file has no words for yet (a later
 * task's) still shows, under its own name, and opens the project.
 */

const LSCNeeds = (() => {
  const { esc, money } = LSCUtil;

  const KINDS = {
    deemed_approval: { label: 'Approval due', tone: 'alert' },
    paid_claim: { label: 'Says paid', tone: 'info' },
    revision_notes: { label: 'Revision notes', tone: 'info' },
    final_invoice: { label: 'Send final invoice', tone: 'info' },
    publish_failed: { label: 'Publish failed', tone: 'alert' },
    invoice_overdue: { label: 'Invoice overdue', tone: 'alert' },
    quote_awaiting: { label: 'Quote awaiting reply', tone: 'info' },
    no_upid: { label: 'No UPID', tone: 'alert' },
    new_project: { label: 'New project', tone: 'info' },
  };

  let last = null; // the last good reply { items, count }
  let failed = false; // the last ask failed
  let seq = 0;
  let listeners = [];

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const ago = (n) => (n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago');

  function pathOf(item) {
    const project = '/projects/' + encodeURIComponent(item.projectId);
    if (item.invoiceId) return InvoiceView.pathOf(item.projectId, item.invoiceId);
    // Revision notes open the item they're on, where the studio reads them (C4).
    if (item.itemId) return project + '/deliverables/' + encodeURIComponent(item.itemId);
    return item.kind === 'new_project' ? project + '/deliverables' : project;
  }

  function metaOf(item) {
    switch (item.kind) {
      case 'invoice_overdue':
        return [item.number, plural(item.days, 'day') + ' overdue'];
      case 'quote_awaiting':
        return ['Sent ' + ago(item.days)];
      case 'no_upid':
        return ['Accepted without a UPID'];
      case 'new_project':
        return ['Accepted, not opened yet'];
      case 'revision_notes':
        // On a Final, its round; past the included ones it's extra work to quote first (C5).
        return [item.title, plural(item.notes, 'note') + ' sent ' + ago(item.days),
          item.extraRound ? 'Round ' + item.round + ', past the ' + item.included + ' included: quote first'
            : item.round ? 'Round ' + item.round + ' of ' + item.included : ''];
      case 'deemed_approval':
        // Past the client's 14 business days on a Final; the item page has Mark approved (C7).
        return [item.title + ' v' + item.n, 'No reply in 14 business days', item.days > 0 ? 'due ' + ago(item.days) : 'due today'];
      case 'publish_failed':
        // Bunny's reason, in the words bunny-publish.js stored; the item has Send to Bunny again.
        return [item.title + ' v' + item.n, item.error];
      case 'final_invoice':
        // No date when the old hub signed it off (R4): it isn't "today".
        return [typeof item.days === 'number' ? 'Everything approved ' + ago(item.days) : 'Everything approved'];
      default:
        return [];
    }
  }

  function rowMarkup(item) {
    const words = KINDS[item.kind] || { label: String(item.kind).replace(/_/g, ' '), tone: 'neutral' };
    const title = item.name || item.client || 'Untitled';
    const meta = [item.client && item.client !== title ? item.client : '', item.upid, ...metaOf(item)].filter(Boolean);
    return '<li><a class="dash-row" href="#' + esc(pathOf(item)) + '">' +
      '<div class="dash-row-main"><span class="dash-row-name">' + esc(title) + '</span>' +
      '<span class="dash-row-meta' + (item.kind === 'invoice_overdue' ? ' is-alert' : '') + '">' +
      meta.map(esc).join(' · ') + '</span></div>' +
      '<div class="dash-row-end is-stacked">' +
      (typeof item.amount === 'number' ? '<span class="dash-row-amt fig">' + money(item.amount) + '</span>' : '') +
      '<span class="pf-chip is-' + words.tone + '">' + esc(words.label) + '</span></div></a></li>';
  }

  /* The card's body: the rows, the empty line, or the failure with its retry. */
  function bodyMarkup() {
    if (!last) {
      return failed
        ? '<p class="home-empty">Couldn’t load what needs you.</p>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-needs-retry>Try again</button>'
        : '<p class="home-empty">Loading…</p>';
    }
    const stale = failed
      ? '<p class="home-empty is-alert">Couldn’t refresh this just now, so this may be out of date.</p>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-needs-retry>Try again</button>'
      : '';
    return (last.items.length
      ? '<ul class="dash-rows">' + last.items.map(rowMarkup).join('') + '</ul>'
      : '<p class="home-empty">Nothing needs you.</p>') + stale;
  }

  function drawHeader() {
    const link = document.getElementById('needs-link');
    if (!link) return;
    link.hidden = !last;
    if (!last) return;
    document.getElementById('needs-count').textContent = last.count;
    link.classList.toggle('is-clear', last.count === 0);
    link.setAttribute('aria-label', last.count === 0 ? 'Needs you: nothing waiting' : 'Needs you: ' + plural(last.count, 'item') + ' waiting');
  }

  /* Ask again. Several asks at once are fine: only the newest one is believed. */
  async function refresh(onAuthLost) {
    const mine = ++seq;
    let reply;
    try {
      reply = await LSCApi.get('/api/needs?today=' + LSCUtil.today());
    } catch (err) {
      if (!(err instanceof LSCApi.ApiError)) throw err;
      if (mine !== seq) return;
      if (err.kind === 'auth') return onAuthLost && onAuthLost();
      failed = true;
      listeners.forEach((fn) => fn());
      return;
    }
    if (mine !== seq) return;
    failed = false;
    last = { items: reply.items || [], count: Number.isInteger(reply.count) ? reply.count : (reply.items || []).length };
    drawHeader();
    listeners.forEach((fn) => fn());
  }

  /* The Dashboard's card, ready to drop in. bind() wires it after it is on the page. */
  function cardMarkup() {
    return '<section class="dash-card dash-needs" id="dash-needs" aria-labelledby="dash-needs-h">' +
      '<div class="dash-card-head"><div class="dash-card-titles">' +
      '<h2 class="dash-card-title" id="dash-needs-h">Needs you</h2>' +
      '<p class="dash-card-sub" id="dash-needs-sub"></p></div></div>' +
      '<div class="dash-card-body" id="dash-needs-body"></div></section>';
  }

  /* Keeps the card in `root` drawn until it leaves the page; returns nothing to undo. */
  function bind(root, onAuthLost) {
    const draw = () => {
      const body = root.querySelector('#dash-needs-body');
      if (!body || !body.isConnected) {
        listeners = listeners.filter((fn) => fn !== draw);
        return;
      }
      body.innerHTML = bodyMarkup();
      root.querySelector('#dash-needs-sub').textContent = last && last.count ? last.count + ' waiting' : '';
      const retry = body.querySelector('[data-needs-retry]');
      if (retry) {
        retry.addEventListener('click', () => {
          body.innerHTML = '<p class="home-empty">Loading…</p>';
          refresh(onAuthLost);
        });
      }
    };
    listeners.push(draw);
    draw();
    refresh(onAuthLost);
  }

  return { refresh, cardMarkup, bind, pathOf };
})();
