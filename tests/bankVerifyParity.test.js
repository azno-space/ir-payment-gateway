'use strict';
// "Did the bank confirm this payment?" is decided in one place. Three surfaces ask it: the bank callback
// (bankVerification), GET /admin/verify-only (v1) and POST /payments/verifications (v2). The same bank answers
// go through each and the verdict must be identical. Zarinpal sandbox shares Zarinpal's
// rule; it only exists on the callback surface.
const mockGw = {};
jest.mock('../src/services/payment-gateway.service', () => ({
  zibalVerifyPayment: (...a) => mockGw.zibal(...a),
  zarinpalVerifyPayment: (...a) => mockGw.zarinpal(...a),
  zarinpalSandboxVerifyPayment: (...a) => mockGw.zarinpal(...a),
  sepVerifyPayment: (...a) => mockGw.sep(...a),
}));
jest.mock('../src/services/payment-session.service', () => ({ get: () => ({ amount: 5000 }), save: () => {}, remove: () => {} }));
jest.mock('../src/controllers/webhookDispatch', () => ({ notifyBaleFailure: () => {} }));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: () => {} }));
jest.mock('../src/utils/errorLogger', () => ({ appendErrorLog: () => {}, readErrorLog: () => [] }));

const http = require('http');
const express = require('express');
const axios = require('axios');

const MONEY = 'm'.repeat(32);
process.env.ADMIN_KEY = MONEY;
delete process.env.PAYMENT_CREATE_SECRET;

const { adminVerifyOnly } = require('../src/controllers/admin.controller');
const { verifyWithGateway } = require('../src/controllers/bankVerification');

// [gateway, what the bank answered, verdict]
const CASES = [
  ['zibal', { result: 100 }, true],
  ['zibal', { result: 201 }, true],
  ['zibal', { result: 0 }, false],
  ['zibal', { result: 200 }, false],
  ['zibal', { result: 202 }, false],
  ['zibal', { result: '100' }, false],
  ['zibal', { result: 102 }, false],
  ['zibal', {}, false],
  ['zibal', null, false],
  ['zarinpal', { data: { code: 100 } }, true],
  ['zarinpal', { data: { code: 101 } }, true],
  ['zarinpal', { data: { code: -50 } }, false],
  ['zarinpal', { data: { code: '100' } }, false],
  ['zarinpal', { data: {} }, false],
  ['zarinpal', { errors: { code: -51 } }, false],
  ['zarinpal', null, false],
  ['sep', { Success: true }, true],
  ['sep', { Success: false, ResultCode: 2 }, false],
  ['sep', { Success: 'true' }, false],
  ['sep', { Success: 1 }, false],
  ['sep', {}, false],
  ['sep', null, false],
];

let server;
let base;
beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const app = express();
  app.use('/api/v2', require('../src/v2/routes'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v2`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); jest.restoreAllMocks(); });

const answerWith = (gateway, answer) => { mockGw[gateway === 'zarinpal_sandbox' ? 'zarinpal' : gateway] = async () => answer; };

async function viaAdmin(gateway, code, refNum) {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await adminVerifyOnly({ query: { gateway, code, amount: '5000', ...(refNum ? { RefNum: refNum } : {}) } }, res);
  return out.body.verified === true;
}

async function viaV2(gateway, code, refNum) {
  const r = await axios.post(`${base}/payments/verifications`, { gateway, code, amount: 5000, ...(refNum ? { refNum } : {}) }, { headers: { Authorization: `Bearer ${MONEY}` }, validateStatus: () => true });
  return r.data.verified === true;
}

async function viaCallback(gateway, code, refNum) {
  const c = { gateway, code, orderId: 'ord-1' };
  const v = await verifyWithGateway(c, gateway === 'sep' ? { State: 'OK', RefNum: refNum || code } : {});
  return v.verifyOk === true;
}

describe.each(CASES)('%s answers %j', (gateway, answer, verdict) => {
  const code = gateway === 'zibal' ? '12345' : 'REF-1';
  beforeEach(() => answerWith(gateway, answer));
  test(`bank callback says ${verdict}`, async () => expect(await viaCallback(gateway, code)).toBe(verdict));
  test(`admin verify-only says ${verdict}`, async () => expect(await viaAdmin(gateway, code)).toBe(verdict));
  test(`v2 verifications say ${verdict}`, async () => expect(await viaV2(gateway, code)).toBe(verdict));
});

test('zarinpal sandbox follows Zarinpal\'s rule on the callback surface', async () => {
  answerWith('zarinpal_sandbox', { data: { code: 100 } });
  expect(await viaCallback('zarinpal_sandbox', 'A1')).toBe(true);
  answerWith('zarinpal_sandbox', { data: { code: -50 } });
  expect(await viaCallback('zarinpal_sandbox', 'A1')).toBe(false);
});

test('what each surface sends to the bank: the code type and the Zarinpal amount', async () => {
  const seen = [];
  mockGw.zibal = async (...a) => { seen.push(['zibal', ...a]); return { result: 100 }; };
  mockGw.zarinpal = async (...a) => { seen.push(['zarinpal', ...a]); return { data: { code: 100 } }; };
  mockGw.sep = async (...a) => { seen.push(['sep', ...a]); return { Success: true }; };
  await viaAdmin('zibal', '12345'); await viaV2('zibal', '12345'); await viaCallback('zibal', '12345');
  await viaAdmin('zarinpal', 'A9'); await viaV2('zarinpal', 'A9'); await viaCallback('zarinpal', 'A9');
  await viaAdmin('sep', 'R9'); await viaV2('sep', 'R9'); await viaCallback('sep', 'R9');
  // The callback hands Zibal's track id over as the string it received; the service turns it into a number itself
  // (zibalVerifyPayment: Number(trackId)), so the bank sees the same request from all three.
  const sent = seen.map(([g, ...a]) => [g, ...a.map((v) => (g === 'zibal' ? Number(v) : v))]);
  expect(sent).toEqual([
    ['zibal', 12345], ['zibal', 12345], ['zibal', 12345],
    ['zarinpal', 'A9', 5000], ['zarinpal', 'A9', 5000], ['zarinpal', 'A9', 5000],
    ['sep', 'R9'], ['sep', 'R9'], ['sep', 'R9'],
  ]);
});

test('SEP is asked with the RefNum, not the order code, when they differ (callback, v1 and v2)', async () => {
  const seen = [];
  mockGw.sep = async (...a) => { seen.push(a); return { Success: true }; };
  expect(await viaCallback('sep', 'CODE-1', 'REF-2')).toBe(true);
  expect(await viaAdmin('sep', 'CODE-1', 'REF-2')).toBe(true);
  expect(await viaV2('sep', 'CODE-1', 'REF-2')).toBe(true);
  expect(seen).toEqual([['REF-2'], ['REF-2'], ['REF-2']]);
});
