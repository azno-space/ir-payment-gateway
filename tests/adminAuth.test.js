'use strict';
// Phase 3: one admin checker, header key, constant-time, two scopes (read / money).
jest.mock('../src/services/payment-gateway.service', () => ({}));
jest.mock('../src/services/payment-queue.service', () => ({ getAllItems: jest.fn(() => []), removeItem: jest.fn() }));
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: jest.fn(), readErrorLog: jest.fn(() => []) }));
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAdminAuth } = require('../src/utils/adminAuth');

const MONEY = 'm'.repeat(40);
const READ = 'r'.repeat(40);
const auth = createAdminAuth({ moneyKeys: [MONEY], readKeys: [READ] });
const res = () => {
  const r = {};
  r.status = jest.fn((c) => { r.statusCode = c; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
};
const run = (mw, headers = {}, query = {}) => {
  const r = res(); const next = jest.fn();
  mw({ headers, query, originalUrl: `/api/payments/admin/x?token=${query.token || ''}` }, r, next);
  return { status: next.mock.calls.length ? 'next' : r.statusCode, body: r.body };
};
const bearer = (k) => ({ authorization: `Bearer ${k}` });

test('read key: read OK, money 403', () => {
  expect(run(auth.read, bearer(READ)).status).toBe('next');
  expect(run(auth.money, bearer(READ))).toEqual({ status: 403, body: { success: false, error: { code: 'forbidden', message: 'this key may only read' } } });
});

test('money key passes both scopes; x-admin-key header works too', () => {
  expect(run(auth.read, bearer(MONEY)).status).toBe('next');
  expect(run(auth.money, bearer(MONEY)).status).toBe('next');
  expect(run(auth.money, { 'x-admin-key': MONEY }).status).toBe('next');
});

test('no key / wrong key → 401 in the one error shape', () => {
  const want = { status: 401, body: { success: false, error: { code: 'unauthorized' } } };
  expect(run(auth.read, {})).toEqual(want);
  expect(run(auth.money, bearer('nope'))).toEqual(want);
  expect(run(auth.read, { authorization: MONEY })).toEqual(want); // not "Bearer "
});

test('no key configured → 503, never open', () => {
  const none = createAdminAuth({ moneyKeys: ['', undefined], readKeys: [] });
  expect(run(none.money, bearer('')).status).toBe(503);
  expect(run(none.read, {}).body.error.code).toBe('admin_auth_not_configured');
});

test('a key in ?token= is refused: header only', () => {
  expect(run(auth.money, {}, { token: MONEY }).status).toBe(401);
  expect(run(auth.money, bearer(MONEY)).status).toBe('next');
});

test('compares in constant time, never with === on a secret', () => {
  const spy = jest.spyOn(crypto, 'timingSafeEqual');
  run(auth.money, bearer('nope'));
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/adminAuth.js'), 'utf8');
  expect(src).not.toMatch(/(given|token|key)\s*===\s*(?![\s'"])/i); // a typeof check is fine
  const ctrl = fs.readFileSync(path.join(__dirname, '../src/controllers/payment.controller.js'), 'utf8');
  expect(ctrl).not.toMatch(/checkAdminAuth|=== adminKey/);
});

// Every admin route names its scope; money-moving ones need the money scope.
test('every admin route is guarded, with the right scope', () => {
  const router = require('../src/routes/payment.routes');
  const MONEY_ROUTES = ['post /admin/sep/refund/reg', 'post /admin/sep/refund/exec', 'post /admin/sep/refund/refresh',
    'delete /admin/queue/:id', 'get /admin/verify-only'];
  const seen = {};
  for (const layer of router.stack.filter((l) => l.route && l.route.path.startsWith('/admin'))) {
    for (const m of Object.keys(layer.route.methods)) {
      const key = `${m} ${layer.route.path}`;
      seen[key] = layer.route.stack[0].handle.adminScope;
    }
  }
  expect(Object.keys(seen).length).toBeGreaterThanOrEqual(13);
  for (const [key, scope] of Object.entries(seen)) expect([key, scope]).toEqual([key, MONEY_ROUTES.includes(key) ? 'money' : 'read']);
});
