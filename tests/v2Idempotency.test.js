'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
let idem;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-'));
  process.env.IDEMPOTENCY_FILE = path.join(dir, 'keys.json');
  jest.resetModules();
  idem = require('../src/v2/idempotency');
});
afterEach(() => {
  delete process.env.IDEMPOTENCY_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

const KEY = 'order-key-0001';

test('no header means no idempotency; a malformed key is refused', () => {
  expect(idem.readKey({ headers: {} })).toEqual({ ok: true, key: null });
  expect(idem.readKey({ headers: { 'idempotency-key': 'short' } })).toEqual({ error: 'invalid' });
  expect(idem.readKey({ headers: { 'idempotency-key': KEY } })).toEqual({ ok: true, key: KEY });
});

test('the first answer is replayed for the same key and body', () => {
  expect(idem.begin(KEY, { a: 1 })).toEqual({ state: 'new' });
  idem.finish(KEY, { a: 1 }, 201, { targetUrl: 'u' });
  expect(idem.begin(KEY, { a: 1 })).toEqual({ state: 'replay', status: 201, body: { targetUrl: 'u' } });
});

test('the same key with another body is a mismatch, not the first answer', () => {
  idem.begin(KEY, { a: 1 });
  idem.finish(KEY, { a: 1 }, 201, {});
  expect(idem.begin(KEY, { a: 2 })).toEqual({ state: 'mismatch' });
});

test('a second call while the first is running is busy', () => {
  expect(idem.begin(KEY, {})).toEqual({ state: 'new' });
  expect(idem.begin(KEY, {})).toEqual({ state: 'busy' });
  idem.abandon(KEY);
  expect(idem.begin(KEY, {})).toEqual({ state: 'new' });
});

test('a 5xx answer is not kept, so the caller can retry with the same key', () => {
  idem.begin(KEY, {});
  idem.finish(KEY, {}, 502, { error: 'x' });
  expect(idem.begin(KEY, {})).toEqual({ state: 'new' });
});

test('a 4xx answer is kept (same input, same refusal)', () => {
  idem.begin(KEY, {});
  idem.finish(KEY, {}, 400, { error: 'bad', code: 'bad_request' });
  expect(idem.begin(KEY, {})).toMatchObject({ state: 'replay', status: 400 });
});

test('a key named like an object property is an ordinary key', () => {
  for (const key of ['constructor', 'hasOwnProperty', '__proto__']) {
    expect(idem.begin(key, {})).toEqual({ state: 'new' });
    idem.abandon(key);
  }
});

test('key order and "5000" vs 5000 are the same input once the caller normalises it', () => {
  expect(idem.canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(idem.canonical({ a: { c: 3, d: 2 }, b: 1 }));
});

test('finish says whether the answer was stored, and leaves no temp file', () => {
  idem.begin(KEY, {});
  expect(idem.finish(KEY, {}, 201, { ok: true })).toBe(true);
  expect(fs.readdirSync(dir)).toEqual(['keys.json']);
  process.env.IDEMPOTENCY_FILE = path.join(dir, 'no-such-dir', 'x', '\0bad');
  jest.resetModules();
  const broken = require('../src/v2/idempotency');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  broken.begin('another-key-1', {});
  expect(broken.finish('another-key-1', {}, 201, {})).toBe(false);
});

test('a garbage TTL falls back to a day', () => {
  process.env.IDEMPOTENCY_TTL_MS = 'soon';
  jest.resetModules();
  expect(require('../src/v2/idempotency').TTL_MS).toBe(86400000);
  delete process.env.IDEMPOTENCY_TTL_MS;
});

test('a junk entry in the key file (null) is dropped, not a crash', () => {
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ [KEY]: null, 'other-key-0001': 'x' }));
  expect(idem.begin(KEY, {})).toEqual({ state: 'new' });
});

test('keys survive a restart', () => {
  idem.begin(KEY, { a: 1 });
  idem.finish(KEY, { a: 1 }, 201, { ok: true });
  jest.resetModules();
  const again = require('../src/v2/idempotency');
  expect(again.begin(KEY, { a: 1 })).toMatchObject({ state: 'replay', status: 201 });
});
