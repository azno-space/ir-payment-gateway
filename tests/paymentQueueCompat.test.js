// The gateway queue reads the file format written before the shared write helper, keeps dead items
// untouched, and stops growing at its cap (the overflow is held in memory with an alert, never dropped).
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/services/notification.service', () => ({ sendErrorNotificationToBale: jest.fn(async () => {}) }));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-qcompat-'));
const FILE = path.join(DIR, 'payment-queue.json');
process.env.PAYMENT_QUEUE_FILE = FILE;
process.env.QUEUE_MAX_ITEMS = '3';
process.env.QUEUE_HOLD_RETRY_MS = '600000';
const { sendErrorNotificationToBale: alert } = require('../src/services/notification.service');
const queue = require('../src/services/payment-queue.service');

const item = (orderId) => ({ orderId, gateway: 'sep', code: `R-${orderId}`, verifyDetails: { charged_rial: 1 }, payload: { orderId } });
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
beforeEach(() => { fs.rmSync(FILE, { force: true }); jest.clearAllMocks(); });

test('reads the old file format (no nextRetryAt) and a dead item survives a later write untouched', () => {
  const old = { id: 'old1', orderId: 'x', gateway: 'sep', code: 'R', status: 'dead', retryCount: 8, lastError: 'gave up', payload: {} };
  fs.writeFileSync(FILE, JSON.stringify([old], null, 2));
  expect(queue.getAllItems()).toEqual([old]);
  queue.addToQueue(item('n1'));
  expect(onDisk()[0]).toEqual(old);
  expect(onDisk()).toHaveLength(2);
});

test('updating or removing an item still works when the queue is full', () => {
  for (const o of ['a', 'b', 'c']) queue.addToQueue(item(o));
  const [first] = onDisk();
  queue.updateItem(first.id, { status: 'dead' });
  expect(onDisk()[0].status).toBe('dead');
  queue.removeItem(first.id);
  expect(onDisk()).toHaveLength(2);
});

test('a long error text is cut before it is stored', async () => {
  queue.addToQueue(item('a'));
  await queue.runPass(async () => { throw new Error('x'.repeat(5000)); });
  expect(onDisk()[0].lastError.length).toBeLessThanOrEqual(500);
});

// last: the held item stays in memory for the rest of the file
test('at the cap a new item is not written to disk: held in memory, alert raised, nothing dropped', () => {
  for (const o of ['a', 'b', 'c']) queue.addToQueue(item(o));
  expect(onDisk()).toHaveLength(3);
  queue.addToQueue(item('d'));
  expect(onDisk()).toHaveLength(3);
  expect(queue.getAllItems().map((i) => i.orderId)).toEqual(['a', 'b', 'c', 'd']);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ stage: 'queue_write_failed', orderId: 'd' }));
});

