'use strict';
// Pins gateway selection, the failover chain and one request attempt per bank.
const mockGw = {};
jest.mock('../src/services/payment-gateway.service', () => ({
  ZARINPAL_PAY_BASE: 'https://zp.test/pay/',
  ZARINPAL_SANDBOX_PAY_BASE: 'https://zps.test/pay/',
  zibalRequestPayment: (a) => mockGw.zibal(a),
  zarinpalRequestPayment: (a) => mockGw.zarinpal(a),
  zarinpalSandboxRequestPayment: (a) => mockGw.sandbox(a),
  sepRequestPayment: (a) => mockGw.sep(a),
}));

const KEYS = ['FORCED_PAYMENT_GATEWAY', 'PAYMENT_FAILOVER_ENABLED'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterAll(() => KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

function load(env = {}) {
  jest.resetModules();
  KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  return require('../src/controllers/gatewaySelection');
}
afterEach(() => jest.restoreAllMocks());

const ARGS = { amount: 5000, orderId: 'o', mobile: '0912', timeout: 7, retries: 1 };

describe('resolveGateway and the chain', () => {
  test('a valid requested gateway is used; anything else is zarinpal', () => {
    const { resolveGateway } = load();
    expect(['zibal', 'zarinpal', 'zarinpal_sandbox', 'sep'].map(resolveGateway)).toEqual(['zibal', 'zarinpal', 'zarinpal_sandbox', 'sep']);
    expect([undefined, '', 'paypal'].map(resolveGateway)).toEqual(['zarinpal', 'zarinpal', 'zarinpal']);
  });

  test('a forced gateway wins; an invalid forced one is ignored with a warning', () => {
    expect(load({ FORCED_PAYMENT_GATEWAY: ' ZIBAL ' }).resolveGateway('sep')).toBe('zibal');
    const bad = load({ FORCED_PAYMENT_GATEWAY: 'nope' });
    expect(bad.resolveGateway('sep')).toBe('sep');
    expect(console.warn).toHaveBeenCalled();
  });

  test('chains: sep fails over to zarinpal, the others stand alone, failover can be switched off', () => {
    const on = load();
    expect(on.buildGatewayChain('sep')).toEqual(['sep', 'zarinpal']);
    expect(on.buildGatewayChain('zibal')).toEqual(['zibal']);
    expect(on.buildGatewayChain('zarinpal_sandbox')).toEqual(['zarinpal_sandbox']);
    expect(on.buildGatewayChain('mystery')).toEqual(['mystery']);
    expect(load({ PAYMENT_FAILOVER_ENABLED: 'false' }).buildGatewayChain('sep')).toEqual(['sep']);
    expect(load({ PAYMENT_FAILOVER_ENABLED: ' FALSE ' }).buildGatewayChain('sep')).toEqual(['sep']);
    expect(load({ PAYMENT_FAILOVER_ENABLED: 'no' }).buildGatewayChain('sep')).toEqual(['sep', 'zarinpal']);
  });
});

describe('attemptGatewayRequest', () => {
  const run = (gateway, name, answer) => {
    const g = load();
    const calls = [];
    mockGw[name] = async (a) => { calls.push(a); return answer; };
    return g.attemptGatewayRequest(gateway, ARGS).then((r) => ({ r, calls }));
  };

  test('zibal ok', async () => {
    const { r, calls } = await run('zibal', 'zibal', { result: 100, trackId: 'T' });
    expect(r).toEqual({ ok: true, gateway: 'zibal', targetUrl: 'https://gateway.zibal.ir/start/T', identifier: 'T', raw: { result: 100, trackId: 'T' } });
    expect(calls).toEqual([ARGS]);
  });
  test('zibal refused: its message, or a default', async () => {
    expect((await run('zibal', 'zibal', { result: 102, message: 'bad' })).r).toMatchObject({ ok: false, reason: 'bad' });
    expect((await run('zibal', 'zibal', { result: 100 })).r).toMatchObject({ ok: false, reason: 'Zibal returned non-100 result' });
  });

  test('zarinpal and its sandbox ok, each with its own base', async () => {
    const live = (await run('zarinpal', 'zarinpal', { data: { code: 100, authority: 'A' } })).r;
    expect(live).toMatchObject({ ok: true, targetUrl: 'https://zp.test/pay/A', identifier: 'A' });
    const sandbox = (await run('zarinpal_sandbox', 'sandbox', { data: { code: 100, authority: 'A' } })).r;
    expect(sandbox).toMatchObject({ ok: true, gateway: 'zarinpal_sandbox', targetUrl: 'https://zps.test/pay/A' });
  });
  test('zarinpal refused: its message, its errors as JSON, or a default', async () => {
    expect((await run('zarinpal', 'zarinpal', { data: { code: -9, message: 'm' } })).r.reason).toBe('m');
    expect((await run('zarinpal', 'zarinpal', { data: { code: -9 }, errors: { x: 1 } })).r.reason).toBe('{"x":1}');
    expect((await run('zarinpal', 'zarinpal', { data: {} })).r.reason).toBe('Zarinpal returned non-100 code');
    expect((await run('zarinpal', 'zarinpal', {})).r.reason).toBe('Zarinpal returned non-100 code');
  });

  test('sep ok under any spelling of the fields; the reference or the token identifies it', async () => {
    const a = (await run('sep', 'sep', { Status: 1, Token: 'TK', RefNum: 'RN' })).r;
    expect(a).toMatchObject({ ok: true, targetUrl: 'https://sep.shaparak.ir/OnlinePG/SendToken?token=TK', identifier: 'RN' });
    const b = (await run('sep', 'sep', { status: '1', token: 'tk' })).r;
    expect(b).toMatchObject({ ok: true, identifier: 'tk' });
    const c = (await run('sep', 'sep', { result: 1, Token: 'T', refnum: 'r' })).r;
    expect(c).toMatchObject({ ok: true, identifier: 'r' });
  });
  test('sep refused: its description, or a default', async () => {
    expect((await run('sep', 'sep', { Status: 0, ErrorDesc: 'down' })).r.reason).toBe('down');
    expect((await run('sep', 'sep', { Status: 0, errorDesc: 'low' })).r.reason).toBe('low');
    expect((await run('sep', 'sep', { Status: 1 })).r.reason).toBe('SEP returned non-1 status');
  });

  test('an unknown gateway is refused without any bank call', async () => {
    const g = load();
    mockGw.sep = async () => { throw new Error('the bank must not be called'); };
    expect(await g.attemptGatewayRequest('paypal', ARGS)).toEqual({ ok: false, gateway: 'paypal', reason: 'Invalid gateway: paypal' });
    for (const odd of ['constructor', '__proto__', 'toString', ['sep'], undefined, null]) {
      const answer = await g.attemptGatewayRequest(odd, ARGS);
      expect(answer.ok).toBe(false);
      expect(answer.reason).toBe(`Invalid gateway: ${odd}`);
    }
  });
});
