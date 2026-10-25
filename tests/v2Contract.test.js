'use strict';
// v2: the routes and the OpenAPI spec must agree, and every route answers in the v2 shape.
const mockSessions = new Map();
const mockGw = {};

jest.mock('../src/services/payment-gateway.service', () => ({
  ZARINPAL_PAY_BASE: 'https://zp.test/pay/',
  ZARINPAL_SANDBOX_PAY_BASE: 'https://zps.test/pay/',
  zibalRequestPayment: (a) => mockGw.zibalRequest(a),
  zarinpalRequestPayment: (a) => mockGw.zarinpalRequest(a),
  zarinpalSandboxRequestPayment: (a) => mockGw.zarinpalRequest(a),
  sepRequestPayment: (a) => mockGw.sepRequest(a),
  zibalVerifyPayment: (...a) => mockGw.zibalVerify(...a),
  zarinpalVerifyPayment: (...a) => mockGw.zarinpalVerify(...a),
  sepVerifyPayment: (...a) => mockGw.sepVerify(...a),
  getZarinpalUnverified: () => mockGw.unverified(),
}));
jest.mock('../src/services/payment-session.service', () => ({
  save: (id, s) => mockSessions.set(String(id), s), get: (id) => mockSessions.get(String(id)) || null, remove: () => {},
}));
jest.mock('../src/services/payment-queue.service', () => {
  const items = [{ id: 'q1', status: 'pending' }, { id: 'q2', status: 'dead' }, { id: 'q3', status: 'pending' }];
  return { getAllItems: () => items.slice(), removeItem: jest.fn() };
});
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: () => {}, readErrorLog: () => [{ n: 1 }, { n: 2 }, { n: 3 }] }));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: () => {} }));
jest.mock('../src/services/webhook.service', () => ({ pingWebhook: async () => ({ ok: true }), deliverSuccess: async () => ({ ok: true }), callWebhook: async () => ({ ok: true }), deliverFailure: async () => ({ ok: true }) }));
jest.mock('../src/services/notification.service', () => ({}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const axios = require('axios');

const KEYS = ['PAYMENT_CREATE_SECRET', 'ADMIN_KEY', 'ADMIN_READ_KEY', 'IDEMPOTENCY_FILE', 'FORCED_PAYMENT_GATEWAY', 'PAYMENT_FAILOVER_ENABLED'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const MONEY = 'm'.repeat(32);
const READ = 'r'.repeat(32);

let server;
let base;
let dir;
let queue;
let router;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-'));
  Object.assign(process.env, { IDEMPOTENCY_FILE: path.join(dir, 'k.json'), ADMIN_KEY: MONEY, ADMIN_READ_KEY: READ });
  delete process.env.PAYMENT_CREATE_SECRET;
  delete process.env.FORCED_PAYMENT_GATEWAY;
  delete process.env.PAYMENT_FAILOVER_ENABLED;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  router = require('../src/v2/routes');
  queue = require('../src/services/payment-queue.service');
  const app = express();
  app.use('/api/v2', router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v2`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});
beforeEach(() => {
  Object.assign(mockGw, {
    zibalRequest: async () => ({ result: 100, trackId: 'T1' }),
    zarinpalRequest: async () => ({ data: { code: 100, authority: 'A1' } }),
    sepRequest: async () => ({ Status: 1, Token: 'TK', RefNum: 'RN' }),
    zibalVerify: async () => ({ result: 100 }),
    zarinpalVerify: async () => ({ data: { code: 100 } }),
    sepVerify: async () => ({ Success: true }),
    unverified: async () => ({ ok: true, count: 3, authorities: ['a', 'b', 'c'] }),
  });
  queue.removeItem.mockClear();
});

const call = (method, url, { data, headers } = {}) => axios({ method, url: base + url, data, headers, validateStatus: () => true });
const money = { 'x-admin-key': MONEY };
const read = { 'x-admin-key': READ };

describe('the spec and the routes agree', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/v2/openapi.json'), 'utf8'));

  const mounted = () => {
    const rows = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) rows.push(`${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
    }
    return rows.sort();
  };
  const documented = () => Object.entries(spec.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();

  test('every mounted route is documented and every documented route is mounted', () => {
    expect(mounted()).toEqual(documented());
  });

  test('every status the routes can send is in the spec, 500 everywhere and 413 on every body-taking call', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/v2/routes.js'), 'utf8');
    const sent = new Set([...source.matchAll(/sendV2Error\(res, (\d{3})/g)].map((m) => m[1]).concat(['401', '403', '503', '201', '204', '200']));
    const documented = new Set(Object.values(spec.paths).flatMap((ops) => Object.values(ops).flatMap((op) => Object.keys(op.responses))));
    for (const status of sent) expect(documented).toContain(status);
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops)) {
        expect(op.responses['500']).toBeDefined();
        if (op.requestBody) expect(op.responses['413']).toBeDefined();
      }
    }
  });

  test('every operation lists the statuses the code can answer with, and every non-public one declares a key', () => {
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const [m, op] of Object.entries(ops)) {
        expect(op.operationId).toEqual(expect.any(String));
        expect(Object.keys(op.responses).length).toBeGreaterThan(0);
        if (p !== '/payments') expect(op.security).toEqual([{ adminKey: [] }]);
        else expect(m).toBe('post');
      }
    }
  });
});

