// A guest who has paid must not wait on a slow receiver (they may pay again): the bank callback waits a
// few seconds at most, then sends them to the result page's pending state while the hand-over goes on.
jest.mock('../src/services/payment-gateway.service', () => ({ sepVerifyPayment: jest.fn() }));
jest.mock('../src/services/webhook.service', () => ({ deliverSuccess: jest.fn(), callWebhook: jest.fn(async () => ({ ok: true })), deliverFailure: jest.fn(async () => ({ ok: true })), pingWebhook: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/payment-queue.service', () => ({ addToQueue: jest.fn() }));
jest.mock('../src/services/notification.service', () => new Proxy({}, { get: (t, k) => (t[k] ||= jest.fn(async () => {})) }));
jest.mock('../src/utils/eventLogger', () => ({ logPaymentEvent: jest.fn() }));

process.env.PAYMENT_SUCCESS_WEBHOOK_URL = 'http://receiver.test/webhook/success';
process.env.FRONT_SUCCESS_URL = 'https://shop.test/bookings';
process.env.FRONT_FAILURE_URL = 'https://shop.test/payment/result';
process.env.SUCCESS_HANDOFF_WAIT_MS = '50';

const { sepVerifyPayment } = require('../src/services/payment-gateway.service');
const { deliverSuccess } = require('../src/services/webhook.service');
const { addToQueue } = require('../src/services/payment-queue.service');
const { handlePaymentCallback } = require('../src/controllers/payment.controller');

const VERIFIED = { Success: true, ResultCode: 0, TransactionDetail: { RefNum: 'REF-A', AffectiveAmount: 5000000 } };
const call = async () => {
  const r = { status: jest.fn().mockReturnThis(), send: jest.fn(), redirect: jest.fn(), json: jest.fn() };
  await handlePaymentCallback({ query: { RefNum: 'REF-A', ResNum: 'order-b', State: 'OK' }, body: {}, protocol: 'https', get: () => 'pg.test' }, r);
  return r.redirect.mock.calls[0]?.[1];
};
const PENDING = 'https://shop.test/payment/result?kind=pending&gateway=sep&ref=REF-A';

beforeEach(() => { jest.clearAllMocks(); sepVerifyPayment.mockResolvedValue(VERIFIED); });

test('a receiver that confirms in time sends the guest to the success page', async () => {
  deliverSuccess.mockResolvedValue({ ok: true, inProcess: true, pending: false });
  expect(await call()).toBe('https://shop.test/bookings');
  expect(addToQueue).not.toHaveBeenCalled();
});

test('a receiver that only queued it sends the guest to the pending page', async () => {
  deliverSuccess.mockResolvedValue({ ok: true, inProcess: true, pending: true });
  expect(await call()).toBe(PENDING);
});

test('a slow receiver: the guest goes on after the wait, and a later failure still lands in the retry queue', async () => {
  let finish;
  deliverSuccess.mockReturnValue(new Promise((r) => { finish = r; }));
  const t0 = Date.now();
  expect(await call()).toBe(PENDING);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(addToQueue).not.toHaveBeenCalled();
  finish({ ok: false, error: 'receiver down' });
  await new Promise((r) => setImmediate(r));
  expect(addToQueue).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-b', code: 'REF-A' }));
});

test('a failed hand-over is queued and the guest sees pending, not success', async () => {
  deliverSuccess.mockResolvedValue({ ok: false, error: 'receiver down' });
  expect(await call()).toBe(PENDING);
  expect(addToQueue).toHaveBeenCalledTimes(1);
});

test('a receiver that refused the paid order sends the guest to the refused result, not success', async () => {
  deliverSuccess.mockResolvedValue({ ok: true, inProcess: true, pending: false, refused: true });
  expect(await call()).toBe('https://shop.test/payment/result?kind=error&reason=booking_refused&gateway=sep&ref=REF-A');
});
