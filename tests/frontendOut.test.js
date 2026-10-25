'use strict';
// Cleanup phase 2 (2026-10-19): the gateway renders no pages. A failure goes to the front end's result
// page with a fixed reason code, or to plain JSON when no front URL is set.
const mocks = () => {
  jest.doMock('../src/services/payment-gateway.service', () => ({ sepVerifyPayment: jest.fn(), zarinpalVerifyPayment: jest.fn() }));
  jest.doMock('../src/services/webhook.service', () => {
    const callWebhook = jest.fn(async () => ({ ok: true, status: 200 }));
    return { callWebhook, deliverSuccess: (...a) => callWebhook(...a), deliverFailure: (...a) => callWebhook(...a), pingWebhook: jest.fn(async () => ({ ok: true })) };
  });
  jest.doMock('../src/services/payment-queue.service', () => ({ enqueue: jest.fn() }));
  jest.doMock('../src/services/notification.service', () => ({
    sendErrorNotificationToBale: jest.fn(async () => {}),
    sendFailedPaymentNotificationToBale: jest.fn(async () => {}),
    sendPaymentSuccessNotificationToBale: jest.fn(async () => {}),
    sendWarningNotificationToBale: jest.fn(async () => {}),
    sendBaleRecoveryMessage: jest.fn(async () => {}),
  }));
  jest.doMock('../src/utils/eventLogger', () => ({ logPaymentEvent: jest.fn() }));
};

const res = () => {
  const r = { statusCode: 200 };
  r.status = jest.fn((c) => { r.statusCode = c; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  r.send = jest.fn((b) => { r.body = b; return r; });
  r.redirect = jest.fn((c, u) => { r.statusCode = c; r.location = u; return r; });
  return r;
};
const load = (env) => {
  jest.resetModules();
  Object.assign(process.env, { PAYMENT_SUCCESS_WEBHOOK_URL: 'http://receiver.test/s', PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f', FRONT_FAILURE_URL: '', ...env });
  mocks();
  return { ctrl: require('../src/controllers/payment.controller'), webhook: require('../src/services/webhook.service') };
};
const sepCancel = (over = {}) => ({ query: { State: 'NOK', ResNum: 'order-7', ErrorDesc: '<h2>call 0912</h2>', ...over }, body: {}, headers: {} });

afterEach(() => { delete process.env.FRONT_FAILURE_URL; });

test('a cancelled payment redirects to the result page with a reason code, never the bank text', async () => {
  const { ctrl } = load({ FRONT_FAILURE_URL: 'https://shop.test/payment/result' });
  const r = res();
  await ctrl.handlePaymentCallback(sepCancel({ RefNum: 'REF-9' }), r);
  expect(r.statusCode).toBe(302);
  const u = new URL(r.location);
  expect(u.origin + u.pathname).toBe('https://shop.test/payment/result');
  expect(u.searchParams.get('reason')).toBe('cancelled');
  expect(r.location).not.toMatch(/h2|0912/);
  expect(r.send).not.toHaveBeenCalled();
});

test('without a front URL the failure is plain JSON, not a page', async () => {
  const { ctrl } = load();
  const r = res();
  await ctrl.handlePaymentCallback(sepCancel(), r);
  expect(r.statusCode).toBe(400);
  expect(r.body).toEqual({ success: false, error: { code: 'cancelled' } });
  expect(r.send).not.toHaveBeenCalled();
});

test('a reference with odd characters is left out of the redirect', async () => {
  const { ctrl } = load({ FRONT_FAILURE_URL: 'https://shop.test/r' });
  const r = res();
  await ctrl.handlePaymentCallback({ query: { gateway: 'zarinpal', Status: 'NOK', orderId: 'order-7', Authority: 'A<b>' }, body: {}, headers: {} }, r);
  expect(new URL(r.location).searchParams.get('ref')).toBeNull();
  expect(new URL(r.location).searchParams.get('reason')).toBe('cancelled');
});

test('a repeated cancel callback without an order id sends no failure webhook', async () => {
  const { ctrl, webhook } = load();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  await ctrl.handlePaymentCallback({ query: { State: 'NOK' }, body: {}, headers: {} }, res());
  expect(webhook.callWebhook).not.toHaveBeenCalled();
  await ctrl.handlePaymentCallback(sepCancel(), res());
  expect(webhook.callWebhook).toHaveBeenCalledWith('http://receiver.test/f', expect.objectContaining({ orderId: 'order-7' }), expect.anything());
  console.warn.mockRestore();
});

test('the debug and preview routes are gone', () => {
  const routes = require('../src/routes/payment.routes').stack.map((l) => l.route?.path);
  expect(routes).not.toContain('/sep-callback-debug');
  expect(routes).not.toContain('/preview-error');
});
