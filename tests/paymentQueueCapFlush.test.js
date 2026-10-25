// The cap is hard and counts live items only: dead items (waiting for a human) never block a new payment,
// and the flush of held items never writes past the cap.
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/services/notification.service', () => ({ sendErrorNotificationToBale: jest.fn(async () => {}) }));
const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-qcap-')), 'q.json');
process.env.PAYMENT_QUEUE_FILE = FILE;
process.env.QUEUE_MAX_ITEMS = '2';
process.env.QUEUE_HOLD_RETRY_MS = '5';
const queue = require('../src/services/payment-queue.service');

const item = (o) => ({ orderId: o, gateway: 'sep', code: `R-${o}`, payload: { orderId: o } });
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => fs.rmSync(FILE, { force: true }));

test('a queue full of dead items still takes a new item onto disk', () => {
  fs.writeFileSync(FILE, JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, status: 'dead', payload: {} }))));
  queue.addToQueue(item('new'));
  expect(onDisk()).toHaveLength(6);
  expect(onDisk().find((i) => i.orderId === 'new')).toBeTruthy();
});

test('held items are not flushed past the cap, updates do not push them out, and they land once there is room', async () => {
  queue.addToQueue(item('a'));
  queue.addToQueue(item('b'));
  queue.addToQueue(item('c')); // over the cap: held
  await wait(40);
  expect(onDisk().map((i) => i.orderId)).toEqual(['a', 'b']); // the flush timer ran and wrote nothing
  queue.updateItem(onDisk()[0].id, { lastError: 'x' });
  expect(onDisk()).toHaveLength(2);
  expect(queue.getAllItems().map((i) => i.orderId).sort()).toEqual(['a', 'b', 'c']);
  queue.removeItem(onDisk()[0].id);
  await wait(60);
  expect(onDisk().map((i) => i.orderId).sort()).toEqual(['b', 'c']);
});
