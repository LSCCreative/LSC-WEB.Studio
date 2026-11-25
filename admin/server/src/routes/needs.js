'use strict';

/**
 * GET /api/needs?today= (merged-admin R5): the Needs you queue, `{ items, count }`,
 * in the IA's order. Read fresh each time (src/needs.js), so an item is gone the
 * moment what it asks for is done. The header's count and the Dashboard's rows
 * both come from here.
 */

const { readNeeds } = require('../needs');
const { readProjectRows, projectBriefs, todayOf } = require('./projects');

function registerNeedsRoutes(app, db) {
  app.get('/api/needs', (req, res) => {
    const today = todayOf(req);
    if (!today) return res.status(400).json({ error: 'today_invalid' });
    const items = readNeeds(db, { today, briefs: projectBriefs(db), rows: readProjectRows(db, { today }) });
    res.json({ items, count: items.length });
  });
}

module.exports = { registerNeedsRoutes };
