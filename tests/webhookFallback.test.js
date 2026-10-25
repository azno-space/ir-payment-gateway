// A webhook URL setting may list several addresses, comma-separated, tried in order (e.g. the
// merchant's internal docker address first, its public one second). The next address is tried
// only when the request never reached the previous one (DNS, refused); an HTTP answer counts.
jest.mock('axios');
const axios = require('axios');
const { callWebhook, pingWebhook, webhookUrls } = require('../src/services/webhook.service');

const netErr = (code) => Object.assign(new Error(code), { code });
const INTERNAL = 'http://merchant-app:3000/hook';
const PUBLIC = 'https://merchant.example/hook';

beforeEach(() => axios.post.mockReset());

test('webhookUrls splits, trims and drops empties', () => {
  expect(webhookUrls(` ${INTERNAL} , ${PUBLIC},`)).toEqual([INTERNAL, PUBLIC]);
  expect(webhookUrls(PUBLIC)).toEqual([PUBLIC]);
  expect(webhookUrls('')).toEqual([]);
});

test('delivers to the second address when the first cannot be resolved', async () => {
  axios.post.mockImplementation(async (url) => { if (url === INTERNAL) throw netErr('EAI_AGAIN'); return { status: 200, data: {} }; });
  const r = await callWebhook(`${INTERNAL},${PUBLIC}`, { a: 1 }, { retries: 1 });
  expect(r.ok).toBe(true);
  expect(axios.post.mock.calls.map((c) => c[0])).toEqual([INTERNAL, PUBLIC]);
});

test('an HTTP answer from the first address is final for that attempt', async () => {
  axios.post.mockResolvedValue({ status: 500, data: {} });
  const r = await callWebhook(`${INTERNAL},${PUBLIC}`, {}, { retries: 1 });
  expect(r.ok).toBe(false);
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('ping is healthy when any address answers 2xx', async () => {
  axios.post.mockImplementation(async (url) => { if (url === INTERNAL) throw netErr('ENOTFOUND'); return { status: 200 }; });
  await expect(pingWebhook(`${INTERNAL},${PUBLIC}`)).resolves.toMatchObject({ ok: true });
});

test('a single URL behaves exactly as before', async () => {
  axios.post.mockResolvedValue({ status: 200, data: {} });
  await expect(callWebhook(PUBLIC, {}, { retries: 1 })).resolves.toMatchObject({ ok: true, status: 200 });
  expect(axios.post.mock.calls[0][0]).toBe(PUBLIC);
});
