'use strict';
// Characterization of the callback and create handlers: for each scenario, the answer sent to the
// guest and the ORDER of every side effect (webhook, alerts, logs, session, queue). The handlers are
// being split into smaller modules; this is what must not move while that happens.
const mockLog = [];
const mockGw = {};
const mockSessions = new Map();

jest.mock('../src/services/payment-gateway.service', () => ({
  ZARINPAL_PAY_BASE: 'https://zp.test/pay/',
  ZARINPAL_SANDBOX_PAY_BASE: 'https://zps.test/pay/',
  zibalVerifyPayment: (...a) => { mockLog.push('zibal.verify'); return mockGw.zibalVerify(...a); },
  zarinpalVerifyPayment: (...a) => { mockLog.push('zarinpal.verify'); return mockGw.zarinpalVerify(...a); },
  zarinpalSandboxVerifyPayment: (...a) => { mockLog.push('zarinpalSandbox.verify'); return mockGw.zarinpalVerify(...a); },
  sepVerifyPayment: (...a) => { mockLog.push('sep.verify'); return mockGw.sepVerify(...a); },
  zibalRequestPayment: (a) => { mockLog.push('zibal.request'); return mockGw.zibalRequest(a); },
  zarinpalRequestPayment: (a) => { mockLog.push('zarinpal.request'); return mockGw.zarinpalRequest(a); },
  zarinpalSandboxRequestPayment: (a) => { mockLog.push('zarinpalSandbox.request'); return mockGw.zarinpalRequest(a); },
  sepRequestPayment: (a) => { mockLog.push('sep.request'); return mockGw.sepRequest(a); },
}));
jest.mock('../src/services/webhook.service', () => ({
  pingWebhook: async () => { mockLog.push('webhook.ping'); return mockGw.ping(); },
  deliverSuccess: async (url, payload) => { mockLog.push(['webhook.success', payload.orderId, payload.gateway, payload.code, payload.verifyDetails.charged_rial]); return mockGw.deliver(); },
  deliverFailure: async (url, payload) => { mockLog.push(['webhook.failure', payload.orderId, payload.gateway, payload.reason]); return { ok: true }; },
}));
jest.mock('../src/services/payment-queue.service', () => ({ addToQueue: (item) => mockLog.push(['queue.add', item.orderId]) }));
jest.mock('../src/services/payment-session.service', () => ({
  save: (id, s) => { mockLog.push(['session.save', id, s.amount, s.gateway]); mockSessions.set(String(id), s); },
  get: (id) => { mockLog.push(['session.get', id]); return mockSessions.get(String(id)) || null; },
  remove: (id) => { mockLog.push(['session.remove', id]); mockSessions.delete(String(id)); },
}));
jest.mock('../src/services/notification.service', () => ({
  sendErrorNotificationToBale: async (d) => { mockLog.push(['bale.error', d.stage]); },
  sendFailedPaymentNotificationToBale: async (d) => { mockLog.push(['bale.failed', d.stage]); },
  sendPaymentSuccessNotificationToBale: async (d) => { mockLog.push(['bale.success', d.orderId]); },
  sendWarningNotificationToBale: async (d) => { mockLog.push(['bale.warning', d.title]); },
  sendBaleRecoveryMessage: async () => {},
}));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: (name, d = {}) => mockLog.push(['event', name, d.reason || d.gateway || null]) }));
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: (e) => mockLog.push(['errorlog', e.stage]), readErrorLog: () => [] }));

