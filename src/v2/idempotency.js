'use strict';
// Idempotency-Key for a POST that moves money: the same key sent again returns the first answer instead
// of doing the work twice, and the same key arriving while the first call is still running is refused.
// ponytail: one process holds the keys and the whole file is read and written on every keyed call
// (fine for the payment volume of one gateway; past a few thousand keys a day use a real store). A
// second instance would need a shared store too.
const path = require('path');

const FILE = process.env.IDEMPOTENCY_FILE || path.join(__dirname, '../../data/idempotency-keys.json');
const DEFAULT_TTL_MS = 86400000; // 24 hours
const ttl = parseInt(process.env.IDEMPOTENCY_TTL_MS, 10);
const TTL_MS = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const inFlight = new Set();

const { readJson, writeJson } = require('../utils/atomicJson');

// A key such as "constructor" must be an ordinary key (the table has no prototype); a crash mid-write
// must not truncate the file, which would read as empty and forget every key.
const read = () => readJson(FILE, 'Idempotency');
const write = (data) => writeJson(FILE, data, 'Idempotency');

function purge(data, now) {
  for (const [k, v] of Object.entries(data)) if (!v || typeof v !== 'object' || !(now - v.at <= TTL_MS)) delete data[k];
}

// → { ok:true, key } | { ok:true, key:null } (no header) | { error: 'invalid' }
function readKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return { ok: true, key: null };
  return KEY_PATTERN.test(String(raw)) ? { ok: true, key: String(raw) } : { error: 'invalid' };
}

// JSON with object keys sorted, so the same input in another key order is the same input.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// `input` is what the call means (already normalised by the caller), not the raw request body.
// → { state: 'new' } | { state: 'replay', status, body } | { state: 'busy' } | { state: 'mismatch' }
function begin(key, input) {
  const now = Date.now();
  const data = read();
  purge(data, now);
  if (Object.hasOwn(data, key)) {
    const hit = data[key];
    return hit.fingerprint === canonical(input) ? { state: 'replay', status: hit.status, body: hit.body } : { state: 'mismatch' };
  }
  if (inFlight.has(key)) return { state: 'busy' };
  inFlight.add(key);
  return { state: 'new' };
}

// Only a finished answer is kept; a 5xx is not, so the caller can retry with the same key.
// → false when the answer could not be stored (the caller must make that loud).
function finish(key, input, status, responseBody) {
  inFlight.delete(key);
  if (status >= 500) return true;
  const data = read();
  data[key] = { at: Date.now(), fingerprint: canonical(input), status, body: responseBody };
  return write(data);
}

function abandon(key) {
  inFlight.delete(key);
}

module.exports = { readKey, begin, finish, abandon, canonical, TTL_MS };
