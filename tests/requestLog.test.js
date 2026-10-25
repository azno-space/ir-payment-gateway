'use strict';
// The access log prints the route template, never the real URL: orderId, bank codes and
// references travel in the path and query string.
const express = require('express');
const axios = require('axios');
const requestLog = require('../src/utils/requestLog');

let server;
let base;
const lines = [];

beforeAll(async () => {
  const app = express();
  app.use(requestLog({ write: (l) => lines.push(l) }));
  const router = express.Router();
  router.get('/admin/queue/:id', (req, res) => res.json({ ok: true }));
  router.get('/callback', (req, res) => res.redirect('/done'));
  router.post('/', (req, res) => res.json({ ok: true }));
  router.get('/boom/:id', (req, res, next) => next(new Error('boom')));
  app.use('/api/payments', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { lines.length = 0; });

const get = (path) => axios.get(base + path, { validateStatus: () => true, maxRedirects: 0 });
const settle = () => new Promise((r) => setImmediate(r));

test('prints method, route template, status and time; no id, no query string', async () => {
  await get('/api/payments/admin/queue/ord-12345?orderId=O-SECRET&code=BANKCODE9&RefNum=REF77');
  await settle();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^GET \/api\/payments\/admin\/queue\/:id 200 [\d.]+ ms\n$/);
  for (const secret of ['ord-12345', 'O-SECRET', 'BANKCODE9', 'REF77']) expect(lines[0]).not.toContain(secret);
});

test('a bank callback with its query prints only the template', async () => {
  await get('/api/payments/callback?State=OK&RefNum=SECRETREF&TraceNo=T1');
  await settle();
  expect(lines[0]).toMatch(/^GET \/api\/payments\/callback 302 /);
  expect(lines[0]).not.toContain('SECRETREF');
});

test('a request no route matched prints "-" and still one line', async () => {
  await get('/nope/ord-999?x=1');
  await settle();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^GET - 404 /);
  expect(lines[0]).not.toContain('ord-999');
});

test('an error that leaves the sub-router for the app handler keeps the mount prefix', async () => {
  await get('/api/payments/boom/ord-777?code=SECRET');
  await settle();
  expect(lines[0]).toMatch(/^GET \/api\/payments\/boom\/:id 500 /);
  expect(lines[0]).not.toContain('ord-777');
});

test('the route "/" of a mounted router prints the mount path', async () => {
  await axios.post(`${base}/api/payments?orderId=O-SECRET`, {}, { validateStatus: () => true });
  await settle();
  expect(lines[0]).toMatch(/^POST \/api\/payments 200 /);
  expect(lines[0]).not.toContain('O-SECRET');
});
