// The success-webhook retry queue holds verified payments the receiver has not taken yet. It must
// never lose one: a failed write alerts and keeps the item, a corrupt file is kept for a human, a
// retry backs off, and an item that keeps failing ends in a visible dead state with an alert.
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/services/notification.service', () => ({ sendErrorNotificationToBale: jest.fn(async () => {}) }));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-queue-'));
const FILE = path.join(DIR, 'q', 'payment-queue.json');
process.env.PAYMENT_QUEUE_FILE = FILE;
process.env.QUEUE_HOLD_RETRY_MS = '5';
process.env.QUEUE_MAX_ATTEMPTS = '3';

const { sendErrorNotificationToBale: alert } = require('../src/services/notification.service');
const queue = require('../src/services/payment-queue.service');

const item = (orderId) => ({ orderId, gateway: 'sep', code: `REF-${orderId}`, verifyDetails: { charged_rial: 1000 }, payload: { orderId } });
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const waitFor = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

beforeEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); jest.clearAllMocks(); });
afterEach(() => jest.restoreAllMocks());

test('a full disk alerts with the order and ref, keeps the item in memory and writes it once the disk recovers', async () => {
  let full = true;
  const real = fs.writeFileSync;
  jest.spyOn(fs, 'writeFileSync').mockImplementation((...a) => { if (full) throw enospc(); return real(...a); });

  expect(() => queue.addToQueue(item('o1'))).not.toThrow();
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', code: 'REF-o1', stage: 'queue_write_failed' }));
  expect(queue.getAllItems()).toEqual([expect.objectContaining({ orderId: 'o1', held: true })]);
  expect(queue.pendingCount()).toBe(1);

  await new Promise((r) => setTimeout(r, 30));
  expect(fs.existsSync(FILE)).toBe(false);

  full = false;
  await waitFor(() => fs.existsSync(FILE));
  expect(onDisk()).toEqual([expect.objectContaining({ orderId: 'o1', status: 'pending' })]);
  expect(queue.getAllItems()).toHaveLength(1); // not doubled
});

test('a write is atomic: a failure mid-write never wipes what is already queued', async () => {
  queue.addToQueue(item('old'));
  const real = fs.writeFileSync;
  jest.spyOn(fs, 'writeFileSync').mockImplementation((f, ...a) => { real(f, ''); throw enospc(); });
  queue.addToQueue(item('new'));
  fs.writeFileSync.mockRestore();
  expect(onDisk().map((i) => i.orderId)).toEqual(['old']);
  await waitFor(() => onDisk().length === 2); // the held item lands once writes work again
  expect(onDisk().map((i) => i.orderId)).toEqual(['old', 'new']);
});

test('a corrupt file is moved aside and alerted, never read as empty and overwritten', () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, '[{"orderId":"lost?"');
  expect(() => queue.getAllItems()).not.toThrow();
  queue.addToQueue(item('o2'));
  const aside = fs.readdirSync(path.dirname(FILE)).filter((f) => f.includes('.corrupt-'));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(path.join(path.dirname(FILE), aside[0]), 'utf8')).toBe('[{"orderId":"lost?"');
  expect(onDisk().map((i) => i.orderId)).toEqual(['o2']);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ stage: 'queue_file_corrupt' }));
});

test('retries back off, then the item goes dead with an alert instead of expiring silently', async () => {
  queue.addToQueue(item('o3'));
  const fail = jest.fn(async () => { throw new Error('receiver down'); });

  await queue.runPass(fail);
  let [it] = onDisk();
  expect(it).toMatchObject({ status: 'pending', retryCount: 1, lastError: 'receiver down' });
  expect(new Date(it.nextRetryAt).getTime()).toBeGreaterThan(Date.now() + 30_000);

  await queue.runPass(fail); // not due yet: nothing happens
  expect(fail).toHaveBeenCalledTimes(1);

  for (let n = 0; n < 2; n++) {
    fs.writeFileSync(FILE, JSON.stringify(onDisk().map((i) => ({ ...i, nextRetryAt: new Date(0).toISOString() }))));
    await queue.runPass(fail);
  }
  [it] = onDisk();
  expect(it).toMatchObject({ status: 'dead', retryCount: 3 });
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o3', stage: 'queue_item_dead' }));
  expect(queue.pendingCount()).toBe(0);
  expect(queue.deadCount()).toBe(1);

  fs.writeFileSync(FILE, JSON.stringify(onDisk().map((i) => ({ ...i, nextRetryAt: new Date(0).toISOString() }))));
  await queue.runPass(fail);
  expect(fail).toHaveBeenCalledTimes(3); // a dead item is not retried
});

test('a delivered item leaves the queue; an old-queue item is delivered, unless the old queue had given up on it', async () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify([
    { id: 'legacy', status: 'pending', retryCount: 1, lastAttemptAt: null, ...item('o4') },
    { id: 'expired', status: 'pending', retryCount: 2880, lastAttemptAt: null, ...item('o6') },
    { id: 'done', status: 'completed', retryCount: 1, ...item('o5') },
  ]));
  const ok = jest.fn(async () => {});
  await queue.runPass(ok);
  expect(ok).toHaveBeenCalledTimes(1);
  expect(ok).toHaveBeenCalledWith(expect.objectContaining({ id: 'legacy', orderId: 'o4' }));
  expect(onDisk().map((i) => [i.id, i.status])).toEqual([['expired', 'dead'], ['done', 'completed']]);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o6', stage: 'queue_item_dead' }));
});
