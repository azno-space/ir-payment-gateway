'use strict';
// API v2, mounted at /api/v2 only when API_V2_ENABLED=true. It sits beside the v1 routes and changes
// none of them: same work underneath, but nouns for paths, one error shape ({ error, code }), a paginated
// list everywhere, and an Idempotency-Key on the call that starts a payment. The contract is
// src/v2/openapi.json; tests/v2Contract.test.js fails when the two disagree.
const express = require('express');
const { createAdminAuth } = require('../utils/adminAuth');
const { sendV2Error } = require('./apiError');
const { readPage, pageOf } = require('./pagination');
const idempotency = require('./idempotency');
const paymentSession = require('../services/payment-session.service');
const paymentQueue = require('../services/payment-queue.service');
const { readErrorLog } = require('../utils/errorLogger');
const { logPaymentEvent } = require('../utils/eventLogger');
const { getZarinpalUnverified } = require('../services/payment-gateway.service');
const { verifyOnce, canVerifyOnce } = require('../services/bank-verify.service');
const { resolveGateway, buildGatewayChain } = require('../controllers/gatewaySelection');
const { isTrustedCreator, readCreateRequest, requestFromChain } = require('../controllers/payment.controller');

const router = express.Router();
router.use(express.json()); // v2 answers a malformed body in its own shape, so it parses its own

// Express 4 does not catch a rejected async handler; this sends it to the error handler below.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const admin = createAdminAuth({ onError: sendV2Error });

// ─── POST /payments — start a payment ────────────────────────────────────────

// What the call means, so the same call spelled another way (key order, "5000" vs 5000) is the same call.
const meaningOf = (body) => ({
  orderId: body.orderId,
  amount: body.amount === undefined ? undefined : Number(body.amount),
  mobile: body.mobile || '',
  gateway: body.gateway || '',
});

// → null when the call may go on, else the answer already sent for a key that is replayed, busy or reused.
function answerForKey(res, key, meaning) {
  const seen = idempotency.begin(key, meaning);
  if (seen.state === 'replay') {
    res.set('Idempotency-Replayed', 'true');
    return res.status(seen.status).json(seen.body);
  }
  if (seen.state === 'busy') return sendV2Error(res, 409, 'request_in_progress', 'A request with this Idempotency-Key is still running');
  if (seen.state === 'mismatch') return sendV2Error(res, 409, 'idempotency_key_reused', 'This Idempotency-Key was used with a different body');
  return null;
}

const rejectedAnswer = ([status, body, code]) => ({
  status: status === 422 ? 400 : status, // v2 does not use 422
  answer: { error: body.message || body.error, code, ...(body.minimum !== undefined && { minimum: body.minimum, received: body.received }) },
});

// Asks the banks and stores the session. → { status, answer }
async function startWithBank({ orderId, amount, mobile, requestedGateway }) {
  const primary = resolveGateway(requestedGateway);
  const attempt = await requestFromChain(buildGatewayChain(primary), { amount, orderId, mobile });
  if (!attempt || !attempt.ok) {
    logPaymentEvent('payment_error', { error_source: 'gateway', gateway: attempt?.gateway || primary, orderId, reason: attempt?.reason || 'All payment gateways failed' });
    return { status: 502, answer: { error: 'No payment gateway could start the payment', code: 'gateway_unavailable' } };
  }
  paymentSession.save(orderId, { amount, gateway: attempt.gateway, mobile });
  logPaymentEvent('payment_initiated', { gateway: attempt.gateway, orderId, amount });
  return { status: 201, answer: { targetUrl: attempt.targetUrl, gateway: attempt.gateway, orderId } };
}

// → { status, answer }; never throws (a failure is a 500 with no internal text).
async function startPaymentFor(body) {
  try {
    const input = readCreateRequest({ body, query: {} });
    return input.reject ? rejectedAnswer(input.reject) : await startWithBank(input);
  } catch (err) {
    console.error('v2 startPayment error:', err.stack || err.message); // never the raw error: axios errors embed request config/auth
    logPaymentEvent('payment_error', { error_source: 'server', reason: err.message });
    return { status: 500, answer: { error: 'internal error', code: 'internal_error' } };
  }
}

