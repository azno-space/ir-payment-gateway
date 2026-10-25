'use strict';
// Second half of the characterization: the refusal branches, the other bank outcomes and the
// arguments sent to the banks. Written against the code before it was split, and run on both.
const mockLog = [];
const mockGw = {};

jest.mock('../src/services/payment-gateway.service', () => ({
  ZARINPAL_PAY_BASE: 'https://zp.test/pay/',
  ZARINPAL_SANDBOX_PAY_BASE: 'https://zps.test/pay/',
  zibalVerifyPayment: (...a) => { mockLog.push(['zibal.verify', ...a]); return mockGw.zibalVerify(); },
  zarinpalVerifyPayment: (...a) => { mockLog.push(['zarinpal.verify', ...a]); return mockGw.zarinpalVerify(); },
  zarinpalSandboxVerifyPayment: (...a) => { mockLog.push(['zarinpalSandbox.verify', ...a]); return mockGw.zarinpalVerify(); },
  sepVerifyPayment: (...a) => { mockLog.push(['sep.verify', ...a]); return mockGw.sepVerify(); },
  zibalRequestPayment: (a) => { mockLog.push(['zibal.request', a]); return mockGw.zibalRequest(); },
  zarinpalRequestPayment: (a) => { mockLog.push(['zarinpal.request', a]); return mockGw.zarinpalRequest(); },
  zarinpalSandboxRequestPayment: (a) => { mockLog.push(['zarinpalSandbox.request', a]); return mockGw.zarinpalRequest(); },
  sepRequestPayment: (a) => { mockLog.push(['sep.request', a]); return mockGw.sepRequest(); },
}));
jest.mock('../src/services/webhook.service', () => ({
  pingWebhook: async () => ({ ok: true }),
  deliverSuccess: async (url, payload) => { mockLog.push(['webhook.success', payload.verifyDetails]); return mockGw.deliver(); },
  deliverFailure: async (url, payload) => { mockLog.push(['webhook.failure', payload.orderId, payload.reason]); return { ok: true }; },
}));
jest.mock('../src/services/payment-queue.service', () => ({ addToQueue: () => {} }));
jest.mock('../src/services/payment-session.service', () => ({
  save: () => {}, get: () => ({ amount: 2500000 }), remove: () => {},
}));
jest.mock('../src/services/notification.service', () => ({
  sendErrorNotificationToBale: async () => {},
  sendFailedPaymentNotificationToBale: async () => {},
  sendPaymentSuccessNotificationToBale: async () => {},
  sendWarningNotificationToBale: async (d) => { mockLog.push(['bale.warning', d.cancelReason]); },
  sendBaleRecoveryMessage: async () => {},
}));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: (name, d = {}) => mockLog.push(['event', name, d.reason || d.gateway || null]) }));
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: () => {}, readErrorLog: () => [] }));

const ENV_KEYS = ['FRONT_BASE_URL', 'FRONT_SUCCESS_URL', 'FRONT_FAILURE_URL', 'PAYMENT_SUCCESS_WEBHOOK_URL',
  'PAYMENT_FAILURE_WEBHOOK_URL', 'PAYMENT_CREATE_SECRET', 'FORCED_PAYMENT_GATEWAY', 'PAYMENT_FAILOVER_ENABLED'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

const tick = () => new Promise((resolve) => setImmediate(resolve));
const fakeRes = () => ({
  status(code) { mockLog.push(['res.status', code]); return this; },
  json(body) { mockLog.push(['res.json', body]); return this; },
  redirect(code, url) { mockLog.push(['res.redirect', code, url]); return this; },
});

function load(env = {}) {
  jest.resetModules();
  mockLog.length = 0;
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, { FRONT_BASE_URL: 'https://shop.test', PAYMENT_SUCCESS_WEBHOOK_URL: 'http://receiver.test/s' }, env);
  Object.assign(mockGw, {
    deliver: async () => ({ ok: true }),
    zibalVerify: async () => ({ result: 100, amount: 5000000, paidAt: 'P', cardNumber: 'C', refNumber: 'R', description: 'D', message: 'ok', status: 1, orderId: 'Z' }),
    zarinpalVerify: async () => ({ data: { code: 100, card_pan: 'PAN', ref_id: 7, message: 'm', fee: 5, fee_type: 'Merchant' } }),
    sepVerify: async () => ({ Success: true, TransactionDetail: { OrginalAmount: 5000000 } }),
    zibalRequest: async () => ({ result: 100, trackId: 'T1' }),
    zarinpalRequest: async () => ({ data: { code: 100, authority: 'A1' } }),
    sepRequest: async () => ({ Status: 1, Token: 'TK', RefNum: 'RN' }),
  });
  return require('../src/controllers/payment.controller');
}

