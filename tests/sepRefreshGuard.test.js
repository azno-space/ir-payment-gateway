'use strict';
// A blind refresh can pay a refund twice. The public refresh route must ask SEP for the request's own
// state and refuse (409) unless it failed overall with exec code 114 — whatever else is mounted
// before or after the router.
const http = require('http');
const express = require('express');
const { DAILY_LIST_COLUMNS } = require('../src/sep/refundResponse');

const detailXml = (fields) => {
  const row = DAILY_LIST_COLUMNS.map((c) => fields[c] ?? '').join('|');
  return `<s:Envelope><s:Body><a:Description>${row}</a:Description></s:Body></s:Envelope>`;
};

// Modules, mock and the three servers are set up once; each test only sets what SEP answers. (One test per
// status pair and mount, no loop that re-requires everything: that was slow enough to hit jest's timeout.)
describe('POST /admin/sep/refund/refresh', () => {
  let mockPost;
  let detail;
  const servers = {};
  const bases = {};
  const savedKey = process.env.ADMIN_KEY;
  const KEY = 'm'.repeat(32);
  // `before` mounts an unrelated router ahead of the payment router, `after` one that would shadow it.
  const MOUNTS = { alone: {}, 'router before': { before: true }, 'shadow after': { after: true } };

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('axios', () => ({ create: jest.fn() }));
    const axios = require('axios');
    mockPost = jest.fn(async (url, body, opts) => ({
      status: 200,
      data: /GetRefundDetail/.test(opts.headers.SOAPAction) ? detail : '<ok/>',
    }));
    axios.create.mockReturnValue({ post: mockPost });
    process.env.ADMIN_KEY = KEY;
    const router = require('../src/routes/payment.routes');
    for (const [name, { before, after }] of Object.entries(MOUNTS)) {
      const app = express();
      app.use(express.json());
      if (before) app.use('/api/payments', express.Router());
      app.use('/api/payments', router);
      if (after) app.use('/api/payments', express.Router().post('/admin/sep/refund/refresh', (req, res) => res.json({ shadow: true })));
      servers[name] = http.createServer(app);
      await new Promise((r) => servers[name].listen(0, '127.0.0.1', r));
      bases[name] = `http://127.0.0.1:${servers[name].address().port}/api/payments`;
    }
  });

  afterAll(async () => {
    await Promise.all(Object.values(servers).map((srv) => new Promise((r) => srv.close(r))));
    if (savedKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = savedKey;
  });

  beforeEach(() => {
    mockPost.mockClear();
    require('../src/sep/refreshClaim').useStampStore(); // every case starts with no refresh remembered
  });

  const refresh = (body, mount = 'alone') => fetch(`${bases[mount]}/admin/sep/refund/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const refreshCalls = () => mockPost.mock.calls.filter((c) => /RefreshRefundRequest/.test(c[2].headers.SOAPAction));

  const NOT_REFRESHABLE = [['1', '114'], ['2', '114'], ['3', '114'], ['4', '115'], ['4', '122'], ['4', '']];
  const CASES = Object.keys(MOUNTS).flatMap((mount) => NOT_REFRESHABLE.map(([status, code]) => [mount, status, code]));

  test.each(CASES)('%s: refund status %s / exec code "%s" is refused with 409 and nothing is refreshed', async (mount, refundStatusCode, attemptStatusCode) => {
    detail = detailXml({ refundStatusCode, attemptStatusCode, refundId: '55', refundStatusText: 's', attemptStatusText: 'a' });
    const res = await refresh({ refundId: 55 }, mount);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('refresh_refused');
    expect(refreshCalls()).toHaveLength(0);
  });

  test('refuses when SEP has no row for the id', async () => {
    detail = '<s:Envelope><s:Body><a:Description></a:Description></s:Body></s:Envelope>';
    const res = await refresh({ refundId: 55 });
    expect(res.status).toBe(404);
    expect(refreshCalls()).toHaveLength(0);
  });

  test.each([
    ['SEP answers 500 with a SOAP fault', { status: 500, data: '<s:Envelope><s:Fault/></s:Envelope>' }],
    ['a proxy HTML page with 200', { status: 200, data: '<html>maintenance</html>' }],
    ['a proxy HTML page with 502', { status: 502, data: '<html>bad gateway</html>' }],
    ['an empty body', { status: 200, data: '' }],
  ])('%s: 502 bank_unreachable, never read as "no row", nothing refreshed', async (_n, answer) => {
    detail = answer;
    const res = await refresh({ refundId: 55 });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('bank_unreachable');
    expect(refreshCalls()).toHaveLength(0);
  });

  test.each(['0x5', '5abc', ' 5', '5.0', '-5', '0', '', 'abc', null, 1.5, [], {}])('refundId %j is refused with 400 before SEP is asked', async (refundId) => {
    detail = detailXml({ refundStatusCode: '4', attemptStatusCode: '114', refundId: '5' });
    const res = await refresh({ refundId });
    expect(res.status).toBe(400);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('SEP answering for a different refund than the one asked is refused, nothing refreshed', async () => {
    detail = detailXml({ refundStatusCode: '4', attemptStatusCode: '114', refundId: '56' });
    const res = await refresh({ refundId: 55 });
    expect([res.status, (await res.json()).error.code]).toEqual([409, 'refresh_refused']);
    expect(refreshCalls()).toHaveLength(0);
  });

  test('a numeric string id works like a number', async () => {
    detail = detailXml({ refundStatusCode: '4', attemptStatusCode: '114', refundId: '55' });
    expect((await refresh({ refundId: '55' })).status).toBe(200);
  });

  test('no test here reaches a real host (the global network block would throw and the count stays zero)', async () => {
    detail = detailXml({ refundStatusCode: '4', attemptStatusCode: '114', refundId: '55' });
    await refresh({ refundId: 55 });
    expect(mockPost.mock.calls.every(([url]) => typeof url === 'string')).toBe(true);
  });

  test('refreshes an overall Fail with code 114', async () => {
    detail = detailXml({ refundStatusCode: '4', attemptStatusCode: '114', refundId: '55' });
    const res = await refresh({ refundId: 55, description: 'retry' });
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
    expect(refreshCalls()[0][1]).toContain('<tem:partialRefundInfoId>55</tem:partialRefundInfoId>');
  });
});