const ENV_KEYS = ['FRONT_BASE_URL', 'FRONT_SUCCESS_URL', 'FRONT_FAILURE_URL', 'PAYMENT_SUCCESS_WEBHOOK_URL',
  'PAYMENT_FAILURE_WEBHOOK_URL', 'SUCCESS_HANDOFF_WAIT_MS', 'PAYMENT_CREATE_SECRET', 'FORCED_PAYMENT_GATEWAY',
  'PAYMENT_FAILOVER_ENABLED'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeRes() {
  return {
    status(code) { mockLog.push(['res.status', code]); return this; },
    json(body) { mockLog.push(['res.json', body]); return this; },
    redirect(code, url) { mockLog.push(['res.redirect', code, url]); return this; },
  };
}

function load(env = {}) {
  jest.resetModules();
  mockLog.length = 0;
  mockSessions.clear();
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, { FRONT_BASE_URL: 'https://shop.test' }, env);
  Object.assign(mockGw, {
    ping: async () => ({ ok: true }),
    deliver: async () => ({ ok: true }),
    zibalVerify: async () => ({ result: 100, amount: 5000000, refNumber: 'R1' }),
    zarinpalVerify: async () => ({ data: { code: 100, ref_id: 7 } }),
    sepVerify: async () => ({ Success: true, TransactionDetail: { OrginalAmount: 5000000 } }),
    zibalRequest: async () => ({ result: 100, trackId: 'T1' }),
    zarinpalRequest: async () => ({ data: { code: 100, authority: 'A1' } }),
    sepRequest: async () => ({ Status: 1, Token: 'TK', RefNum: 'RN' }),
  });
  return require('../src/controllers/payment.controller');
}

async function callback(env, query, body = {}) {
  const { handlePaymentCallback } = load(env);
  const out = [];
  mockLog.length = 0;
  await handlePaymentCallback({ query, body }, fakeRes());
  await tick();
  out.push(...mockLog);
  return out;
}

const HOOK = { PAYMENT_SUCCESS_WEBHOOK_URL: 'http://receiver.test/s' };
const JSON_MODE = {};
const REDIRECT_MODE = { FRONT_FAILURE_URL: 'https://shop.test/result' };

