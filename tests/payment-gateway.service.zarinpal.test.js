'use strict';

jest.mock('axios', () => ({ create: jest.fn() }));

const API_BASE = 'https://payment.zarinpal.com/pg/v4/payment/';

describe('_buildZarinpalRequest / _buildZarinpalVerify', () => {
  let mockPost;
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('axios', () => ({ create: jest.fn() }));
    const axios = require('axios');
    mockPost = jest.fn();
    axios.create.mockReturnValue({ post: mockPost });
    service = require('../src/services/payment-gateway.service');
  });

  describe('_buildZarinpalRequest', () => {
    test('short-circuits without an HTTP call when merchantId is missing', async () => {
      const result = await service._buildZarinpalRequest({ apiBase: API_BASE, merchantId: '', amount: 1000, orderId: 'o1' });
      expect(result).toEqual({ errors: ['ZARINPAL_MERCHANT not configured'] });
      expect(mockPost).not.toHaveBeenCalled();
    });

    test('builds the request payload with callback_url and no mobile/metadata.mobile when mobile is omitted', async () => {
      mockPost.mockResolvedValue({ data: { code: 100, authority: 'A123' } });
      const result = await service._buildZarinpalRequest({
        apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7',
      });

      expect(result).toEqual({ code: 100, authority: 'A123' });
      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, payload] = mockPost.mock.calls[0];
      expect(url).toBe(`${API_BASE}request.json`);
      expect(payload).toMatchObject({
        merchant_id: 'M1',
        amount: 5000,
        order_id: 'order-7',
      });
      expect(payload).not.toHaveProperty('mobile');
      expect(payload.metadata).not.toHaveProperty('mobile');
    });

    test('includes mobile in both the top-level payload and metadata when provided', async () => {
      mockPost.mockResolvedValue({ data: { code: 100, authority: 'A123' } });
      const result = await service._buildZarinpalRequest({
        apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7', mobile: '09120000000',
      });

      expect(result).toEqual({ code: 100, authority: 'A123' });
      const [, payload] = mockPost.mock.calls[0];
      expect(payload.mobile).toBe('09120000000');
      expect(payload.metadata.mobile).toBe('09120000000');
    });

    test('maps a 401 response to a descriptive authentication error, not the raw axios error', async () => {
      const err = new Error('Request failed with status code 401');
      err.response = { status: 401, data: {} };
      mockPost.mockRejectedValue(err);

      const result = await service._buildZarinpalRequest({ apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7' });
      expect(result.errors[0]).toMatch(/authentication failed \(HTTP 401\)/);
    });

    test('maps a 422 validation response to the gateway-provided message', async () => {
      const err = new Error('Request failed with status code 422');
      err.response = { status: 422, data: { errors: { message: 'amount too low' } } };
      mockPost.mockRejectedValue(err);

      const result = await service._buildZarinpalRequest({ apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7' });
      expect(result).toEqual({ errors: ['Zarinpal validation error: amount too low'] });
    });

    test('passes through a gateway errors array verbatim', async () => {
      const err = new Error('Request failed with status code 400');
      err.response = { status: 400, data: { errors: ['bad request', 'invalid amount'] } };
      mockPost.mockRejectedValue(err);

      const result = await service._buildZarinpalRequest({ apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7' });
      expect(result).toEqual({ errors: ['bad request', 'invalid amount'] });
    });

    test('falls back to err.message for a plain network error with no response', async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
      mockPost.mockRejectedValue(err);

      const result = await service._buildZarinpalRequest({ apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7', retries: 1 });
      expect(result).toEqual({ errors: ['connect ECONNREFUSED 127.0.0.1:443'] });
    });

    test('retries a network error and returns the eventual success', async () => {
      const networkErr = new Error('socket hang up (ECONNRESET)');
      networkErr.code = 'ECONNRESET';
      mockPost.mockRejectedValueOnce(networkErr);
      mockPost.mockResolvedValueOnce({ data: { code: 100, authority: 'A999' } });

      const result = await service._buildZarinpalRequest({
        apiBase: API_BASE, merchantId: 'M1', amount: 5000, orderId: 'order-7', retries: 2,
      });

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ code: 100, authority: 'A999' });
    }, 10000);
  });

  describe('_buildZarinpalVerify', () => {
    test('returns verify data on success', async () => {
      mockPost.mockResolvedValue({ data: { code: 100, ref_id: 42 } });
      const result = await service._buildZarinpalVerify({ apiBase: API_BASE, merchantId: 'M1', authority: 'A1', amount: 5000 });
      expect(result).toEqual({ code: 100, ref_id: 42 });
      const [url, payload] = mockPost.mock.calls[0];
      expect(url).toBe(`${API_BASE}verify.json`);
      expect(payload).toEqual({ merchant_id: 'M1', authority: 'A1', amount: 5000 });
    });

    test('wraps a non-network failure in a "Zarinpal verify network error" message', async () => {
      mockPost.mockRejectedValue(new Error('boom'));
      await expect(
        service._buildZarinpalVerify({ apiBase: API_BASE, merchantId: 'M1', authority: 'A1', amount: 5000 }),
      ).rejects.toThrow('Zarinpal verify network error: boom');
    });
  });
});
