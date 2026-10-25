'use strict';
// Pins the HTTP surface callers use today: every route (method + path), which of them sit behind the
// admin checker and with which scope, and the shape of the admin-auth refusals. Callers address this
// service by these paths, so a change here is a breaking change: it has to be a deliberate edit of
// this file, in the same change that moves the callers.
const http = require('http');
const express = require('express');
const axios = require('axios');
const router = require('../src/routes/payment.routes');

const EXPECTED = [
  'DELETE /admin/queue/:id [money]',
  'GET /admin/error-log [read]',
  'GET /admin/queue [read]',
  'GET /admin/verify-only [money]',
  'GET /admin/zarinpal-unverified [read]',
  'GET /callback',
  'GET /sep-callback',
  'POST /',
  'POST /admin/sep/refund/detail [read]',
  'POST /admin/sep/refund/exec [money]',
  'POST /admin/sep/refund/list [read]',
  'POST /admin/sep/refund/refresh [money]',
  'POST /admin/sep/refund/reg [money]',
  'POST /admin/sep/refund/status [read]',
  'POST /admin/sep/refund/status-by-request-id [read]',
  'POST /admin/sep/report [read]',
  'POST /callback',
  'POST /sep-callback',
];

function inventory() {
  const rows = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const scope = layer.route.stack.map((l) => l.handle.adminScope).find(Boolean);
    for (const method of Object.keys(layer.route.methods)) {
      rows.push(`${method.toUpperCase()} ${layer.route.path}${scope ? ` [${scope}]` : ''}`);
    }
  }
  return rows.sort();
}

test('the route table is exactly the one callers use', () => {
  expect(inventory()).toEqual([...EXPECTED].sort());
});

describe('admin refusals', () => {
  let server;
  let base;
  const saved = { ADMIN_KEY: process.env.ADMIN_KEY, ADMIN_READ_KEY: process.env.ADMIN_READ_KEY };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/payments', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/payments`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const call = (method, path, headers = {}) => axios({ method, url: base + path, headers, validateStatus: () => true });

  test('no admin key configured: 503 admin_auth_not_configured', async () => {
    delete process.env.ADMIN_KEY;
    delete process.env.ADMIN_READ_KEY;
    const res = await call('get', '/admin/queue');
    expect(res.status).toBe(503);
    expect(res.data).toEqual({ success: false, error: { code: 'admin_auth_not_configured' } });
  });

  test('keys configured, none presented: 401 unauthorized', async () => {
    process.env.ADMIN_KEY = 'm'.repeat(32);
    process.env.ADMIN_READ_KEY = 'r'.repeat(32);
    const res = await call('get', '/admin/queue');
    expect(res.status).toBe(401);
    expect(res.data).toEqual({ success: false, error: { code: 'unauthorized' } });
  });

  test('a read key on a money route: 403 forbidden', async () => {
    process.env.ADMIN_KEY = 'm'.repeat(32);
    process.env.ADMIN_READ_KEY = 'r'.repeat(32);
    const res = await call('delete', '/admin/queue/1', { 'x-admin-key': 'r'.repeat(32) });
    expect(res.status).toBe(403);
    expect(res.data).toEqual({ success: false, error: { code: 'forbidden', message: 'this key may only read' } });
  });

  test('a key in the query string is not accepted', async () => {
    process.env.ADMIN_KEY = 'm'.repeat(32);
    process.env.ADMIN_READ_KEY = 'r'.repeat(32);
    const res = await call('get', `/admin/queue?token=${'m'.repeat(32)}`);
    expect(res.status).toBe(401);
  });
});
