'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('payment-session.service', () => {
  let sessionFile;
  let paymentSession;

  beforeEach(() => {
    sessionFile = path.join(os.tmpdir(), `payment-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.PAYMENT_SESSION_FILE = sessionFile;
    process.env.PAYMENT_SESSION_TTL_MS = '7200000'; // 2 hours, matches the documented default
    jest.resetModules();
    paymentSession = require('../src/services/payment-session.service');
  });

  afterEach(() => {
    delete process.env.PAYMENT_SESSION_FILE;
    delete process.env.PAYMENT_SESSION_TTL_MS;
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  });

  test('save then get round-trips amount, gateway, and mobile', () => {
    paymentSession.save('order-1', { amount: 15000, gateway: 'zarinpal', mobile: '09120000000' });
    const entry = paymentSession.get('order-1');
    expect(entry).toMatchObject({ amount: 15000, gateway: 'zarinpal', mobile: '09120000000' });
  });

  test('get returns null for an orderId that was never saved', () => {
    expect(paymentSession.get('does-not-exist')).toBeNull();
  });

  test('remove deletes the session so a later get returns null', () => {
    paymentSession.save('order-2', { amount: 1000, gateway: 'zibal', mobile: '' });
    paymentSession.remove('order-2');
    expect(paymentSession.get('order-2')).toBeNull();
  });

  test('get returns null once the session is older than the TTL', () => {
    const expiredCreatedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // 8h ago, TTL is 2h
    fs.writeFileSync(sessionFile, JSON.stringify({
      'order-3': { amount: 2000, gateway: 'sep', mobile: '', createdAt: expiredCreatedAt },
    }), 'utf8');

    expect(paymentSession.get('order-3')).toBeNull();
  });

  test('get returns the entry when it is still within the TTL window', () => {
    const recentCreatedAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    fs.writeFileSync(sessionFile, JSON.stringify({
      'order-4': { amount: 3000, gateway: 'sep', mobile: '', createdAt: recentCreatedAt },
    }), 'utf8');

    expect(paymentSession.get('order-4')).toMatchObject({ amount: 3000, gateway: 'sep' });
  });

  test('save purges already-expired sessions from the store as a side effect', () => {
    const expiredCreatedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify({
      'order-old': { amount: 1000, gateway: 'sep', mobile: '', createdAt: expiredCreatedAt },
    }), 'utf8');

    paymentSession.save('order-new', { amount: 4000, gateway: 'zibal', mobile: '' });

    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    expect(raw).not.toHaveProperty('order-old');
    expect(raw).toHaveProperty('order-new');
  });
});
