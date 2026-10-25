'use strict';

const { escapeXml, getCbUrl } = require('../src/services/payment-gateway.service');

describe('escapeXml', () => {
  test('escapes all five XML-significant characters', () => {
    expect(escapeXml(`<tag attr="a & b's">`)).toBe('&lt;tag attr=&quot;a &amp; b&apos;s&quot;&gt;');
  });

  test('escapes & before other entities so it does not double-escape them', () => {
    // A naive multi-pass replace would turn "&lt;" into "&amp;lt;" if & is not replaced first.
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  test('returns an empty string for null and undefined (used for optional SOAP fields)', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });

  test('coerces non-string values to string', () => {
    expect(escapeXml(12345)).toBe('12345');
  });

  test('leaves strings with no special characters untouched', () => {
    expect(escapeXml('order-123')).toBe('order-123');
  });
});

describe('getCbUrl', () => {
  const ORIGINAL_ENV = process.env.CALLBACK_BASE_URL;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CALLBACK_BASE_URL;
    else process.env.CALLBACK_BASE_URL = ORIGINAL_ENV;
  });

  function loadWithBase(base) {
    let mod;
    jest.isolateModules(() => {
      if (base === undefined) delete process.env.CALLBACK_BASE_URL;
      else process.env.CALLBACK_BASE_URL = base;
      mod = require('../src/services/payment-gateway.service');
    });
    return mod.getCbUrl;
  }

  test('appends orderId as a query param', () => {
    const fn = loadWithBase('https://example.com');
    expect(fn('order-1')).toBe('https://example.com/api/payments/callback?orderId=order-1');
  });

  test('omits the query string entirely when no orderId is given', () => {
    const fn = loadWithBase('https://example.com');
    expect(fn()).toBe('https://example.com/api/payments/callback');
  });

  test('strips a trailing slash from CALLBACK_BASE_URL', () => {
    const fn = loadWithBase('https://example.com/');
    expect(fn('order-1')).toBe('https://example.com/api/payments/callback?orderId=order-1');
  });

  test('URL-encodes special characters in orderId', () => {
    const fn = loadWithBase('https://example.com');
    expect(fn('order 1&two')).toBe('https://example.com/api/payments/callback?orderId=order%201%26two');
  });

  test('falls back to an empty base when CALLBACK_BASE_URL is unset', () => {
    const fn = loadWithBase(undefined);
    expect(fn('order-1')).toBe('/api/payments/callback?orderId=order-1');
  });
});
