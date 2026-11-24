'use strict';
/**
 * Extracts <table> elements from an HTML email body into arrays of rows.
 * Many POS systems put the daily report inside the email body instead of attaching a file.
 */

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", shy: '' };

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

function cellText(html) {
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Returns an array of tables; each table is an array of rows (arrays of strings). Nested tables are flattened. */
function extractTables(html) {
  if (!html) return [];
  const clean = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const tables = [];
  // innermost tables first: a table with no nested <table> inside
  const re = /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi;
  let m;
  while ((m = re.exec(clean))) {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(m[1]))) {
      const cells = [];
      const tdRe = /<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi;
      let td;
      while ((td = tdRe.exec(tr[1]))) {
        const span = Number((td[1].match(/colspan\s*=\s*["']?(\d+)/i) || [])[1] || 1);
        cells.push(cellText(td[2]));
        for (let i = 1; i < Math.min(span, 20); i++) cells.push('');
      }
      if (cells.some(c => c !== '')) rows.push(cells);
    }
    if (rows.length >= 2) tables.push(rows);
  }
  return tables;
}

module.exports = { extractTables };