// Deliberately not behind an admin key: only your own backend should call it, so it is gated by the
// optional create secret exactly like v1 (and open when PAYMENT_CREATE_SECRET is not set).
const startPayment = wrap(async (req, res) => {
  if (!isTrustedCreator(req)) return sendV2Error(res, 401, 'unauthorized');

  const idem = idempotency.readKey(req);
  if (idem.error) return sendV2Error(res, 400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-128 letters, digits, "-" or "_"');

  const body = req.body || {};
  const meaning = meaningOf(body);
  if (idem.key) {
    const answered = answerForKey(res, idem.key, meaning);
    if (answered) return answered;
  }

  let result = { status: 500, answer: { error: 'internal error', code: 'internal_error' } };
  try {
    result = await startPaymentFor(body);
  } finally {
    // The key is released on every path, even if something outside startPaymentFor's own catch throws.
    if (idem.key && !idempotency.finish(idem.key, meaning, result.status, result.answer)) {
      logPaymentEvent('payment_error', { error_source: 'server', reason: 'Idempotency key could not be stored' });
    }
  }
  return res.status(result.status).json(result.answer);
});
router.post('/payments', startPayment);

// ─── Lists ───────────────────────────────────────────────────────────────────

router.get('/payments/queue-items', admin.read, wrap(async (req, res) => {
  const page = readPage(req.query);
  if (page.invalid) return sendV2Error(res, 400, `invalid_${page.invalid}`, `${page.invalid} must be a positive whole number`);
  const { status } = req.query;
  if (status !== undefined && !['pending', 'dead'].includes(status)) return sendV2Error(res, 400, 'invalid_status', 'status must be pending or dead');
  const items = paymentQueue.getAllItems().filter((i) => !status || i.status === status);
  return res.json(pageOf(items, page));
}));

router.delete('/payments/queue-items/:id', admin.money, wrap(async (req, res) => {
  const { id } = req.params;
  if (!paymentQueue.getAllItems().some((i) => i.id === id)) return sendV2Error(res, 404, 'queue_item_not_found');
  paymentQueue.removeItem(id);
  return res.status(204).end();
}));

router.get('/payments/error-log-entries', admin.read, wrap(async (req, res) => {
  const page = readPage(req.query);
  if (page.invalid) return sendV2Error(res, 400, `invalid_${page.invalid}`, `${page.invalid} must be a positive whole number`);
  return res.json(pageOf(readErrorLog().slice().reverse(), page)); // newest first
}));

router.get('/payments/unverified-payments', admin.read, wrap(async (req, res) => {
  const page = readPage(req.query);
  if (page.invalid) return sendV2Error(res, 400, `invalid_${page.invalid}`, `${page.invalid} must be a positive whole number`);
  const result = await getZarinpalUnverified();
  if (!result.ok) {
    console.error('[v2] unverified-payments failed:', result.error);
    if (result.code === 'not_configured') return sendV2Error(res, 503, 'not_configured', 'the gateway is not configured for this');
    return sendV2Error(res, 502, 'bank_unreachable', 'the gateway did not answer');
  }
  return res.json(pageOf(result.authorities, page));
}));

// ─── POST /payments/verifications — ask a bank whether a payment went through ──
// Money scope, and a POST with a body: a bank verify settles the payment at the bank, so it must not
// be a URL a cache, a prefetcher or an access log can replay.

router.post('/payments/verifications', admin.money, wrap(async (req, res) => {
  const { gateway, code, refNum } = req.body || {};
  if (!gateway || !code) return sendV2Error(res, 400, 'bad_request', 'gateway and code are required');
  if (!canVerifyOnce(gateway)) return sendV2Error(res, 400, 'unsupported_gateway', 'gateway must be zibal, zarinpal or sep');
  const amount = Number(req.body.amount);
  if (gateway === 'zarinpal' && !(amount > 0)) return sendV2Error(res, 400, 'bad_request', 'amount (Rial) is required to verify a Zarinpal payment');

  let verified;
  try {
    ({ verified } = await verifyOnce(gateway, { code, refNum, amount }));
  } catch (err) {
    console.error('[v2] verification: bank call failed:', err.message);
    return sendV2Error(res, 502, 'bank_unreachable', 'gateway verification failed');
  }
  return res.json({ gateway, code, verified });
}));

// ─── Errors ──────────────────────────────────────────────────────────────────

router.use((req, res) => sendV2Error(res, 404, 'not_found'));
router.use((err, req, res, next) => {
  console.error('v2 error:', err.stack || err.message);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  return status < 500 ? sendV2Error(res, status, 'bad_request') : sendV2Error(res, 500, 'internal_error');
});

module.exports = router;
