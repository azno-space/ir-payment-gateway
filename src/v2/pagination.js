'use strict';
// Every v2 list is paginated: limit (default 50, at most 200) and offset (default 0). A limit above the
// cap is clamped; anything that is not a whole number is refused, never guessed.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseInteger(raw) {
  if (raw === undefined || raw === '') return undefined;
  const text = String(raw);
  return /^\d+$/.test(text) ? Number(text) : NaN;
}

// → { limit, offset } or { invalid: 'limit' | 'offset' }
function readPage(query = {}) {
  const limit = parseInteger(query.limit);
  const offset = parseInteger(query.offset);
  if (Number.isNaN(limit) || limit === 0) return { invalid: 'limit' };
  if (Number.isNaN(offset)) return { invalid: 'offset' };
  return { limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT), offset: offset ?? 0 };
}

// The envelope of every list: the page, the total behind it, and the window that was applied.
function pageOf(items, { limit, offset }) {
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, readPage, pageOf };