describe('callback', () => {
  test('no gateway or code: alert, log, 400 incomplete_params', async () => {
    expect(await callback(JSON_MODE, {})).toEqual([
      ['errorlog', 'callback_missing_params'],
      ['res.status', 400],
      ['res.json', { success: false, error: { code: 'incomplete_params' } }],
      ['bale.failed', 'callback_missing_params'],
    ]);
  });

  test('zarinpal user cancel: failure webhook, 400 cancelled', async () => {
    expect(await callback({ PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f' }, { Authority: 'A1', Status: 'NOK', orderId: 'o-1' })).toEqual([
      ['event', 'payment_warning', 'User cancelled'],
      ['webhook.failure', 'o-1', 'zarinpal', 'User cancelled Zarinpal payment'],
      ['res.status', 400],
      ['res.json', { success: false, error: { code: 'cancelled' } }],
    ]);
  });

  test('receiver not healthy: nothing verified, 503 verify_retry_failed with the bank reference', async () => {
    const { handlePaymentCallback } = load({ ...HOOK, ...REDIRECT_MODE });
    mockGw.ping = async () => ({ ok: false });
    mockLog.length = 0;
    await handlePaymentCallback({ query: { trackId: '999', orderId: 'o-2' }, body: {} }, fakeRes());
    await tick();
    expect(mockLog).toEqual([
      'webhook.ping',
      ['event', 'payment_warning', 'Webhook health check failed before verify'],
      ['res.redirect', 302, 'https://shop.test/result?kind=error&reason=verify_retry_failed&gateway=zibal&ref=999'],
      ['bale.error', 'webhook_health_check_failed'],
    ]);
  });

  test('zibal success: verify, event, webhook, then the redirect, then the success alert', async () => {
    expect(await callback(HOOK, { trackId: '555', orderId: 'o-3' })).toEqual([
      'webhook.ping',
      'zibal.verify',
      ['event', 'payment_success', 'zibal'],
      ['session.remove', 'o-3'],
      ['webhook.success', 'o-3', 'zibal', '555', 5000000],
      ['res.redirect', 302, 'https://shop.test/payment/success'],
      ['bale.success', 'o-3'],
    ]);
  });

  test('zarinpal success: amount comes from the stored session', async () => {
    const { handlePaymentCallback, createPaymentRequest } = load(HOOK);
    await createPaymentRequest({ headers: {}, body: { orderId: 'o-4', amount: 2500000, gateway: 'zarinpal' }, query: {} }, fakeRes());
    mockLog.length = 0;
    await handlePaymentCallback({ query: { Authority: 'A9', Status: 'OK', orderId: 'o-4' }, body: {} }, fakeRes());
    await tick();
    expect(mockLog).toEqual([
      'webhook.ping',
      ['session.get', 'o-4'],
      'zarinpal.verify',
      ['event', 'payment_success', 'zarinpal'],
      ['session.remove', 'o-4'],
      ['webhook.success', 'o-4', 'zarinpal', 'A9', 2500000],
      ['res.redirect', 302, 'https://shop.test/payment/success'],
      ['bale.success', 'o-4'],
    ]);
  });

  test('zarinpal without a session: alert and 400 verify_failed, no bank call', async () => {
    expect(await callback({ ...HOOK, ...REDIRECT_MODE }, { Authority: 'A8', Status: 'OK', orderId: 'o-5' })).toEqual([
      'webhook.ping',
      ['session.get', 'o-5'],
      ['errorlog', 'session_not_found'],
      ['res.redirect', 302, 'https://shop.test/result?kind=error&reason=verify_failed&gateway=zarinpal&ref=A8'],
      ['bale.failed', 'session_not_found'],
    ]);
  });

  test('sep success: RefNum is verified and becomes the webhook code', async () => {
    expect(await callback(HOOK, { RefNum: 'RF-1', ResNum: 'o-6', State: 'OK' })).toEqual([
      'webhook.ping',
      'sep.verify',
      ['event', 'payment_success', 'sep'],
      ['session.remove', 'o-6'],
      ['webhook.success', 'o-6', 'sep', 'RF-1', 5000000],
      ['res.redirect', 302, 'https://shop.test/payment/success'],
      ['bale.success', 'o-6'],
    ]);
  });

  test('sep user cancel: warning alert, event, failure webhook, 400 cancelled', async () => {
    expect(await callback({ ...HOOK, ...REDIRECT_MODE, PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f' }, { ResNum: 'o-7', State: 'CANCEL' })).toEqual([
      'webhook.ping',
      ['bale.warning', 'انصراف یا رد پرداخت SEP'],
      ['event', 'payment_warning', 'توسط کاربر انصراف داده شد'],
      ['webhook.failure', 'o-7', 'sep', 'توسط کاربر انصراف داده شد'],
      ['res.redirect', 302, 'https://shop.test/result?kind=error&reason=cancelled&gateway=sep&ref=o-7'],
    ]);
  });

  test('verify rejected: alert, error log, event, failure webhook, 400 verify_failed (verify_retry_failed on a retry)', async () => {
    const env = { ...HOOK, ...REDIRECT_MODE, PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f' };
    const first = load(env);
    mockGw.zibalVerify = async () => ({ result: 202, message: 'not paid' });
    mockLog.length = 0;
    await first.handlePaymentCallback({ query: { trackId: '777', orderId: 'o-8' }, body: {} }, fakeRes());
    await tick();
    expect(mockLog).toEqual([
      'webhook.ping',
      'zibal.verify',
      ['errorlog', 'verify_failed'],
      ['event', 'payment_error', 'Verification failed'],
      ['webhook.failure', 'o-8', 'zibal', 'Verification failed'],
      ['res.redirect', 302, 'https://shop.test/result?kind=error&reason=verify_failed&gateway=zibal&ref=777'],
      ['bale.failed', 'verify_failed'],
    ]);
    mockLog.length = 0;
    await first.handlePaymentCallback({ query: { trackId: '777', orderId: 'o-8', retry: 'true' }, body: {} }, fakeRes());
    await tick();
    expect(mockLog.find((e) => e[0] === 'res.redirect')[2]).toContain('reason=verify_retry_failed');
  });

  test('receiver slow or failing: paid, so the guest sees pending, and a failure is queued', async () => {
    const { handlePaymentCallback } = load({ ...HOOK, ...REDIRECT_MODE });
    mockGw.deliver = async () => ({ ok: false, error: 'down' });
    mockLog.length = 0;
    await handlePaymentCallback({ query: { trackId: '321', orderId: 'o-9' }, body: {} }, fakeRes());
    await tick();
    expect(mockLog).toEqual([
      'webhook.ping',
      'zibal.verify',
      ['event', 'payment_success', 'zibal'],
      ['session.remove', 'o-9'],
      ['webhook.success', 'o-9', 'zibal', '321', 5000000],
      ['queue.add', 'o-9'],
      ['res.redirect', 302, 'https://shop.test/result?kind=pending&gateway=zibal&ref=321'],
      ['bale.success', 'o-9'],
    ]);
  });
});

describe('create', () => {
  const run = async (env, req) => {
    const { createPaymentRequest } = load(env);
    mockLog.length = 0;
    await createPaymentRequest({ headers: {}, query: {}, body: {}, ...req }, fakeRes());
    return mockLog.slice();
  };

  test('a configured create secret is required', async () => {
    expect(await run({ PAYMENT_CREATE_SECRET: 's'.repeat(24) }, { body: { orderId: 'o', amount: 5000 } })).toEqual([
      ['res.status', 401], ['res.json', { error: 'Unauthorized' }],
    ]);
  });

  test('validation answers', async () => {
    expect((await run({}, { body: { amount: 5000 } })).pop()).toEqual(['res.json', { error: 'orderId is required' }]);
    expect((await run({}, { body: { orderId: 'a/b', amount: 5000 } })).pop()[1].error).toMatch(/orderId may contain only/);
    expect((await run({}, { body: { orderId: 'o' } })).pop()).toEqual(['res.json', { error: 'amount is required' }]);
    expect((await run({}, { body: { orderId: 'o', amount: -1 } })).pop()).toEqual(['res.json', { error: 'Invalid amount value' }]);
    const low = await run({}, { body: { orderId: 'o', amount: 500, gateway: 'sep' } });
    expect(low[0]).toEqual(['res.status', 422]);
    expect(low[1][1]).toMatchObject({ error: 'Amount below gateway minimum', minimum: 1000, received: 500 });
  });

  test('sep is tried first, zarinpal takes over when sep fails; the session is stored for the winner', async () => {
    const { createPaymentRequest } = load({});
    mockGw.sepRequest = async () => ({ Status: 0, ErrorDesc: 'down' });
    mockLog.length = 0;
    await createPaymentRequest({ headers: {}, query: {}, body: { orderId: 'o-10', amount: 7000, gateway: 'sep' } }, fakeRes());
    expect(mockLog).toEqual([
      'sep.request',
      ['event', 'payment_failover', 'down'],
      'zarinpal.request',
      ['session.save', 'o-10', 7000, 'zarinpal'],
      ['event', 'payment_initiated', 'zarinpal'],
      ['res.status', 200],
      ['res.json', { targetUrl: 'https://zp.test/pay/A1', gateway: 'zarinpal', orderId: 'o-10' }],
    ]);
  });

  test('every gateway failing: 400 Payment gateway error with the last reason', async () => {
    const { createPaymentRequest } = load({ PAYMENT_FAILOVER_ENABLED: 'false' });
    mockGw.zibalRequest = async () => ({ result: 102, message: 'bad merchant' });
    mockLog.length = 0;
    await createPaymentRequest({ headers: {}, query: {}, body: { orderId: 'o-11', amount: 7000, gateway: 'zibal' } }, fakeRes());
    expect(mockLog).toEqual([
      'zibal.request',
      ['event', 'payment_failover', 'bad merchant'],
      ['event', 'payment_error', 'bad merchant'],
      ['res.status', 400],
      ['res.json', { error: 'Payment gateway error', message: 'bad merchant' }],
    ]);
  });
});
