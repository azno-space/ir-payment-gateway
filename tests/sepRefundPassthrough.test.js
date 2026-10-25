'use strict';

// The three SEP refund passthroughs send the documented SOAP action and fields, and refuse ids
// that would make SEP act on the wrong record.
describe('SEP refund detail / status-by-request-id / refresh', () => {
  let mockPost;
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('axios', () => ({ create: jest.fn() }));
    const axios = require('axios');
    mockPost = jest.fn().mockResolvedValue({ status: 200, data: '<ok/>' });
    axios.create.mockReturnValue({ post: mockPost });
    service = require('../src/services/payment-gateway.service');
  });

  test('GetRefundDetail carries the refundId', async () => {
    await service.sepGetRefundDetail({ refundId: '777' });
    const [, body, opts] = mockPost.mock.calls[0];
    expect(opts.headers.SOAPAction).toBe('http://tempuri.org/IsrvRefundV2/GetRefundDetail');
    expect(body).toContain('<tem:refundId>777</tem:refundId>');
  });

  test('GetRefundStatusByRequestId carries the numeric requestId; a bad id never reaches SEP', async () => {
    await service.sepGetRefundStatusByRequestId({ requestId: '42' });
    expect(mockPost.mock.calls[0][2].headers.SOAPAction).toBe('http://tempuri.org/IsrvRefundV2/GetRefundStatusByRequestId');
    expect(mockPost.mock.calls[0][1]).toContain('<tem:requestId>42</tem:requestId>');
    await expect(service.sepGetRefundStatusByRequestId({ requestId: 'abc' })).rejects.toThrow('invalid requestId');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('RefreshRefundRequestByPartialRefundInfoId escapes the description; a bad id never reaches SEP', async () => {
    await service.sepRefreshRefundRequest({ partialRefundInfoId: 9, description: 'retry <114>' });
    const [, body, opts] = mockPost.mock.calls[0];
    expect(opts.headers.SOAPAction).toBe('http://tempuri.org/IsrvRefundV2/RefreshRefundRequestByPartialRefundInfoId');
    expect(body).toContain('<tem:partialRefundInfoId>9</tem:partialRefundInfoId>');
    expect(body).toContain('retry &lt;114&gt;');
    await expect(service.sepRefreshRefundRequest({ partialRefundInfoId: 0 })).rejects.toThrow('invalid partialRefundInfoId');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
