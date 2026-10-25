const crypto = require('crypto');
const paymentSession = require('../services/payment-session.service');
const { logPaymentEvent } = require('../utils/eventLogger');
const { SAFE_ORDER_ID } = require('./frontRedirect');
const {
  resolveGateway, buildGatewayChain, attemptGatewayRequest, GATEWAY_LAST_TIMEOUT_MS, GATEWAY_LAST_RETRIES,
} = require('./gatewaySelection');
const { processQueuedWebhook } = require('./webhookDispatch');
const { handlePaymentCallback } = require('./callbackFlow');
const admin = require('./admin.controller');

// ─── POST /api/payments ───────────────────────────────────────────────────────

// Only your own backend may start a payment: it sends the order's real amount. Without
// this anyone could start one for any order at any amount. Enforced once the secret is configured.
const PAYMENT_CREATE_SECRET = process.env.PAYMENT_CREATE_SECRET || '';

function isTrustedCreator(req) {
  if (!PAYMENT_CREATE_SECRET) return true;
  const given = Buffer.from(String(req.headers['x-internal-secret'] || ''));
  const want = Buffer.from(PAYMENT_CREATE_SECRET);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Gateway minimums (in Rials): Zarinpal=1000, SEP=1000, Zibal=1000
const GATEWAY_MINIMUMS = { zarinpal: 1000, zarinpal_sandbox: 1000, sep: 1000, zibal: 1000 };

// The call's fields come from the body, or from the query string (v1 accepts both).
function readCreateFields(req) {
  const body = req.body || {};
  const query = req.query || {};
  return {
    orderId: body.orderId || query.orderId,
    amount: body.amount !== undefined ? body.amount : query.amount,
    mobile: body.mobile || query.mobile || '',
    requestedGateway: body.gateway || query.gateway,
  };
}

const reject = (status, body, code) => ({ reject: [status, body, code] });

function checkOrderId(orderId) {
  if (!orderId) return reject(400, { error: 'orderId is required' }, 'order_id_required');
  if (!SAFE_ORDER_ID.test(String(orderId))) {
    return reject(400, { error: 'orderId may contain only letters, digits, "-" and "_" (at most 64)' }, 'order_id_invalid');
  }
  return null;
}

function checkAmount(amount, requestedGateway) {
  if (amount === undefined || amount === null || amount === '') return reject(400, { error: 'amount is required' }, 'amount_required');

  const numericAmount = Number(amount);
  if (Number.isNaN(numericAmount) || numericAmount < 0) return reject(400, { error: 'Invalid amount value' }, 'amount_invalid');

  const resolved = resolveGateway(requestedGateway);
  const minimum = GATEWAY_MINIMUMS[resolved] ?? 1000;
  if (numericAmount < minimum) {
    return reject(422, {
      error: 'Amount below gateway minimum',
      message: `Amount ${numericAmount} Rials is below the minimum of ${minimum} Rials required by ${resolved}. Free or low-value payments must be handled directly by your application without calling this service.`,
      minimum,
      received: numericAmount,
    }, 'amount_below_minimum');
  }
  return null;
}

// → { orderId, amount, mobile, requestedGateway } or { reject: [status, body, code] }
function checkCreateFields(fields) {
  return checkOrderId(fields.orderId) || checkAmount(fields.amount, fields.requestedGateway)
    || { ...fields, amount: Number(fields.amount) };
}

const readCreateRequest = (req) => checkCreateFields(readCreateFields(req));

// Tries each gateway of the chain in turn; the last one gets the longer timeout and more retries.
async function requestFromChain(chain, { amount, orderId, mobile }) {
  let attempt = null;
  for (let i = 0; i < chain.length; i++) {
    const gw = chain[i];
    const isLast = i === chain.length - 1;
    const tuning = isLast ? { timeout: GATEWAY_LAST_TIMEOUT_MS, retries: GATEWAY_LAST_RETRIES } : {};
    attempt = await attemptGatewayRequest(gw, { amount, orderId, mobile, ...tuning });
    console.log(`Gateway ${gw} (attempt ${i + 1}/${chain.length}): ok=${attempt.ok}`);
    if (attempt.ok) break;

    logPaymentEvent('payment_failover', {
      gateway: gw, orderId, reason: attempt.reason, next_gateway: chain[i + 1] || null,
    });
  }
  return attempt;
}

// Every gateway of the chain refused: log it and say so.
function answerAllGatewaysFailed(attempt, primaryGateway, orderId) {
  logPaymentEvent('payment_error', {
    error_source: 'gateway', gateway: attempt?.gateway || primaryGateway, orderId,
    reason: attempt?.reason || 'All payment gateways failed',
  });
  return {
    status: 400,
    body: { error: 'Payment gateway error', message: attempt?.reason || 'All payment gateways failed' },
  };
}

// Starts a payment from { orderId, amount, mobile, requestedGateway } → { status, body }. The HTTP route and in-process callers share it.
async function createPayment(fields) {
  try {
    const input = checkCreateFields(fields);
    if (input.reject) return { status: input.reject[0], body: input.reject[1] };
    const { orderId, amount, mobile, requestedGateway } = input;

    const primaryGateway = resolveGateway(requestedGateway);
    const chain = buildGatewayChain(primaryGateway);

    console.log(`Creating payment: orderId=${orderId}, amount=${amount}, gateway=${primaryGateway}, chain=[${chain.join(' → ')}]`);

    const attempt = await requestFromChain(chain, { amount, orderId, mobile });
    if (!attempt || !attempt.ok) return answerAllGatewaysFailed(attempt, primaryGateway, orderId);

    // Store session for amount lookup on callback (needed for Zarinpal verify)
    paymentSession.save(orderId, { amount, gateway: attempt.gateway, mobile });

    logPaymentEvent('payment_initiated', { gateway: attempt.gateway, orderId, amount });

    return { status: 200, body: { targetUrl: attempt.targetUrl, gateway: attempt.gateway, orderId } };
  } catch (err) {
    console.error('createPaymentRequest error:', err.stack || err.message); // never the raw error: axios errors embed request config/auth
    logPaymentEvent('payment_error', { error_source: 'server', reason: err.message });
    return { status: 500, body: { error: 'Internal server error' } }; // no internal text in a reply
  }
}

async function createPaymentRequest(req, res) {
  if (!isTrustedCreator(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { status, body } = await createPayment(readCreateFields(req));
  return res.status(status).json(body);
}

module.exports = {
  isTrustedCreator,
  readCreateRequest,
  requestFromChain,
  createPayment,
  createPaymentRequest,
  handlePaymentCallback,
  processQueuedWebhook,
  ...admin,
};
