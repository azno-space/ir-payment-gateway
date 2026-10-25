'use strict';
// Pins callWebhook: the request it sends, the retry and backoff, and every outcome it reports.
jest.mock('axios');
let axios;

function load(env = {}) {
  jest.resetModules();
  delete process.env.WEBHOOK_SECRET;
  Object.assign(process.env, env);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  axios = require('axios'); // the instance the freshly loaded module sees
  return require('../src/services/webhook.service');
}
const URL_ = 'https://merchant.example/hook?token=secret';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); delete process.env.WEBHOOK_SECRET; });

// Runs callWebhook to the end, moving the backoff timers along.
async function run(promise) {
  let done = false;
  promise.finally(() => { done = true; });
  while (!done) { await jest.advanceTimersByTimeAsync(1000); }
  return promise;
}

test('no URL configured is skipped without a request', async () => {
  const { callWebhook } = load();
  expect(await callWebhook('', {})).toEqual({ ok: false, skipped: true });
  expect(axios.post).not.toHaveBeenCalled();
});

test('a 2xx answer is ok and carries the status and data; the request has the headers, timeout and payload', async () => {
  const { callWebhook } = load({ WEBHOOK_SECRET: 'shh' });
  axios.post.mockResolvedValue({ status: 204, data: 'x' });
  expect(await run(callWebhook(URL_, { a: 1 }))).toEqual({ ok: true, status: 204, data: 'x' });
  const [url, payload, opts] = axios.post.mock.calls[0];
  expect(url).toBe(URL_);
  expect(payload).toEqual({ a: 1 });
  expect(opts.headers).toEqual({ 'Content-Type': 'application/json', 'X-Webhook-Secret': 'shh' });
  expect(opts.timeout).toBe(15000);
  expect(opts.validateStatus()).toBe(true);
});

test('without a secret there is no secret header', async () => {
  const { callWebhook } = load();
  axios.post.mockResolvedValue({ status: 200, data: {} });
  await run(callWebhook(URL_, {}));
  expect(axios.post.mock.calls[0][2].headers).toEqual({ 'Content-Type': 'application/json' });
});

test('a non-2xx answer is retried (3 times by default) and then reported with its status text', async () => {
  const { callWebhook } = load();
  axios.post.mockResolvedValue({ status: 500, data: {} });
  expect(await run(callWebhook(URL_, {}))).toEqual({ ok: false, error: 'Webhook returned HTTP 500' });
  expect(axios.post).toHaveBeenCalledTimes(3);
});

test('retries can be set per call; one try means no waiting', async () => {
  const { callWebhook } = load();
  axios.post.mockResolvedValue({ status: 503, data: {} });
  const result = await callWebhook(URL_, {}, { retries: 1 });
  expect(result).toEqual({ ok: false, error: 'Webhook returned HTTP 503' });
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('a request that fails is retried, and a later success wins', async () => {
  const { callWebhook } = load();
  axios.post.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce({ status: 200, data: { ok: 1 } });
  expect(await run(callWebhook(URL_, {}))).toEqual({ ok: true, status: 200, data: { ok: 1 } });
  expect(axios.post).toHaveBeenCalledTimes(2);
});

test('every attempt failing reports the last error message', async () => {
  const { callWebhook } = load();
  axios.post.mockRejectedValue(new Error('boom'));
  expect(await run(callWebhook(URL_, {}))).toEqual({ ok: false, error: 'boom' });
  expect(axios.post).toHaveBeenCalledTimes(3);
});

test('the wait between tries doubles from one second', async () => {
  const { callWebhook } = load();
  axios.post.mockResolvedValue({ status: 500, data: {} });
  const result = callWebhook(URL_, {});
  await jest.advanceTimersByTimeAsync(0);
  expect(axios.post).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(999);
  expect(axios.post).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(axios.post).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1999);
  expect(axios.post).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1);
  expect(axios.post).toHaveBeenCalledTimes(3);
  await result;
});

test('the logs carry the address without its query string', async () => {
  const { callWebhook } = load();
  axios.post.mockResolvedValue({ status: 500, data: {} });
  await run(callWebhook(URL_, {}));
  const logged = [...console.warn.mock.calls, ...console.error.mock.calls].flat().join(' ');
  expect(logged).toContain('https://merchant.example/hook');
  expect(logged).not.toContain('secret');
});
