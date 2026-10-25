'use strict';
// CALLBACK_REPLAY_GUARD=true: a bank callback that arrives twice for one payment is verified, handed
// to the receiver and announced once. With the guard off nothing here applies (the other callback
// tests run with it off).
// The suite loads the whole callback path per case: on a cold CI runner one case passed 5 s and failed (2 runs).
jest.setTimeout(30000);

const mockLog = [];
const mockGw = {};

jest.mock('../src/services/payment-gateway.service', () => ({
  zibalVerifyPayment: async (...a) => { mockLog.push('zibal.verify'); return mockGw.zibalVerify(...a); },
  zarinpalVerifyPayment: async (...a) => { mockLog.push('zarinpal.verify'); return mockGw.zarinpalVerify(...a); },
  zarinpalSandboxVerifyPayment: async () => ({}),
  sepVerifyPayment: async () => ({}),
}));
jest.mock('../src/services/webhook.service', () => ({
  pingWebhook: async () => ({ ok: true }),
  deliverSuccess: async (url, payload) => { mockLog.push(['webhook.success', payload.orderId]); return mockGw.deliver(); },
  callWebhook: async () => ({ ok: true }),
  deliverFailure: async () => ({ ok: true }),
}));
jest.mock('../src/services/payment-queue.service', () => ({ addToQueue: () => {} }));
jest.mock('../src/services/payment-session.service', () => {
  const sessions = new Map([['o-z', { amount: 2500000 }]]);
  return { get: (id) => sessions.get(String(id)) || null, remove: (id) => { mockLog.push(['session.remove', id]); sessions.delete(String(id)); }, save: () => {} };
});
jest.mock('../src/services/notification.service', () => ({
  sendErrorNotificationToBale: async () => {},
  sendFailedPaymentNotificationToBale: async (d) => { mockLog.push(['bale.failed', d.stage]); },
  sendPaymentSuccessNotificationToBale: async (d) => { mockLog.push(['bale.success', d.orderId]); },
  sendWarningNotificationToBale: async () => {},
  sendBaleRecoveryMessage: async () => {},
}));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: (name) => mockLog.push(['event', name]) }));
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: () => {}, readErrorLog: () => [] }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = ['CALLBACK_REPLAY_GUARD', 'VERIFIED_LEDGER_FILE', 'FRONT_BASE_URL', 'FRONT_FAILURE_URL', 'PAYMENT_SUCCESS_WEBHOOK_URL', 'SUCCESS_HANDOFF_WAIT_MS', 'FRONT_SUCCESS_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const fakeRes = () => ({
  status(code) { mockLog.push(['res.status', code]); return this; },
  json(body) { mockLog.push(['res.json', body]); return this; },
  redirect(code, url) { mockLog.push(['res.redirect', code, url]); return this; },
});

function load(env) {
  jest.resetModules();
  mockLog.length = 0;
  KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, {
    FRONT_BASE_URL: 'https://shop.test', PAYMENT_SUCCESS_WEBHOOK_URL: 'http://receiver.test/s',
    CALLBACK_REPLAY_GUARD: 'true', VERIFIED_LEDGER_FILE: path.join(dir, 'ledger.json'),
  }, env);
  Object.assign(mockGw, {
    deliver: async () => ({ ok: true }),
    zibalVerify: async () => ({ result: 100, amount: 5000000 }),
    zarinpalVerify: async () => ({ data: { code: 100 } }),
  });
  return require('../src/controllers/payment.controller').handlePaymentCallback;
}

// The first load of the controller tree compiles every file; on a cold CI runner that alone took longer than a
// test's 5 s. Pay it once here (the tests then reload from a warm cache).
beforeAll(() => { require('../src/controllers/payment.controller'); jest.resetModules(); }, 30000);

async function arrive(handler, query) {
  mockLog.length = 0;
  await handler({ query, body: {} }, fakeRes());
  await tick();
  return mockLog.slice();
}

test('a zibal payment is taken once; the second callback asks no bank, tells no one, and lands on success', async () => {
  const handler = load({});
  const first = await arrive(handler, { trackId: '555', orderId: 'o-1' });
  expect(first.filter((e) => e[0] === 'webhook.success' || e[0] === 'bale.success').length).toBe(2);
  const second = await arrive(handler, { trackId: '555', orderId: 'o-1' });
  expect(second).toEqual([
    ['event', 'payment_replay'],
    ['res.redirect', 302, 'https://shop.test/payment/success'],
  ]);
});

test('a zarinpal replay after the session is gone is a replay, not a false "session not found" failure', async () => {
  const handler = load({});
  await arrive(handler, { Authority: 'A1', Status: 'OK', orderId: 'o-z' });
  const second = await arrive(handler, { Authority: 'A1', Status: 'OK', orderId: 'o-z' });
  expect(second).toEqual([
    ['event', 'payment_replay'],
    ['res.redirect', 302, 'https://shop.test/payment/success'],
  ]);
});

