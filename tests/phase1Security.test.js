'use strict';
// Cleanup phase 1 (2026-10-19): each test fails on the code before it.
jest.mock('../src/services/payment-gateway.service', () => ({ sepVerifyPayment: jest.fn() }));
jest.mock('../src/services/webhook.service', () => {
  const callWebhook = jest.fn(async () => ({ ok: true, status: 200 }));
  return { callWebhook, deliverSuccess: (...a) => callWebhook(...a), deliverFailure: (...a) => callWebhook(...a), pingWebhook: jest.fn(async () => ({ ok: true })) };
});
jest.mock('../src/services/payment-queue.service', () => ({ enqueue: jest.fn() }));
jest.mock('../src/services/notification.service', () => ({
  sendErrorNotificationToBale: jest.fn(async () => {}),
  sendFailedPaymentNotificationToBale: jest.fn(async () => {}),
  sendPaymentSuccessNotificationToBale: jest.fn(async () => {}),
  sendWarningNotificationToBale: jest.fn(async () => {}),
  sendBaleRecoveryMessage: jest.fn(async () => {}),
}));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: jest.fn() }));
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: jest.fn(), readErrorLog: jest.fn(() => []) }));

process.env.PAYMENT_SUCCESS_WEBHOOK_URL = 'http://receiver.test/webhook/success';
process.env.ADMIN_KEY = 'k-admin';

const { callWebhook } = require('../src/services/webhook.service');
const ctrl = require('../src/controllers/payment.controller');

const res = () => {
  const r = { statusCode: 200 };
  r.status = jest.fn((c) => { r.statusCode = c; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  r.send = jest.fn((b) => { r.body = b; return r; });
  r.redirect = jest.fn(() => r);
  return r;
};
const req = (over) => ({ body: {}, query: {}, headers: {}, socket: { remoteAddress: 'remote-peer' }, originalUrl: '/x', protocol: 'https', get: () => 'gw.test', ...over });

beforeEach(() => jest.clearAllMocks());

test('a callback whose ResNum is not a plain id is refused before any webhook', async () => {
  const r = res();
  await ctrl.handlePaymentCallback(req({ query: { RefNum: 'REF-1', ResNum: '../../admin/x', State: 'OK' } }), r);
  expect(r.statusCode).toBe(400);
  expect(require('../src/services/payment-gateway.service').sepVerifyPayment).not.toHaveBeenCalled();
  expect(callWebhook).not.toHaveBeenCalled();
});

test('payment create refuses an order id with path or markup characters', async () => {
  const r = res();
  await ctrl.createPaymentRequest(req({ body: { orderId: 'a/../b', amount: 50000 } }), r);
  expect(r.statusCode).toBe(400);
  expect(r.body.error).toMatch(/orderId/);
});
