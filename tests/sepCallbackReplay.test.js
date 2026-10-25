// A receiver's one-payment-one-order lock is keyed on the webhook's `code`. SEP re-verifies an
// already-verified RefNum as Success (ResultCode 2), so `code` must be exactly the RefNum the bank
// verified — never a value the browser can set apart from it.
jest.mock('../src/services/payment-gateway.service', () => ({ sepVerifyPayment: jest.fn() }));
jest.mock('../src/services/webhook.service', () => {
  const callWebhook = jest.fn(async () => ({ ok: true, status: 200 }));
  return { callWebhook, deliverSuccess: (...a) => callWebhook(...a), deliverFailure: (...a) => callWebhook(...a), pingWebhook: jest.fn(async () => ({ ok: true })) };
});
jest.mock('../src/services/payment-queue.service', () => ({ enqueue: jest.fn() }));
jest.mock('../src/services/notification.service', () => ({
  sendErrorNotificationToBale: jest.fn(async () => {}),
  sendFailedPaymentNotificationToBale: jest.fn(async () => {}),
  sendPaymentSuccessNotificationToBale: jest.fn(async () => {}),
  sendWarningNotificationToBale: jest.fn(async () => {}),
  sendBaleRecoveryMessage: jest.fn(async () => {}),
}));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: jest.fn() }));

process.env.PAYMENT_SUCCESS_WEBHOOK_URL = 'http://receiver.test/webhook/success';

const { sepVerifyPayment } = require('../src/services/payment-gateway.service');
const { callWebhook } = require('../src/services/webhook.service');
const { handlePaymentCallback } = require('../src/controllers/payment.controller');

const ALREADY_VERIFIED = {
  Success: true, ResultCode: 2, ResultDescription: 'درخواست تکراری می باشد',
  TransactionDetail: { RefNum: 'REF-A', OrginalAmount: 5000000 },
};

function res() {
  return { status: jest.fn().mockReturnThis(), send: jest.fn(), redirect: jest.fn(), json: jest.fn() };
}

describe('SEP callback replay: the webhook code is the RefNum that was verified', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['separate code param', { query: { gateway: 'sep', code: 'MADE-UP', ResNum: 'order-b', State: 'OK' }, body: { RefNum: 'REF-A' } }],
    ['RefNum in body, refnum in query', { query: { refnum: 'MADE-UP', ResNum: 'order-b', State: 'OK' }, body: { RefNum: 'REF-A' } }],
    ['refNum and RefNum both in query', { query: { refNum: 'MADE-UP', RefNum: 'REF-A', ResNum: 'order-b', Status: '2' }, body: {} }],
  ])('%s', async (_name, { query, body }) => {
    sepVerifyPayment.mockResolvedValue(ALREADY_VERIFIED);
    await handlePaymentCallback({ query, body, protocol: 'https', get: () => 'pg.test' }, res());

    const verified = sepVerifyPayment.mock.calls[0][0];
    const success = callWebhook.mock.calls.find(([url]) => url === process.env.PAYMENT_SUCCESS_WEBHOOK_URL);
    expect(success).toBeDefined();
    expect(success[1].code).toBe(verified);
    expect(typeof success[1].code).toBe('string');
  });

  // qs parses RefNum[]=REF-A as ['REF-A']; SEP receives "REF-A" but the array reaches the receiver,
  // whose lock looks up String(code) while the row stores the array literal {"REF-A"}.
  test.each([
    ['array RefNum in query', { query: { 'RefNum': ['REF-A'], ResNum: 'order-b', State: 'OK' }, body: {} }],
    ['array RefNum in JSON body', { query: {}, body: { RefNum: ['REF-A'], ResNum: 'order-b', State: 'OK' } }],
    ['array ResNum', { query: { RefNum: 'REF-A', ResNum: ['order-b'], State: 'OK' }, body: {} }],
  ])('%s is rejected before verify', async (_name, { query, body }) => {
    sepVerifyPayment.mockResolvedValue(ALREADY_VERIFIED);
    const r = res();
    await handlePaymentCallback({ query, body, protocol: 'https', get: () => 'pg.test' }, r);

    expect(sepVerifyPayment).not.toHaveBeenCalled();
    expect(callWebhook).not.toHaveBeenCalledWith(process.env.PAYMENT_SUCCESS_WEBHOOK_URL, expect.anything());
    expect(r.status).toHaveBeenCalledWith(400);
  });
});