test('a hand-over that was still pending replays to the pending page', async () => {
  const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result' });
  mockGw.deliver = async () => ({ ok: true, pending: true });
  await arrive(handler, { trackId: '777', orderId: 'o-2' });
  const second = await arrive(handler, { trackId: '777', orderId: 'o-2' });
  expect(second[1]).toEqual(['res.redirect', 302, 'https://shop.test/result?kind=pending&gateway=zibal&ref=777']);
});

test('a refused booking replays to the refused result', async () => {
  const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result' });
  mockGw.deliver = async () => ({ ok: false, refused: true });
  await arrive(handler, { trackId: '888', orderId: 'o-3' });
  const second = await arrive(handler, { trackId: '888', orderId: 'o-3' });
  expect(second[1][2]).toBe('https://shop.test/result?kind=error&reason=booking_refused&gateway=zibal&ref=888');
});

test('two callbacks racing: both verify, only one hands the payment over', async () => {
  const handler = load({});
  const releases = [];
  mockGw.zibalVerify = () => new Promise((resolve) => { releases.push(() => resolve({ result: 100, amount: 1 })); });
  mockLog.length = 0;
  const a = handler({ query: { trackId: '999', orderId: 'o-4' }, body: {} }, fakeRes());
  await tick();
  const b = handler({ query: { trackId: '999', orderId: 'o-4' }, body: {} }, fakeRes());
  await tick();
  expect(releases.length).toBe(2); // both callbacks reached the bank
  releases.forEach((release) => release());
  await Promise.all([a, b]);
  await tick();
  expect(mockLog.filter((e) => e[0] === 'webhook.success').length).toBe(1);
  expect(mockLog.filter((e) => e[0] === 'bale.success').length).toBe(1);
});

test('a different payment is not a replay, and a failed verify leaves nothing behind', async () => {
  const handler = load({});
  mockGw.zibalVerify = async () => ({ result: 202 });
  await arrive(handler, { trackId: '111', orderId: 'o-5' });
  mockGw.zibalVerify = async () => ({ result: 100, amount: 1 });
  const retry = await arrive(handler, { trackId: '111', orderId: 'o-5' });
  expect(retry.some((e) => e[0] === 'webhook.success')).toBe(true);
  const other = await arrive(handler, { trackId: '222', orderId: 'o-6' });
  expect(other.some((e) => e[0] === 'webhook.success')).toBe(true);
});

test('guard off (the default): a second callback verifies and announces again, as before', async () => {
  const handler = load({ CALLBACK_REPLAY_GUARD: 'false' });
  await arrive(handler, { trackId: '555', orderId: 'o-7' });
  const second = await arrive(handler, { trackId: '555', orderId: 'o-7' });
  expect(second.filter((e) => e[0] === 'webhook.success').length).toBe(1);
  expect(fs.existsSync(path.join(dir, 'ledger.json'))).toBe(false);
});

