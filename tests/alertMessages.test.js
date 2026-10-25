'use strict';
// Golden texts and delivery guarantees of the public alert senders: the exact message each helper
// sends, and that a critical error alert is queued (not lost) when the chat is unreachable.
const mockPost = jest.fn();
jest.mock('axios', () => ({ create: () => ({ post: (...a) => mockPost(...a) }) }));
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = {
  BALE_FAILED_BOT_TOKEN: 'BT', BALE_FAILED_CHAT_ID: 'BC', TELEGRAM_BOT_TOKEN: 'TT', TELEGRAM_CHAT_ID: 'TC',
  BALE_ERROR_QUEUE_INTERVAL_MS: '3600000',
};
const saved = {};
let dir;
let svc;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
  Object.assign(ENV, { BALE_ERROR_QUEUE_FILE: path.join(dir, 'q.json') });
  Object.keys(ENV).forEach((k) => { saved[k] = process.env[k]; process.env[k] = ENV[k]; });
  mockPost.mockReset();
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'], now: new Date('2026-10-05T12:00:00.000Z') });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.resetModules();
  svc = require('../src/services/notification.service');
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const flush = () => new Promise((r) => setImmediate(r));
const sent = () => mockPost.mock.calls.map(([url, body]) => ({ url, body }));

test('error alert text and both destinations', async () => {
  mockPost.mockResolvedValue({});
  await svc.sendErrorNotificationToBale({ title: 'T', message: 'M', gateway: 'sep', code: 'C1', paymentId: 'P1', orderId: 'O1', error: 'a<b&c' });
  await flush();
  const text = '<b>🔴 T</b>\n\n<b>پیام:</b>\nM\n\n<b>📊 اطلاعات پرداخت:</b>\n• درگاه: <code>sep</code>\n• کد: <code>C1</code>\n• شناسه پرداخت: <code>P1</code>\n• شناسه سفارش: <code>O1</code>\n\n<b>⚙️ جزئیات فنی:</b>\n<pre>a&lt;b&amp;c</pre>\n<b>⏰ زمان:</b> 2026-10-05T12:00:00.000Z\n';
  expect(sent()).toEqual([
    { url: 'https://tapi.bale.ai/botBT/sendMessage', body: { chat_id: 'BC', text, parse_mode: 'HTML' } },
    { url: 'https://api.telegram.org/botTT/sendMessage', body: { chat_id: 'TC', text, parse_mode: 'HTML' } },
  ]);
});

test('default title, plain message, no technical block', async () => {
  mockPost.mockResolvedValue({});
  await svc.sendFailedPaymentNotificationToBale({});
  expect(sent()[0].body.text).toBe('<b>🔴 خطا در سیستم پرداخت</b>\n\n<b>پیام:</b>\nبدون توضیح\n\n<b>⏰ زمان:</b> 2026-10-05T12:00:00.000Z\n');
});

test('warning alert text', async () => {
  mockPost.mockResolvedValue({});
  await svc.sendWarningNotificationToBale({ title: 'W', gateway: 'sep', code: 'R1', orderId: 'O1', cancelReason: 'x<y', sepState: 'CANCELED', sepStatus: 3, gatewayErrorDesc: 'desc' });
  await flush();
  expect(sent()[0].body.text).toBe('<b>⚠️ W</b>\n\n<b>علت:</b> x&lt;y\n<b>شرح خطا:</b> desc\n• State: <code>CANCELED</code>\n• Status: <code>3</code>\n\n<b>📊 تراکنش:</b>\n• درگاه: <code>sep</code>\n• RefNum: <code>R1</code>\n• سفارش: <code>O1</code>\n\n<b>⏰ زمان:</b> 2026-10-05T12:00:00.000Z\n');
});

test('recovery message goes out as given; success messages stay off', async () => {
  mockPost.mockResolvedValue({});
  await svc.sendBaleRecoveryMessage('recovered');
  await svc.sendPaymentSuccessNotificationToBale({ orderId: 'O' });
  await flush();
  expect(sent().map((c) => c.body.text)).toEqual(['recovered', 'recovered']);
});

test('a critical error alert survives an unreachable chat: queued on disk, then delivered', async () => {
  mockPost.mockRejectedValue(Object.assign(new Error('down'), { response: { status: 403 } }));
  await svc.sendErrorNotificationToBale({ title: 'T', message: 'M' });
  await flush();
  const queued = JSON.parse(fs.readFileSync(ENV.BALE_ERROR_QUEUE_FILE, 'utf8'));
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ botToken: 'BT', chatId: 'BC', source: 'error', retryCount: expect.any(Number) });
  // the chat is back: the next worker run (a fresh process) sends it
  mockPost.mockReset();
  mockPost.mockResolvedValue({});
  fs.writeFileSync(ENV.BALE_ERROR_QUEUE_FILE, JSON.stringify(queued.map((i) => ({ ...i, nextAttemptAt: '2026-10-05T11:59:00.000Z' }))));
  jest.resetModules();
  require('../src/services/notification.service');
  await flush();
  await new Promise((r) => setImmediate(r));
  expect(sent()).toHaveLength(1);
  expect(sent()[0].body.text).toBe(queued[0].message);
});