describe('start a payment', () => {
  const body = { orderId: 'o-1', amount: 5000, gateway: 'zibal' };

  test('201 with the payment, and the session is stored', async () => {
    const res = await call('post', '/payments', { data: body });
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ targetUrl: 'https://gateway.zibal.ir/start/T1', gateway: 'zibal', orderId: 'o-1' });
    expect(mockSessions.get('o-1')).toMatchObject({ amount: 5000, gateway: 'zibal' });
  });

  test('errors are { error, code }', async () => {
    const missing = await call('post', '/payments', { data: { amount: 5000 } });
    expect(missing.status).toBe(400);
    expect(missing.data).toEqual({ error: 'orderId is required', code: 'order_id_required' });
    const low = await call('post', '/payments', { data: { orderId: 'o-2', amount: 10, gateway: 'sep' } });
    expect(low.status).toBe(400);
    expect(low.data).toMatchObject({ code: 'amount_below_minimum', minimum: 1000, received: 10 });
  });

  test('a query string is not a source of values in v2', async () => {
    const res = await call('post', '/payments?orderId=o-3&amount=5000');
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('order_id_required');
  });

  test('every gateway failing is 502 gateway_unavailable', async () => {
    mockGw.zibalRequest = async () => ({ result: 102, message: 'bad merchant' });
    const res = await call('post', '/payments', { data: { orderId: 'o-4', amount: 5000, gateway: 'zibal' } });
    expect(res.status).toBe(502);
    expect(res.data).toEqual({ error: 'No payment gateway could start the payment', code: 'gateway_unavailable' });
  });

  test('a malformed JSON body is a v2 error, not the v1 shape', async () => {
    const res = await call('post', '/payments', { data: '{"orderId":', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(res.data).toEqual({ error: 'bad request', code: 'bad_request' });
  });

  test('a configured create secret is required', async () => {
    process.env.PAYMENT_CREATE_SECRET = 's'.repeat(24);
    jest.resetModules();
    const fresh = require('../src/v2/routes');
    const app = express();
    app.use('/api/v2', fresh);
    const s = http.createServer(app);
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${s.address().port}/api/v2/payments`;
    const no = await axios.post(url, body, { validateStatus: () => true });
    const yes = await axios.post(url, { ...body, orderId: 'o-5' }, { headers: { 'x-internal-secret': 's'.repeat(24) }, validateStatus: () => true });
    await new Promise((resolve) => s.close(resolve));
    delete process.env.PAYMENT_CREATE_SECRET;
    expect(no.status).toBe(401);
    expect(no.data).toEqual({ error: 'unauthorized', code: 'unauthorized' });
    expect(yes.status).toBe(201);
  });

  describe('Idempotency-Key', () => {
    const key = { 'idempotency-key': 'key-0000-0001' };

    test('the same key and body returns the first answer without asking a bank again', async () => {
      let asked = 0;
      mockGw.zibalRequest = async () => { asked += 1; return { result: 100, trackId: `T${asked}` }; };
      const first = await call('post', '/payments', { data: { ...body, orderId: 'o-6' }, headers: key });
      const again = await call('post', '/payments', { data: { ...body, orderId: 'o-6' }, headers: key });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.data).toEqual(first.data);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(asked).toBe(1);
    });

    test('the same key with another body is 409 idempotency_key_reused', async () => {
      await call('post', '/payments', { data: { ...body, orderId: 'o-7' }, headers: { 'idempotency-key': 'key-0000-0002' } });
      const res = await call('post', '/payments', { data: { ...body, orderId: 'o-8' }, headers: { 'idempotency-key': 'key-0000-0002' } });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('idempotency_key_reused');
    });

    test('a call that is still running makes the same key 409 request_in_progress', async () => {
      let release;
      mockGw.zibalRequest = () => new Promise((resolve) => { release = () => resolve({ result: 100, trackId: 'SLOW' }); });
      const pending = call('post', '/payments', { data: { ...body, orderId: 'o-9' }, headers: { 'idempotency-key': 'key-0000-0003' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = await call('post', '/payments', { data: { ...body, orderId: 'o-9' }, headers: { 'idempotency-key': 'key-0000-0003' } });
      release();
      expect((await pending).status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.data.code).toBe('request_in_progress');
    });

    test('a bank failure (502) is not kept: the same key can try again', async () => {
      mockGw.zibalRequest = async () => ({ result: 102, message: 'down' });
      const k = { 'idempotency-key': 'key-0000-0004' };
      const first = await call('post', '/payments', { data: { ...body, orderId: 'o-10' }, headers: k });
      mockGw.zibalRequest = async () => ({ result: 100, trackId: 'OK' });
      const retry = await call('post', '/payments', { data: { ...body, orderId: 'o-10' }, headers: k });
      expect(first.status).toBe(502);
      expect(retry.status).toBe(201);
    });

    test('a key named like an object property is an ordinary key', async () => {
      for (const k of ['constructor', '__proto__x_y', 'hasOwnProperty']) {
        const res = await call('post', '/payments', { data: { ...body, orderId: `p-${k.length}` }, headers: { 'idempotency-key': k } });
        expect(res.status).toBe(201);
      }
    });

    test('the same call spelled another way replays instead of clashing', async () => {
      const k = { 'idempotency-key': 'key-0000-0005' };
      const first = await call('post', '/payments', { data: { orderId: 'o-20', amount: 5000, gateway: 'zibal' }, headers: k });
      const again = await call('post', '/payments', { data: { gateway: 'zibal', amount: '5000', orderId: 'o-20' }, headers: k });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
    });

    test('a call that blows up releases its key, so the next call is not stuck in progress', async () => {
      mockGw.zibalRequest = async () => { throw new Error('boom'); };
      const k = { 'idempotency-key': 'key-0000-0006' };
      const first = await call('post', '/payments', { data: { ...body, orderId: 'o-21' }, headers: k });
      mockGw.zibalRequest = async () => ({ result: 100, trackId: 'OK' });
      const second = await call('post', '/payments', { data: { ...body, orderId: 'o-21' }, headers: k });
      expect(first.status).toBe(500);
      expect(second.status).toBe(201);
    });

    test('a malformed key is 400 invalid_idempotency_key', async () => {
      const res = await call('post', '/payments', { data: body, headers: { 'idempotency-key': 'x' } });
      expect(res.status).toBe(400);
      expect(res.data.code).toBe('invalid_idempotency_key');
    });
  });
});

describe('admin routes', () => {
  test('refusals are v2-shaped: 401 without a key, 403 for a read key on a money route', async () => {
    const none = await call('get', '/payments/queue-items');
    expect(none.status).toBe(401);
    expect(none.data).toEqual({ error: 'unauthorized', code: 'unauthorized' });
    const wrong = await call('delete', '/payments/queue-items/q1', { headers: read });
    expect(wrong.status).toBe(403);
    expect(wrong.data).toEqual({ error: 'this key may only read', code: 'forbidden' });
  });

  test('lists are paginated with a total, an applied window and a cap', async () => {
    const res = await call('get', '/payments/queue-items?limit=2&offset=1', { headers: read });
    expect(res.data).toEqual({ items: [{ id: 'q2', status: 'dead' }, { id: 'q3', status: 'pending' }], total: 3, limit: 2, offset: 1 });
    const capped = await call('get', '/payments/error-log-entries?limit=999999', { headers: read });
    expect(capped.data.limit).toBe(200);
    expect(capped.data.items).toEqual([{ n: 3 }, { n: 2 }, { n: 1 }]); // newest first
  });

  test('a bad limit, offset or status is a 400 with a code', async () => {
    expect((await call('get', '/payments/queue-items?limit=abc', { headers: read })).data.code).toBe('invalid_limit');
    expect((await call('get', '/payments/error-log-entries?offset=-1', { headers: read })).data.code).toBe('invalid_offset');
    expect((await call('get', '/payments/queue-items?status=weird', { headers: read })).data.code).toBe('invalid_status');
  });

  test('queue items can be filtered by status', async () => {
    const res = await call('get', '/payments/queue-items?status=dead', { headers: read });
    expect(res.data.items).toEqual([{ id: 'q2', status: 'dead' }]);
  });

  test('deleting: 204 for an item, 404 for an unknown id', async () => {
    const ok = await call('delete', '/payments/queue-items/q1', { headers: money });
    expect(ok.status).toBe(204);
    expect(queue.removeItem).toHaveBeenCalledWith('q1');
    const missing = await call('delete', '/payments/queue-items/nope', { headers: money });
    expect(missing.status).toBe(404);
    expect(missing.data.code).toBe('queue_item_not_found');
  });

  test('unverified payments: paginated, or 502 when the bank does not answer', async () => {
    const ok = await call('get', '/payments/unverified-payments?limit=2', { headers: read });
    expect(ok.data).toEqual({ items: ['a', 'b'], total: 3, limit: 2, offset: 0 });
    mockGw.unverified = async () => ({ ok: false, error: 'timeout' });
    const down = await call('get', '/payments/unverified-payments', { headers: read });
    expect(down.status).toBe(502);
    expect(down.data.code).toBe('bank_unreachable');
  });

  test('verifications are a POST, need the money scope and answer 200 with verified true or false', async () => {
    const asked = { data: { gateway: 'zibal', code: '1' } };
    expect((await call('post', '/payments/verifications', { ...asked, headers: read })).status).toBe(403);
    const yes = await call('post', '/payments/verifications', { ...asked, headers: money });
    expect(yes.data).toEqual({ gateway: 'zibal', code: '1', verified: true });
    mockGw.sepVerify = async () => ({ Success: false });
    const no = await call('post', '/payments/verifications', { data: { gateway: 'sep', code: 'RF' }, headers: money });
    expect(no.status).toBe(200);
    expect(no.data.verified).toBe(false);
    expect((await call('post', '/payments/verifications', { data: { gateway: 'paypal', code: '1' }, headers: money })).data.code).toBe('unsupported_gateway');
    expect((await call('post', '/payments/verifications', { data: { code: '1' }, headers: money })).data.code).toBe('bad_request');
    for (const odd of [['zibal'], 'constructor', '__proto__']) {
      const res = await call('post', '/payments/verifications', { data: { gateway: odd, code: '1' }, headers: money });
      expect(res.data.code).toBe('unsupported_gateway');
    }
    const noAmount = await call('post', '/payments/verifications', { data: { gateway: 'zarinpal', code: 'A1' }, headers: money });
    expect(noAmount.status).toBe(400); // Zarinpal verifies against the amount, so a missing one is not a bank "no"
    const withAmount = await call('post', '/payments/verifications', { data: { gateway: 'zarinpal', code: 'A1', amount: 5000 }, headers: money });
    expect(withAmount.data).toEqual({ gateway: 'zarinpal', code: 'A1', verified: true });
    expect((await call('get', '/payments/verifications?gateway=zibal&code=1', { headers: money })).status).toBe(404); // not a GET any more
  });

  test('a gateway that is not configured is 503 not_configured, not a bank outage', async () => {
    mockGw.unverified = async () => ({ ok: false, code: 'not_configured', error: 'ZARINPAL_MERCHANT not configured' });
    const res = await call('get', '/payments/unverified-payments', { headers: read });
    expect(res.status).toBe(503);
    expect(res.data.code).toBe('not_configured');
  });

  test('an unknown path under v2 is a v2 404', async () => {
    const res = await call('get', '/nope', { headers: money });
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ error: 'not found', code: 'not_found' });
  });
});
