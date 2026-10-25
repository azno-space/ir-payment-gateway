// A mounted extension takes verified successes in-process; a failure there is returned (the caller
// queues it), the rollback switch goes back to the webhook URL, and with no handler nothing changes.
jest.mock('axios', () => ({ post: jest.fn(async () => ({ status: 200, data: { ok: true } })) }));
const axios = require('axios');
const { deliverSuccess, setSuccessHandler, pingWebhook } = require('../src/services/webhook.service');

const payload = { orderId: 'o1', code: 'REF1', status: 'success' };
afterEach(() => { setSuccessHandler(null); delete process.env.PAYMENT_SUCCESS_IN_PROCESS; jest.clearAllMocks(); });

test('with a handler the success is taken in-process, once, with no HTTP call', async () => {
  const handler = jest.fn(async () => {});
  setSuccessHandler(handler);
  await expect(deliverSuccess('http://localhost:3000/x', payload)).resolves.toEqual({ ok: true, inProcess: true, pending: false, refused: false });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(payload);
  expect(axios.post).not.toHaveBeenCalled();
  await expect(pingWebhook('http://localhost:3000/x')).resolves.toMatchObject({ ok: true, inProcess: true });
});

test('a handler that throws is reported as not delivered, never as delivered', async () => {
  setSuccessHandler(async () => { throw new Error('receiver down'); });
  await expect(deliverSuccess('http://localhost:3000/x', payload)).resolves.toEqual({ ok: false, error: 'receiver down' });
});

test('PAYMENT_SUCCESS_IN_PROCESS=false goes back to the webhook URL', async () => {
  const handler = jest.fn();
  setSuccessHandler(handler);
  process.env.PAYMENT_SUCCESS_IN_PROCESS = 'false';
  await expect(deliverSuccess('http://localhost:3000/x', payload, { retries: 1 })).resolves.toMatchObject({ ok: true, status: 200 });
  expect(handler).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledWith('http://localhost:3000/x', payload, expect.anything());
});

test('without a handler the webhook URL is used as before', async () => {
  await expect(deliverSuccess('http://localhost:3000/x', payload, { retries: 1 })).resolves.toMatchObject({ ok: true });
  expect(axios.post).toHaveBeenCalledTimes(1);
});
