'use strict';
// A manual refresh must not be sendable twice in a row, nor twice at once, nor right after the refund job
// refreshed the same request: a second refresh while the first one's outcome is unknown can pay twice
// (SEP refund doc §5.13). The cooldown and its stamp are the job's (src/sep/refreshDecision); the network
// is closed for every test (tests/setup/noNetwork.js), SEP is a mock.
const http = require('http');
const express = require('express');
const { DAILY_LIST_COLUMNS } = require('../src/sep/refundResponse');

const detailXml = (refundId, refundStatusCode = '4') => {
  const row = DAILY_LIST_COLUMNS.map((c) => ({ refundStatusCode, attemptStatusCode: '114', refundId: String(refundId) }[c] ?? '')).join('|');
  return `<s:Envelope><s:Body><a:Description>${row}</a:Description></s:Body></s:Envelope>`;
};

describe('refresh cooldown on the manual route', () => {
  let mockPost; let server; let base; let claims; let decision; let stampFails; let notRefreshable;
  const KEY = 'm'.repeat(32);
  const savedKey = process.env.ADMIN_KEY;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('axios', () => ({ create: jest.fn() }));
    const axios = require('axios');
    stampFails = false; notRefreshable = false;
    mockPost = jest.fn(async (url, body, opts) => {
      if (/GetRefundDetail/.test(opts.headers.SOAPAction)) {
        await new Promise((r) => setTimeout(r, 25)); // a slow lookup: parallel presses overlap here
        const id = /refundId>(\d+)</.exec(body)[1];
        return { status: 200, data: detailXml(id, notRefreshable ? '3' : '4') };
      }
      return { status: 200, data: '<ok/>' };
    });
    axios.create.mockReturnValue({ post: mockPost });
    process.env.ADMIN_KEY = KEY;
    claims = require('../src/sep/refreshClaim');
    decision = require('../src/sep/refreshDecision');
    const mem = new Map();
    claims.useStampStore({
      last: async (id) => mem.get(id) || 0,
      record: async (id, ms) => { if (stampFails) throw new Error('stamp store down'); mem.set(id, ms); },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/payments', require('../src/routes/payment.routes'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/payments`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    if (savedKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = savedKey;
  });

  const press = (refundId) => fetch(`${base}/admin/sep/refund/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ refundId }),
  });
  const refreshCalls = () => mockPost.mock.calls.filter((c) => /RefreshRefundRequest/.test(c[2].headers.SOAPAction));
  const detailCalls = () => mockPost.mock.calls.filter((c) => /GetRefundDetail/.test(c[2].headers.SOAPAction));

  test('a second press inside the cooldown is 409 refresh_cooldown and asks SEP nothing', async () => {
    expect((await press(55)).status).toBe(200);
    const detailsBefore = detailCalls().length;
    const second = await press(55);
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('refresh_cooldown');
    expect(refreshCalls()).toHaveLength(1);
    expect(detailCalls()).toHaveLength(detailsBefore);
  });

  test('two presses at the same moment send exactly one refresh', async () => {
    const [a, b] = await Promise.all([press(55), press(55)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(refreshCalls()).toHaveLength(1);
    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error.code).toBe('refresh_cooldown');
  });

  test('five presses at once still send one', async () => {
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => press(55)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(refreshCalls()).toHaveLength(1);
  });

  test('another refund is not held back by this one', async () => {
    expect((await press(55)).status).toBe(200);
    expect((await press(56)).status).toBe(200);
    expect(refreshCalls()).toHaveLength(2);
  });

  test('a press the guard refuses does not start a cooldown', async () => {
    notRefreshable = true;
    expect((await press(55)).status).toBe(409);
    notRefreshable = false;
    expect((await press(55)).status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
  });

  test('a refresh the job stamped moments ago blocks the press (shared stamp)', async () => {
    const mem = new Map([['55', Date.now() - 60 * 1000]]);
    claims.useStampStore({ last: async (id) => mem.get(id) || 0, record: async () => {} });
    const r = await press(55);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('refresh_cooldown');
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('the press records its stamp before the request goes out, so a failed stamp means no refresh', async () => {
    stampFails = true;
    const r = await press(55);
    expect(r.status).toBe(500);
    expect(refreshCalls()).toHaveLength(0);
  });

  test('the lock is released after a failure: the next press is judged on the stamp, not stuck', async () => {
    stampFails = true;
    await press(55);
    stampFails = false;
    expect((await press(55)).status).toBe(200);
  });

  test.each(['handed_to_manual', 'already_refunded'])('a refund the receiver says is %s is refused with 409 of that code, SEP is not asked, the lock is released', async (reason) => {
    let hold = reason;
    claims.useStampStore({ last: async () => 0, record: async () => {}, hold: async () => hold });
    const r = await press(55);
    expect([r.status, (await r.json()).error.code]).toEqual([409, reason]);
    expect(mockPost).not.toHaveBeenCalled();
    hold = null;
    expect((await press(55)).status).toBe(200);
  });

  test('a store that cannot answer the hold question fails the press (no refresh on an unknown state)', async () => {
    claims.useStampStore({ last: async () => 0, record: async () => {}, hold: async () => { throw new Error('db down'); } });
    expect((await press(55)).status).toBe(500);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('the cooldown is the job\'s constant, to the millisecond', async () => {
    const C = decision.REFRESH_COOLDOWN_MS;
    const now = 1_000_000_000_000;
    for (const [age, ok] of [[C - 1, false], [C, true], [C + 1, true]]) {
      claims.useStampStore({ last: async () => now - age, record: async () => {} });
      const claim = await claims.claimRefresh('77', now);
      expect([age, claim.ok]).toEqual([age, ok]);
      if (claim.ok) claim.release();
    }
  });
});
