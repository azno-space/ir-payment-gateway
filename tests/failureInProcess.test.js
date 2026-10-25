// Failure hand-over mirrors the success one: an extension mounted in this process takes the failure
// directly; the rollback switch and "no handler" both go back to the webhook URL.
jest.mock('axios', () => ({ post: jest.fn(async () => ({ status: 200, data: { ok: true } })) }));
const axios = require('axios');
const { deliverFailure, setFailureHandler, setSuccessHandler } = require('../src/services/webhook.service');

const payload = { orderId: 'o1', gateway: 'sep', status: 'failed', reason: 'cancelled' };
afterEach(() => { setFailureHandler(null); setSuccessHandler(null); delete process.env.PAYMENT_SUCCESS_IN_PROCESS; jest.clearAllMocks(); });

test('with a handler the failure is taken in-process, once, with no HTTP call', async () => {
  const handler = jest.fn(async () => {});
  setFailureHandler(handler);
  await expect(deliverFailure('http://localhost:3000/f', payload, { retries: 1 })).resolves.toEqual({ ok: true, inProcess: true });
  expect(handler).toHaveBeenCalledWith(payload);
  expect(axios.post).not.toHaveBeenCalled();
});

test('a handler that throws is reported as not delivered (the same as the receiver answering 400)', async () => {
  setFailureHandler(async () => { throw new Error('orderId must be a UUID'); });
  await expect(deliverFailure('http://localhost:3000/f', payload)).resolves.toEqual({ ok: false, error: 'orderId must be a UUID' });
  expect(axios.post).not.toHaveBeenCalled();
});

test('PAYMENT_SUCCESS_IN_PROCESS=false (the one rollback switch) sends failures over the webhook URL again', async () => {
  const handler = jest.fn();
  setFailureHandler(handler);
  process.env.PAYMENT_SUCCESS_IN_PROCESS = 'false';
  await expect(deliverFailure('http://localhost:3000/f', payload, { retries: 1 })).resolves.toMatchObject({ ok: true, status: 200 });
  expect(handler).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('without a handler the webhook URL is used as before', async () => {
  await expect(deliverFailure('http://localhost:3000/f', payload, { retries: 1 })).resolves.toMatchObject({ ok: true });
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('a success handler alone does not take failures', async () => {
  setSuccessHandler(jest.fn());
  await deliverFailure('http://localhost:3000/f', payload, { retries: 1 });
  expect(axios.post).toHaveBeenCalledTimes(1);
});
