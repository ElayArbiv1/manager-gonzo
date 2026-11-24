'use strict';
/**
 * Beecomm API connector (stage 2), placeholder until Beecomm provides API access and docs.
 *
 * How to finish it once we get the docs:
 *   1. Put the credentials in the environment: BEECOMM_API_URL, BEECOMM_API_KEY (+ whatever else they give).
 *   2. Implement fetchDay(date) below to call their endpoints for:
 *        - daily totals (Z)           → kind 'sales'
 *        - sales by item              → kind 'items'
 *        - cancellations / voids      → kind 'cancellations'
 *      and return plain row objects using OUR field names (see KINDS in server/importers.js),
 *      e.g. { date: '2026-11-24', amount: 12000, orders: 95, guests: 210 }.
 *   3. Done. sync() feeds them through the same pipeline as files and emails, with source 'beecomm'.
 *      Because imports replace data per source + date range, switching from email to API
 *      for the same days simply overwrites, with no duplicates.
 */
const imp = require('../importers');

const configured = () => Boolean(process.env.BEECOMM_API_URL && process.env.BEECOMM_API_KEY);

// eslint-disable-next-line no-unused-vars
async function fetchDay(date) {
  // Example shape, replace with real HTTP calls:
  // const res = await fetch(`${process.env.BEECOMM_API_URL}/reports/z?date=${date}`, {
  //   headers: { Authorization: `Bearer ${process.env.BEECOMM_API_KEY}` }
  // });
  // const data = await res.json();
  // return { sales: [...], items: [...], cancellations: [...] };
  throw new Error('חיבור ה-API של ביקום עוד לא מומש. מחכים לתיעוד מביקום');
}

async function sync(db, { days = 3 } = {}) {
  if (!configured()) throw new Error('חיבור ה-API של ביקום לא הוגדר (BEECOMM_API_URL, BEECOMM_API_KEY)');
  const summary = { imported: 0, days: [] };
  for (let i = days; i >= 1; i--) {
    const date = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const data = await fetchDay(date);
    for (const kind of ['sales', 'items', 'cancellations']) {
      const rows = data[kind] || [];
      if (!rows.length) continue;
      imp.commitImport(db, { kind, source: 'beecomm', filename: `Beecomm API ${date}`, rows, replace: true });
      summary.imported += rows.length;
    }
    summary.days.push(date);
  }
  return summary;
}

module.exports = {
  id: 'beecomm-api',
  label: 'ביקום, חיבור API (שלב 2)',
  configured,
  account: () => (configured() ? process.env.BEECOMM_API_URL : null),
  sync
};
