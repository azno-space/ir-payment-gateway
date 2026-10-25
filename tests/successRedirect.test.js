'use strict';
// The success redirect: a URL without {orderId} is used exactly as before; {orderId} is filled with the
// paid order's id, and an unusable id falls back instead of producing a broken address.
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

const OK = { Success: true, ResultCode: 0, TransactionDetail: { RefNum: 'REF-A', OrginalAmount: 5000000 } };
const res = () => ({ status: jest.fn().mockReturnThis(), send: jest.fn(), redirect: jest.fn(), json: jest.fn() });
const ENV_KEYS = ['FRONT_BASE_URL', 'FRONT_SUCCESS_URL', 'FRONT_SUCCESS_FALLBACK_URL', 'FRONT_FAILURE_URL', 'PAYMENT_SUCCESS_WEBHOOK_URL'];

async function pay(env, resNum = '11111111-2222-3333-4444-555555555555') {
  jest.resetModules();
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, { PAYMENT_SUCCESS_WEBHOOK_URL: 'http://receiver.test/s' }, env);
  const { sepVerifyPayment } = require('../src/services/payment-gateway.service');
  sepVerifyPayment.mockResolvedValue(OK);
  const { handlePaymentCallback } = require('../src/controllers/payment.controller');
  const r = res();
  await handlePaymentCallback({ query: { RefNum: 'REF-A', ResNum: resNum, State: 'OK' }, body: {}, protocol: 'https', get: () => 'pg.test' }, r);
  return r;
}

afterAll(() => ENV_KEYS.forEach((k) => delete process.env[k]));

test('no placeholder: the URL is used exactly as before', async () => {
  const r = await pay({ FRONT_SUCCESS_URL: 'https://shop.test/user/list' });
  expect(r.redirect).toHaveBeenCalledWith(302, 'https://shop.test/user/list');
});

test('only FRONT_BASE_URL: default success path as before', async () => {
  const r = await pay({ FRONT_BASE_URL: 'https://shop.test' });
  expect(r.redirect).toHaveBeenCalledWith(302, 'https://shop.test/payment/success');
});

test('placeholder is filled with the paid order id', async () => {
  const r = await pay({ FRONT_SUCCESS_URL: 'https://shop.test/receipt/{orderId}' });
  expect(r.redirect).toHaveBeenCalledWith(302, 'https://shop.test/receipt/11111111-2222-3333-4444-555555555555');
});

test('placeholder can sit in a query string', async () => {
  const r = await pay({ FRONT_SUCCESS_URL: 'https://shop.test/done?o={orderId}' }, 'order-7');
  expect(r.redirect).toHaveBeenCalledWith(302, 'https://shop.test/done?o=order-7');
});

test('missing id with a placeholder uses FRONT_SUCCESS_FALLBACK_URL, never a broken address', async () => {
  const r = await pay({ FRONT_SUCCESS_URL: 'https://shop.test/receipt/{orderId}', FRONT_SUCCESS_FALLBACK_URL: 'https://shop.test/user/list' }, '');
  expect(r.redirect).toHaveBeenCalledWith(302, 'https://shop.test/user/list');
});

test('missing id, no fallback set: default success path', async () => {
  const r = await pay({ FRONT_BASE_URL: 'https://shop.test', FRONT_SUCCESS_URL: 'https://shop.test/receipt/{orderId}' }, '');
  expect(r.redirect).toHaveBeenCalledWith(302, 'https://shop.test/payment/success');
});