async function cb(env, query, mutate) {
  const c = load(env);
  if (mutate) mutate();
  mockLog.length = 0;
  await c.handlePaymentCallback({ query, body: {} }, fakeRes());
  await tick();
  return mockLog.slice();
}
const last = (log, name) => log.filter((e) => e[0] === name).pop();

describe('callback refusals', () => {
  test('an array order id is refused before anything else', async () => {
    const log = await cb({}, { trackId: '1', orderId: ['a', 'b'] });
    expect(log).toEqual([
      ['event', 'payment_warning', 'Non-string payment reference rejected'],
      ['res.status', 400],
      ['res.json', { success: false, error: { code: 'incomplete_params' } }],
    ]);
  });

  test('a malformed order id is refused before any bank call', async () => {
    const log = await cb({}, { RefNum: 'R', ResNum: 'a/../b', State: 'OK' });
    expect(log).toEqual([
      ['event', 'payment_warning', 'Malformed order id rejected'],
      ['res.status', 400],
      ['res.json', { success: false, error: { code: 'incomplete_params' } }],
    ]);
  });

  test('a SEP signal with no RefNum and no ResNum is a cancel', async () => {
    const log = await cb({}, { State: 'CANCEL' });
    expect(last(log, 'res.json')).toEqual(['res.json', { success: false, error: { code: 'cancelled' } }]);
  });

  test('an unknown query is incomplete, not a cancel', async () => {
    const log = await cb({}, { foo: 'bar' });
    expect(last(log, 'res.json')).toEqual(['res.json', { success: false, error: { code: 'incomplete_params' } }]);
  });

  test('a failure without an order id sends no failure webhook', async () => {
    const log = await cb({ PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f' }, { State: 'CANCEL' });
    expect(log.find((e) => e[0] === 'webhook.failure')).toBeUndefined();
  });
});

describe('callback bank outcomes', () => {
  test('zibal: the bank is asked for the track id and the receiver gets every verify field', async () => {
    const log = await cb({}, { trackId: '555', orderId: 'o-1' });
    expect(last(log, 'zibal.verify')).toEqual(['zibal.verify', '555']);
    expect(last(log, 'webhook.success')[1]).toEqual({
      paid_at: 'P', card_number: 'C', ref_number: 'R', description: 'D', zibal_result: 100, zibal_message: 'ok',
      zibal_status: 1, zibal_order_id: 'Z', zibal_amount: 5000000, charged_rial: 5000000,
    });
  });

  test('zibal answering 201 (already verified) counts as paid', async () => {
    const log = await cb({}, { trackId: '1', orderId: 'o-2' }, () => { mockGw.zibalVerify = async () => ({ result: 201, amount: 1000 }); });
    expect(last(log, 'webhook.success')[1].charged_rial).toBe(1000);
  });

  test('zarinpal: verified against the stored amount; the receiver gets the card, ref and fee', async () => {
    const log = await cb({}, { Authority: 'A9', Status: 'OK', orderId: 'o-3' });
    expect(last(log, 'zarinpal.verify')).toEqual(['zarinpal.verify', 'A9', 2500000]);
    expect(last(log, 'webhook.success')[1]).toEqual({
      card_number: 'PAN', ref_number: 7, zarinpal_code: 100, zarinpal_message: 'm', zarinpal_fee: 5,
      zarinpal_fee_type: 'Merchant', charged_rial: 2500000,
    });
  });

  test('zarinpal answering 101 (already verified) counts as paid', async () => {
    const log = await cb({}, { Authority: 'A9', Status: 'OK', orderId: 'o-3' }, () => { mockGw.zarinpalVerify = async () => ({ data: { code: 101 } }); });
    expect(last(log, 'webhook.success')).toBeDefined();
  });

  test('zarinpal rejected: its own message is the failure reason', async () => {
    const log = await cb({ PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f' }, { Authority: 'A9', Status: 'OK', orderId: 'o-4' },
      () => { mockGw.zarinpalVerify = async () => ({ data: { code: -50, message: 'amount mismatch' } }); });
    expect(last(log, 'webhook.failure')).toEqual(['webhook.failure', 'o-4', 'amount mismatch']);
    expect(last(log, 'event')).toEqual(['event', 'payment_error', 'amount mismatch']);
  });

  test('zarinpal_sandbox is not reachable from a callback (the parser reads Authority as zarinpal)', async () => {
    const log = await cb({}, { Authority: 'A9', Status: 'OK', orderId: 'o-5' });
    expect(log.find((e) => e[0] === 'zarinpalSandbox.verify')).toBeUndefined();
  });

  test('sep: the RefNum from the callback is verified', async () => {
    const log = await cb({}, { RefNum: 'RF-1', ResNum: 'o-6', State: 'OK' });
    expect(last(log, 'sep.verify')).toEqual(['sep.verify', 'RF-1']);
    expect(last(log, 'webhook.success')[1].metadata.data).toMatchObject({ RefNum: 'RF-1', ResNum: 'o-6', State: 'OK' });
  });

  test('sep: Status=2 alone confirms the callback', async () => {
    const log = await cb({}, { RefNum: 'RF-2', ResNum: 'o-7', Status: '2' });
    expect(last(log, 'sep.verify')).toEqual(['sep.verify', 'RF-2']);
  });

  test('sep verify says no: verify_failed with the bank text only in the logs', async () => {
    const log = await cb({ FRONT_FAILURE_URL: 'https://shop.test/result' }, { RefNum: 'RF-3', ResNum: 'o-8', State: 'OK' },
      () => { mockGw.sepVerify = async () => ({ Success: false, ResultDescription: 'declined' }); });
    expect(last(log, 'res.redirect')[2]).toBe('https://shop.test/result?kind=error&reason=verify_failed&gateway=sep&ref=RF-3');
    expect(last(log, 'event')).toEqual(['event', 'payment_error', 'declined']);
  });

  test('sep verify throws: verify_failed, the exception text is the reason', async () => {
    const log = await cb({ PAYMENT_FAILURE_WEBHOOK_URL: 'http://receiver.test/f' }, { RefNum: 'RF-4', ResNum: 'o-9', State: 'OK' },
      () => { mockGw.sepVerify = async () => { throw new Error('socket hang up'); }; });
    expect(last(log, 'webhook.failure')).toEqual(['webhook.failure', 'o-9', 'Verify exception: socket hang up']);
  });

  test('sep with no state and no status: the log says the bank sent nothing usable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = await cb({}, { RefNum: 'RF-5', ResNum: 'o-10' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('sep_callback_no_response'))).toBe(true);
    warn.mockRestore();
    expect(last(log, 'bale.warning')).toEqual(['bale.warning', 'درگاه پاسخ صحیحی ارسال نکرد']);
  });

  test('sep bank-declined (NOK) is a warning only, with its own cancel text', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = await cb({}, { RefNum: 'RF-6', ResNum: 'o-11', State: 'NOK' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('sep_callback_no_response'))).toBe(false);
    warn.mockRestore();
    expect(last(log, 'bale.warning')).toEqual(['bale.warning', 'توسط درگاه یا بانک رد شد']);
  });
});

describe('callback hand-off in JSON mode and with a refusing receiver', () => {
  test('a refused or pending hand-off without a front failure URL still redirects to the success page', async () => {
    const refused = await cb({}, { trackId: '1', orderId: 'o-12' }, () => { mockGw.deliver = async () => ({ ok: false, refused: true }); });
    expect(last(refused, 'res.redirect')).toEqual(['res.redirect', 302, 'https://shop.test/payment/success']);
    const pending = await cb({}, { trackId: '1', orderId: 'o-13' }, () => { mockGw.deliver = async () => ({ ok: true, pending: true }); });
    expect(last(pending, 'res.redirect')).toEqual(['res.redirect', 302, 'https://shop.test/payment/success']);
  });

  test('with a front failure URL a refused order is 409 booking_refused', async () => {
    const log = await cb({ FRONT_FAILURE_URL: 'https://shop.test/result' }, { trackId: '1', orderId: 'o-14' },
      () => { mockGw.deliver = async () => ({ ok: false, refused: true }); });
    expect(last(log, 'res.redirect')[2]).toBe('https://shop.test/result?kind=error&reason=booking_refused&gateway=zibal&ref=1');
  });

  test('a skipped hand-off (no receiver configured) goes straight to the success page', async () => {
    const log = await cb({ PAYMENT_SUCCESS_WEBHOOK_URL: '' }, { trackId: '1', orderId: 'o-15' },
      () => { mockGw.deliver = async () => ({ ok: true, skipped: true }); });
    expect(last(log, 'res.redirect')).toEqual(['res.redirect', 302, 'https://shop.test/payment/success']);
  });
});

describe('create arguments', () => {
  const create = async (env, req, mutate) => {
    const c = load(env);
    if (mutate) mutate();
    mockLog.length = 0;
    await c.createPaymentRequest({ headers: {}, query: {}, body: {}, ...req }, fakeRes());
    return mockLog.slice();
  };

  test('values may come from the query string; the mobile reaches the bank', async () => {
    const log = await create({}, { query: { orderId: 'q-1', amount: '5000', mobile: '09120000000', gateway: 'zibal' } });
    expect(last(log, 'zibal.request')).toEqual(['zibal.request', { amount: 5000, orderId: 'q-1', mobile: '09120000000', timeout: 15000, retries: 2 }]);
  });

  test('the last gateway of the chain gets the long timeout and retries; earlier ones none', async () => {
    const log = await create({}, { body: { orderId: 'q-2', amount: 5000, gateway: 'sep' } }, () => { mockGw.sepRequest = async () => ({ Status: 0 }); });
    expect(log.find((e) => e[0] === 'sep.request')[1]).toEqual({ amount: 5000, orderId: 'q-2', mobile: '' });
    expect(log.find((e) => e[0] === 'zarinpal.request')[1]).toEqual({ amount: 5000, orderId: 'q-2', mobile: '', timeout: 15000, retries: 2 });
  });

  test('FORCED_PAYMENT_GATEWAY wins over the request; an invalid one is ignored', async () => {
    const forced = await create({ FORCED_PAYMENT_GATEWAY: 'zibal' }, { body: { orderId: 'q-3', amount: 5000, gateway: 'sep' } });
    expect(forced.find((e) => e[0] === 'zibal.request')).toBeDefined();
    expect(forced.find((e) => e[0] === 'sep.request')).toBeUndefined();
    const invalid = await create({ FORCED_PAYMENT_GATEWAY: 'nope' }, { body: { orderId: 'q-4', amount: 5000, gateway: 'zibal' } });
    expect(invalid.find((e) => e[0] === 'zibal.request')).toBeDefined();
  });

  test('an unknown requested gateway falls back to zarinpal', async () => {
    const log = await create({}, { body: { orderId: 'q-5', amount: 5000, gateway: 'paypal' } });
    expect(log.find((e) => e[0] === 'zarinpal.request')).toBeDefined();
  });

  test('success shapes: zibal, zarinpal sandbox, sep', async () => {
    const zibal = await create({}, { body: { orderId: 'q-6', amount: 5000, gateway: 'zibal' } });
    expect(last(zibal, 'res.json')[1]).toEqual({ targetUrl: 'https://gateway.zibal.ir/start/T1', gateway: 'zibal', orderId: 'q-6' });
    const sandbox = await create({}, { body: { orderId: 'q-7', amount: 5000, gateway: 'zarinpal_sandbox' } });
    expect(last(sandbox, 'res.json')[1]).toEqual({ targetUrl: 'https://zps.test/pay/A1', gateway: 'zarinpal_sandbox', orderId: 'q-7' });
    const sep = await create({}, { body: { orderId: 'q-8', amount: 5000, gateway: 'sep' } });
    expect(last(sep, 'res.json')[1]).toEqual({ targetUrl: 'https://sep.shaparak.ir/OnlinePG/SendToken?token=TK', gateway: 'sep', orderId: 'q-8' });
  });

  test('a bank call that throws is a 500 with no internal text', async () => {
    const log = await create({}, { body: { orderId: 'q-9', amount: 5000, gateway: 'zibal' } }, () => { mockGw.zibalRequest = async () => { throw new Error('secret internals'); }; });
    expect(last(log, 'res.status')).toEqual(['res.status', 500]);
    expect(last(log, 'res.json')).toEqual(['res.json', { error: 'Internal server error' }]);
  });
});
