'use strict';
// Pins GET /admin/verify-only: which bank call each gateway makes, what counts as verified, and every answer.
const mockGw = {};
jest.mock('../src/services/payment-gateway.service', () => ({
  zibalVerifyPayment: (...a) => mockGw.zibal(...a),
  zarinpalVerifyPayment: (...a) => mockGw.zarinpal(...a),
  sepVerifyPayment: (...a) => mockGw.sep(...a),
}));

const { adminVerifyOnly } = require('../src/controllers/admin.controller');

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

async function ask(query) {
  const out = {};
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  await adminVerifyOnly({ query }, res);
  return out;
}

test('gateway and code are required', async () => {
  expect(await ask({})).toEqual({ status: 400, body: { success: false, error: { code: 'bad_request', message: 'gateway and code are required' } } });
  expect((await ask({ gateway: 'zibal' })).status).toBe(400);
  expect((await ask({ code: '1' })).status).toBe(400);
});

test.each([[['zibal']], ['constructor'], ['__proto__'], ['toString']])('gateway %j is unsupported and no bank is asked', async (gateway) => {
  mockGw.zibal = async () => { throw new Error('the bank must not be called'); };
  const out = await ask({ gateway, code: '1' });
  expect(out.status).toBe(400);
  expect(out.body.error.message).toBe('unsupported gateway');
});

test('an unsupported gateway lists the valid ones', async () => {
  expect(await ask({ gateway: 'paypal', code: '1' })).toEqual({
    status: 400,
    body: { validGateways: ['zibal', 'zarinpal', 'zarinpal_sandbox', 'sep'], success: false, error: { code: 'bad_request', message: 'unsupported gateway' } },
  });
});

describe('zibal', () => {
  test.each([[100], [201]])('result %s is verified; the code is sent as a number', async (result) => {
    const seen = [];
    mockGw.zibal = async (...a) => { seen.push(a); return { result, x: 1 }; };
    expect(await ask({ gateway: 'zibal', code: '55' })).toEqual({ status: undefined, body: { success: true, verified: true, gateway: 'zibal', code: '55', verifyResult: { result, x: 1 } } });
    expect(seen).toEqual([[55]]);
  });
  test('anything else is 400 not_verified with the bank answer', async () => {
    mockGw.zibal = async () => ({ result: 202 });
    expect(await ask({ gateway: 'zibal', code: '55' })).toEqual({
      status: 400, body: { verified: false, gateway: 'zibal', code: '55', verifyResult: { result: 202 }, success: false, error: { code: 'not_verified' } },
    });
    mockGw.zibal = async () => null;
    expect((await ask({ gateway: 'zibal', code: '55' })).status).toBe(400);
  });
});

describe('zarinpal', () => {
  test('verified on 100 or 101, against the amount given (default 1)', async () => {
    const seen = [];
    mockGw.zarinpal = async (...a) => { seen.push(a); return { data: { code: 101 } }; };
    expect((await ask({ gateway: 'zarinpal', code: 'A1', amount: '2500' })).body.verified).toBe(true);
    expect((await ask({ gateway: 'zarinpal', code: 'A1' })).body.verified).toBe(true);
    expect(seen).toEqual([['A1', 2500], ['A1', 1]]);
  });
  test('another code, or no data, is not verified', async () => {
    mockGw.zarinpal = async () => ({ data: { code: -50 } });
    expect((await ask({ gateway: 'zarinpal', code: 'A1' })).status).toBe(400);
    mockGw.zarinpal = async () => ({});
    expect((await ask({ gateway: 'zarinpal', code: 'A1' })).status).toBe(400);
  });
});

describe('sep', () => {
  test('verified only on Success true; the reference is RefNum, then refNum, then the code', async () => {
    const seen = [];
    mockGw.sep = async (...a) => { seen.push(a); return { Success: true }; };
    expect((await ask({ gateway: 'sep', code: 'C', RefNum: 'R1', refNum: 'R2' })).body.verified).toBe(true);
    await ask({ gateway: 'sep', code: 'C', refNum: 'R2' });
    await ask({ gateway: 'sep', code: 'C' });
    expect(seen).toEqual([['R1'], ['R2'], ['C']]);
    mockGw.sep = async () => ({ Success: 'true' });
    expect((await ask({ gateway: 'sep', code: 'C' })).status).toBe(400);
  });
});

test('a bank that cannot be reached is 502 bank_unreachable', async () => {
  mockGw.zibal = async () => { throw new Error('socket hang up'); };
  expect(await ask({ gateway: 'zibal', code: '1' })).toEqual({
    status: 502, body: { success: false, error: { code: 'bank_unreachable', message: 'gateway verification failed' } },
  });
});