describe('the guard never swallows a payment that was not handed over', () => {
  const ledgerFile = () => path.join(dir, 'ledger.json');

  test('the first callback throws after it claimed the payment: the retry is processed, not called a replay', async () => {
    const handler = load({ SUCCESS_HANDOFF_WAIT_MS: '20' }); // a throwing hand-over leaves the wait timer running; keep it short
    mockGw.deliver = async () => { throw new Error('receiver exploded'); };
    mockLog.length = 0;
    await expect(handler({ query: { trackId: '333', orderId: 'o-8' }, body: {} }, fakeRes())).rejects.toThrow('receiver exploded');
    mockGw.deliver = async () => ({ ok: true });
    const retry = await arrive(handler, { trackId: '333', orderId: 'o-8' });
    expect(retry.some((e) => e[0] === 'webhook.success')).toBe(true);
    expect(retry.some((e) => e[0] === 'event' && e[1] === 'payment_replay')).toBe(false);
  });

  test('a claim that was never settled (the process died) goes stale and the next callback processes the payment', async () => {
    const handler = load({});
    fs.writeFileSync(ledgerFile(), JSON.stringify({ 'zibal:444': { at: Date.now() - 3 * 60 * 1000, outcome: 'claimed', orderId: 'o-9' } }));
    const retry = await arrive(handler, { trackId: '444', orderId: 'o-9' });
    expect(retry.some((e) => e[0] === 'webhook.success')).toBe(true);
  });

  test('a fresh claim (another callback is handing it over right now) replays to the pending page', async () => {
    const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result' });
    fs.writeFileSync(ledgerFile(), JSON.stringify({ 'zibal:445': { at: Date.now(), outcome: 'claimed', orderId: 'o-10' } }));
    const second = await arrive(handler, { trackId: '445', orderId: 'o-10' });
    expect(second[1][2]).toBe('https://shop.test/result?kind=pending&gateway=zibal&ref=445');
  });

  test('a receiver that answers after the guest moved on settles the payment as done', async () => {
    const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result', SUCCESS_HANDOFF_WAIT_MS: '30' });
    // released by hand, not by a timer: a fixed 150 ms receiver raced the guest's second callback and flaked on a loaded runner
    let release;
    mockGw.deliver = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
    const first = await arrive(handler, { trackId: '555', orderId: 'o-11' });
    expect(first.find((e) => e[0] === 'res.redirect')[2]).toContain('kind=pending');
    const during = await arrive(handler, { trackId: '555', orderId: 'o-11' });
    expect(during[1][2]).toContain('kind=pending');
    expect(during.some((e) => e[0] === 'webhook.success')).toBe(false);
    release();
    await tick();
    const after = await arrive(handler, { trackId: '555', orderId: 'o-11' });
    expect(after[1]).toEqual(['res.redirect', 302, 'https://shop.test/payment/success']);
    expect(after.some((e) => e[0] === 'webhook.success')).toBe(false);
  });

  test('a queued hand-over that the retry worker later delivers settles the payment as done', async () => {
    const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result' });
    mockGw.deliver = async () => ({ ok: false, error: 'down' });
    await arrive(handler, { trackId: '666', orderId: 'o-12' });
    expect(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))['zibal:666'].outcome).toBe('pending');
    mockGw.deliver = async () => ({ ok: true });
    await require('../src/controllers/payment.controller').processQueuedWebhook({ id: 'q', orderId: 'o-12', gateway: 'zibal', code: '666', verifyDetails: {}, retryCount: 1 });
    expect(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))['zibal:666'].outcome).toBe('done');
  });

  test('retry=true takes over a hand-over that was only queued (its queue item may have died); a plain callback does not', async () => {
    const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result' });
    mockGw.deliver = async () => ({ ok: false, error: 'down' }); // queued, ledger says pending
    await arrive(handler, { trackId: '910', orderId: 'o-14' });
    const plain = await arrive(handler, { trackId: '910', orderId: 'o-14' });
    expect(plain.some((e) => e[0] === 'webhook.success')).toBe(false);
    mockGw.deliver = async () => ({ ok: true });
    const retry = await arrive(handler, { trackId: '910', orderId: 'o-14', retry: 'true' });
    expect(retry.some((e) => e[0] === 'webhook.success')).toBe(true);
    expect(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))['zibal:910'].outcome).toBe('done');
    // and once it is done, even a retry is only a replay
    const again = await arrive(handler, { trackId: '910', orderId: 'o-14', retry: 'true' });
    expect(again.some((e) => e[0] === 'webhook.success')).toBe(false);
  });

  test('retry=true never takes over a refused booking', async () => {
    const handler = load({ FRONT_FAILURE_URL: 'https://shop.test/result' });
    mockGw.deliver = async () => ({ ok: false, refused: true });
    await arrive(handler, { trackId: '911', orderId: 'o-15' });
    const retry = await arrive(handler, { trackId: '911', orderId: 'o-15', retry: 'true' });
    expect(retry.some((e) => e[0] === 'webhook.success')).toBe(false);
  });

  test('a junk entry in the ledger file (null, a string) is dropped, not a crash', async () => {
    const handler = load({});
    fs.writeFileSync(ledgerFile(), JSON.stringify({ 'zibal:1': null, 'zibal:2': 'oops', 'zibal:3': { outcome: 'done' } }));
    const log = await arrive(handler, { trackId: '912', orderId: 'o-16' });
    expect(log.some((e) => e[0] === 'webhook.success')).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))).sort()).toEqual(['zibal:912']);
  });

  test('a replay is redirected with the order id the first callback recorded, not the one the request claims', async () => {
    const handler = load({ FRONT_SUCCESS_URL: 'https://shop.test/receipt/{orderId}' });
    await arrive(handler, { trackId: '777', orderId: 'real-1' });
    const forged = await arrive(handler, { trackId: '777', orderId: 'attacker' });
    expect(forged[1]).toEqual(['res.redirect', 302, 'https://shop.test/receipt/real-1']);
  });

  test('a ledger that cannot be written raises an alert instead of failing silently', async () => {
    const handler = load({});
    fs.writeFileSync(path.join(dir, 'blocker'), 'x');
    process.env.VERIFIED_LEDGER_FILE = path.join(dir, 'blocker', 'ledger.json');
    jest.resetModules();
    const fresh = require('../src/controllers/payment.controller').handlePaymentCallback;
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const events = [];
    require('../src/alerts').onAlertEvent((name, data) => events.push([name, data.orderId]));
    const log = await arrive(fresh, { trackId: '888', orderId: 'o-13' });
    expect(err.mock.calls.some((c) => String(c[0]).includes('replay_ledger_write_failed'))).toBe(true);
    expect(events).toEqual([['replay_ledger_write_failed', 'o-13']]);
    err.mockRestore();
    expect(log.some((e) => e[0] === 'webhook.success')).toBe(true); // the payment is still handed over
    void handler;
  });
});
