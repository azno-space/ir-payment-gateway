'use strict';
// Pins the alert-message queue worker: which items are sent, retried, expired or left alone.
const mockPost = jest.fn();
jest.mock('axios', () => ({ create: () => ({ post: (...a) => mockPost(...a) }) }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = ['BALE_ERROR_QUEUE_FILE', 'BALE_ERROR_QUEUE_INTERVAL_MS', 'BALE_ERROR_QUEUE_MAX_AGE_MS', 'BALE_ERROR_QUEUE_MAX_RETRIES'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bale-'));
  file = path.join(dir, 'queue.json');
  Object.assign(process.env, { BALE_ERROR_QUEUE_FILE: file, BALE_ERROR_QUEUE_INTERVAL_MS: '3600000', BALE_ERROR_QUEUE_MAX_AGE_MS: '600000', BALE_ERROR_QUEUE_MAX_RETRIES: '3' });
  mockPost.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const item = (over) => ({ id: 'x', createdAt: ago(1000), nextAttemptAt: ago(500), retryCount: 0, lastAttemptAt: null, lastError: null, botToken: 'T', chatId: 'C', message: 'hi', source: 'error', ...over });

// The worker runs once when the module loads; seed the file first, load, let it settle, read the file.
async function runWorker(items) {
  fs.writeFileSync(file, JSON.stringify(items));
  jest.resetModules();
  require('../src/services/notification.service');
  await new Promise((resolve) => setTimeout(resolve, 100));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('a due item is sent through the bot and marked sent', async () => {
  mockPost.mockResolvedValue({});
  const [sent] = await runWorker([item({ id: 'a' })]);
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockPost.mock.calls[0][0]).toBe('https://tapi.bale.ai/botT/sendMessage');
  expect(mockPost.mock.calls[0][1]).toEqual({ chat_id: 'C', text: 'hi', parse_mode: 'HTML' });
  expect(sent).toMatchObject({ id: 'a', status: 'sent', lastError: null });
  expect(sent.sentAt).toEqual(expect.any(String));
});

test('a reply markup travels with the message', async () => {
  mockPost.mockResolvedValue({});
  await runWorker([item({ replyMarkup: { inline_keyboard: [] } })]);
  expect(mockPost.mock.calls[0][1].reply_markup).toBe('{"inline_keyboard":[]}');
});

test('a send that fails is retried later with a growing delay', async () => {
  mockPost.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EBAD' }));
  const [one] = await runWorker([item({ id: 'a', retryCount: 0 })]);
  expect(one.retryCount).toBe(1);
  expect(one.lastError).toEqual(expect.any(String));
  const delay = Date.parse(one.nextAttemptAt) - Date.now();
  expect(delay).toBeGreaterThan(50000);
  expect(delay).toBeLessThanOrEqual(60000);
  const [two] = await runWorker([item({ id: 'b', retryCount: 1 })]);
  expect(Date.parse(two.nextAttemptAt) - Date.now()).toBeGreaterThan(110000);
});

test('an item that is not due yet is left alone', async () => {
  const future = item({ id: 'a', nextAttemptAt: new Date(Date.now() + 60000).toISOString() });
  const [same] = await runWorker([future]);
  expect(mockPost).not.toHaveBeenCalled();
  expect(same).toEqual(future);
});

test('an item older than the maximum age is failed as Expired, even when it is not due', async () => {
  const [expired] = await runWorker([item({ id: 'a', createdAt: ago(700000), nextAttemptAt: new Date(Date.now() + 60000).toISOString() })]);
  expect(mockPost).not.toHaveBeenCalled();
  expect(expired).toMatchObject({ status: 'failed', lastError: 'Expired' });
  expect(expired.lastAttemptAt).toEqual(expect.any(String));
});

test('an item at the maximum retries is failed, not sent again', async () => {
  const [done] = await runWorker([item({ id: 'a', retryCount: 3 })]);
  expect(mockPost).not.toHaveBeenCalled();
  expect(done).toMatchObject({ status: 'failed', lastError: 'Max retries reached' });
  expect(done.lastAttemptAt).toEqual(expect.any(String));
});

test('sent and failed items are skipped; an item without a usable date is neither due nor expired', async () => {
  const items = [item({ id: 's', status: 'sent' }), item({ id: 'f', status: 'failed' }), item({ id: 'n', nextAttemptAt: 'nope', createdAt: 'nope' })];
  const out = await runWorker(items);
  expect(mockPost).not.toHaveBeenCalled();
  expect(out).toEqual(items);
});

test('an empty or missing queue changes nothing', async () => {
  const out = await runWorker([]);
  expect(out).toEqual([]);
});
