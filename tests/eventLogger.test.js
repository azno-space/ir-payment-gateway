jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve()) }));
const axios = require('axios');
const { logPaymentEvent } = require('../src/utils/eventLogger');

beforeEach(() => { axios.post.mockClear(); delete process.env.EVENT_WEBHOOK_URL; });

test('no URL: nothing is sent and nothing throws', () => {
  expect(() => logPaymentEvent('x', { a: 1 })).not.toThrow();
  expect(axios.post).not.toHaveBeenCalled();
});

test('stamps app/env, caller cannot override', async () => {
  process.env.EVENT_WEBHOOK_URL = 'http://r.test/e';
  logPaymentEvent('payment_success', { app: 'evil', env: 'evil', orderId: 'o' });
  await new Promise((r) => setImmediate(r));
  const body = axios.post.mock.calls[0][1];
  expect(body.event_properties).toMatchObject({ app: 'payment-gateway', orderId: 'o' });
  expect(body.event_properties.env).not.toBe('evil');
});

test('bad payloads never throw', () => {
  process.env.EVENT_WEBHOOK_URL = 'http://r.test/e';
  const c = {}; c.c = c;
  expect(() => logPaymentEvent('x', undefined)).not.toThrow();
  expect(() => logPaymentEvent('x', c)).not.toThrow();
});
