'use strict';
// A SEP outage on the refresh route is a bank outage: 502 bank_unreachable, not a server error (SOAP calls
// throw to the global handler otherwise). Nothing is refreshed in either case.
const mockGw = {};
jest.mock('../src/services/payment-gateway.service', () => ({
  sepGetRefundDetail: (...a) => mockGw.detail(...a),
  sepRefreshRefundRequest: (...a) => mockGw.refresh(...a),
  sepGetRefundStatus: async () => ({}),
  sepGetRefundStatusByRequestId: async () => ({}),
}));
jest.mock('../src/sep/refreshClaim', () => ({
  claimRefresh: async () => ({ ok: true, stamp: async () => {}, release: () => {} }),
}));
jest.mock('../src/sep/refreshGuard', () => ({ checkRefreshable: () => ({ ok: true }) }));
jest.mock('../src/sep/soapAnswer', () => ({ isSepAnswer: () => true }));

const { adminSepRefundRefresh } = require('../src/controllers/admin.controller');

function call() {
  const out = {};
  const res = {
    status(c) { out.status = c; return this; },
    type() { return this; },
    send(b) { out.body = b; return this; },
    json(b) { out.body = b; return this; },
  };
  return adminSepRefundRefresh({ body: { refundId: 42, description: 'retry' } }, res).then(() => out);
}

beforeEach(() => { mockGw.refresh = jest.fn(async () => ({ status: 200, data: '<ok/>' })); });

test('SEP does not answer the refund lookup (the SOAP call throws): 502 bank_unreachable, nothing refreshed', async () => {
  mockGw.detail = async () => { throw new Error('socket hang up'); };
  const out = await call();
  expect(out.status).toBe(502);
  expect(out.body.error.code).toBe('bank_unreachable');
  expect(mockGw.refresh).not.toHaveBeenCalled();
});

test('SEP answers the lookup but the refresh call throws: 502 bank_unreachable, the refresh was attempted once', async () => {
  mockGw.detail = async () => ({ data: {} });
  mockGw.refresh = jest.fn(async () => { throw new Error('ECONNRESET'); });
  const out = await call();
  expect(out.status).toBe(502);
  expect(out.body.error.code).toBe('bank_unreachable');
  expect(mockGw.refresh).toHaveBeenCalledTimes(1);
});

test('SEP answers normally: the refresh is relayed as before', async () => {
  mockGw.detail = async () => ({ data: {} });
  const out = await call();
  expect(out.status).toBe(200);
  expect(out.body).toBe('<ok/>');
});
