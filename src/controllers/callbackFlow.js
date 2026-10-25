'use strict';
// The bank callback (GET or POST /api/payments/callback), one stage per function, in the order they
// run: read what the bank sent, refuse what cannot be trusted, check the receiver is up, verify with
// the bank, then report a failure or hand a success to the receiver. A stage that ends the request
// returns the arguments for sendFailure; the caller sends the answer, so every side effect keeps its
// place before the answer exactly as it did when this was one function.

const { emitAlertEvent } = require('../alerts');
const { pingWebhook } = require('../services/webhook.service');
const paymentSession = require('../services/payment-session.service');
const { logPaymentEvent } = require('../utils/eventLogger');
const {
  sendErrorNotificationToBale,
  sendPaymentSuccessNotificationToBale,
} = require('../services/notification.service');
const { parseGatewayParams, pick } = require('./callbackParams');
const { verifyWithGateway } = require('./bankVerification');
const { reportVerifyFailure } = require('./failureReport');
const {
  FRONT_FAILURE_URL, SAFE_ORDER_ID, withOrderId, sendFailure, successUrl, redirectPending,
} = require('./frontRedirect');
const ledger = require('../services/verified-ledger.service');
const {
  PAYMENT_SUCCESS_WEBHOOK_URL, notifyBaleFailure, dispatchSuccessWebhook, dispatchFailureWebhook,
} = require('./webhookDispatch');

// Off unless CALLBACK_REPLAY_GUARD=true: a payment already verified and handed to the receiver is not
// verified, handed over or announced a second time; the guest is sent where the first callback sent them.
const REPLAY_GUARD = process.env.CALLBACK_REPLAY_GUARD === 'true';

// → the answer to send for a payment that was already taken, from what the first callback achieved.
// The order id is the one the first callback recorded, never the one this request claims.
function answerForReplay(res, c, entry) {
  logPaymentEvent('payment_replay', { gateway: c.gateway, orderId: entry.orderId, code: c.code });
  const pending = entry.outcome === 'pending' || entry.outcome === 'claimed';
  if (FRONT_FAILURE_URL && entry.outcome === 'refused') return sendFailure(res, 409, 'booking_refused', { gateway: c.gateway, ref: c.code });
  if (FRONT_FAILURE_URL && pending) return redirectPending(res, { gateway: c.gateway, code: c.code });
  return res.redirect(302, withOrderId(successUrl(), entry.orderId));
}

// ─── 1. Read ──────────────────────────────────────────────────────────────────

// What the bank sent that marks a SEP callback, including a cancel that carries no reference.
function readSepSignal(params) {
  const resNum = pick(params, 'ResNum', 'resNum', 'resnum');
  const refNum = pick(params, 'RefNum', 'refNum', 'refnum');
  const isSignal = Boolean(pick(params, 'Status', 'status') || pick(params, 'State', 'state') || resNum || refNum);
  return { isSignal, resNum, refNum };
}

function readCallback(params) {
  let { gateway, code, orderId } = parseGatewayParams(params);
  const sep = readSepSignal(params);

  if ((!gateway || !code) && sep.isSignal) {
    gateway = 'sep';
    orderId = orderId || sep.resNum || orderId;
    code = code || sep.refNum || code;
  }
  return { gateway, code, orderId, isSepSignal: sep.isSignal, sepRefNum: sep.refNum };
}

// ─── 2. Refuse what cannot be trusted ─────────────────────────────────────────

// Each check → null to go on, or the sendFailure arguments that end the request.

// qs/JSON turn RefNum[]=X into ['X']: the gateway still verifies "X", but a receiver's
// one-payment-one-order lock would key a different value, letting one payment confirm many orders.
// An order id is the merchant's own reference echoed back by the bank (ResNum). Only plain id
// characters pass: it is forwarded to the merchant's webhook and may end up in a URL path there.
function refuseMalformed({ gateway, code, orderId }) {
  if ((code != null && typeof code !== 'string') || (orderId != null && typeof orderId !== 'string')) {
    logPaymentEvent('payment_warning', { gateway, reason: 'Non-string payment reference rejected' });
    return [400, 'incomplete_params', { gateway }];
  }
  if (orderId && !SAFE_ORDER_ID.test(orderId)) {
    logPaymentEvent('payment_warning', { gateway, reason: 'Malformed order id rejected' });
    return [400, 'incomplete_params', { gateway }];
  }
  return null;
}

function refuseIncomplete(c, params) {
  const { gateway, code, orderId } = c;
  if (gateway && code) return null;

  const isSepCancel = c.isSepSignal && !c.sepRefNum;
  const title = isSepCancel ? 'پرداخت لغو شد' : 'اطلاعات پرداخت ناقص است';
  const message = isSepCancel
    ? 'تراکنش توسط بانک لغو شد یا پرداخت توسط شما انصراف داده شد.'
    : 'اطلاعات لازم برای بررسی پرداخت در درخواست موجود نیست.';

  notifyBaleFailure({ title, message, error: `Missing gateway or code\nParams: ${JSON.stringify(params)}`, stage: 'callback_missing_params' });
  dispatchFailureWebhook({ orderId, gateway: gateway || 'unknown', code: code || '', reason: title });

  return [400, isSepCancel ? 'cancelled' : 'incomplete_params', { gateway }];
}

function refuseZarinpalCancel({ gateway, code, orderId }, params) {
  if (!(gateway === 'zarinpal' && (params.Status === 'NOK' || params.status === 'NOK'))) return null;
  logPaymentEvent('payment_warning', { gateway, orderId, reason: 'User cancelled' });
  dispatchFailureWebhook({ orderId, gateway, code, reason: 'User cancelled Zarinpal payment' });
  return [400, 'cancelled', { gateway }];
}

function refuseUntrusted(c, params) {
  return refuseMalformed(c) || refuseIncomplete(c, params) || refuseZarinpalCancel(c, params);
}

// ─── 3. Is the receiver up? ───────────────────────────────────────────────────

async function checkReceiverHealthy(c) {
  if (!PAYMENT_SUCCESS_WEBHOOK_URL) return null;
  const { gateway, code, orderId } = c;
  const ping = await pingWebhook(PAYMENT_SUCCESS_WEBHOOK_URL);
  if (ping.ok) return null;

  console.warn(`[Callback] Webhook health check failed — aborting verify. orderId=${orderId}`);
  logPaymentEvent('payment_warning', {
    gateway,
    orderId,
    reason: 'Webhook health check failed before verify',
  });
  const webhookHealthCheckErrorDetails = {
    title: 'وب‌هوک در دسترس نیست',
    message: 'پیش از verify درگاه، health check وب‌هوک شکست خورد.',
    gateway,
    code,
    orderId,
    stage: 'webhook_health_check_failed',
  };
  setImmediate(() => {
    sendErrorNotificationToBale(webhookHealthCheckErrorDetails).catch(() => {});
  });
  // Not verified, so the bank returns the money on its own; support can still look it up.
  return [503, 'verify_retry_failed', { gateway, ref: code }];
}

// ─── 6. A payment the bank confirmed ──────────────────────────────────────────

// Two callbacks for one payment can both pass the early check while the bank is being asked.
// → null to go on (this callback holds the payment), or the ledger entry to answer a replay with.
function takeForGuard(c) {
  if (!REPLAY_GUARD) return null;
  const { gateway, code, orderId } = c;
  const taken = ledger.claim(gateway, code, orderId, { takeOverPending: c.isRetryAttempt });
  if (!taken.claimed) return ledger.seen(gateway, code) || { outcome: 'pending', orderId };
  if (!taken.stored) {
    emitAlertEvent('replay_ledger_write_failed', { gateway, code, orderId });
    console.error('[callback] replay_ledger_write_failed: the replay guard is on but the ledger could not be written; a repeat of this callback is not caught', { gateway, code, orderId });
  }
  return null;
}

// Hand the success to the receiver (retry queue behind it); wait a few seconds at most.
async function handOver(c, v) {
  const { gateway, code, orderId } = c;
  try {
    return await dispatchSuccessWebhook({
      orderId, gateway, code, verifyDetails: v.verifyDetails,
      onDelivered: REPLAY_GUARD ? () => ledger.settle(gateway, code, 'done') : undefined,
    });
  } catch (err) {
    if (REPLAY_GUARD) ledger.release(gateway, code); // not handed over: the next callback must process it
    throw err;
  }
}

// Paid but not yet final: the receiver was slow, failed, or only queued it.
const isPendingHandoff = (handoff) => Boolean((handoff.pending || !handoff.ok) && !handoff.skipped);

function settleLedger(c, handoff) {
  if (!REPLAY_GUARD) return;
  let outcome = 'done';
  if (handoff.refused) outcome = 'refused';
  else if (isPendingHandoff(handoff)) outcome = 'pending';
  ledger.settle(c.gateway, c.code, outcome);
}

function answerAfterHandoff(res, c, handoff) {
  const { gateway, code, orderId } = c;
  // The receiver could not book the paid order (e.g. dates filled meanwhile) and refunds it.
  if (handoff.refused && FRONT_FAILURE_URL) return sendFailure(res, 409, 'booking_refused', { gateway, ref: code });

  // The result page's pending state says the bank took the money and the booking updates by itself, so
  // the guest does not pay a second time.
  if (isPendingHandoff(handoff) && FRONT_FAILURE_URL) return redirectPending(res, { gateway, code });

  return res.redirect(302, withOrderId(successUrl(), orderId));
}

async function completeVerifiedPayment(res, c, v) {
  const { gateway, code, orderId } = c;
  const replay = takeForGuard(c);
  if (replay) return answerForReplay(res, c, replay);
  logPaymentEvent('payment_success', { gateway, orderId, code });

  // Clean up session
  if (orderId) paymentSession.remove(orderId);

  const handoff = await handOver(c, v);

  // Non-blocking success notification
  setImmediate(() => {
    sendPaymentSuccessNotificationToBale({ gateway, code, orderId }).catch(() => {});
  });

  settleLedger(c, handoff);
  return answerAfterHandoff(res, c, handoff);
}

// ─── The handler ──────────────────────────────────────────────────────────────

// → the ledger entry when this callback is a replay of a payment already taken (guard on), else null.
// retry=true is the recovery path: it may take over a hand-over that was only queued (see claim).
function replayEntry(c) {
  if (!REPLAY_GUARD) return null;
  const already = ledger.seen(c.gateway, c.code);
  return already && !(c.isRetryAttempt && already.outcome === 'pending') ? already : null;
}

async function handlePaymentCallback(req, res) {
  const params = { ...(req.body || {}), ...(req.query || {}) };
  const isRetryAttempt = params.retry === 'true' || params.retry === true;

  const c = readCallback(params);
  c.isRetryAttempt = isRetryAttempt;
  const refused = refuseUntrusted(c, params);
  if (refused) return sendFailure(res, ...refused);

  const replay = replayEntry(c);
  if (replay) return answerForReplay(res, c, replay);

  const receiverDown = await checkReceiverHealthy(c);
  if (receiverDown) return sendFailure(res, ...receiverDown);

  const v = await verifyWithGateway(c, params);
  if (v.stop) return sendFailure(res, ...v.stop);

  c.orderId = c.orderId || '';
  if (!v.verifyOk) return sendFailure(res, ...(await reportVerifyFailure(c, v, isRetryAttempt)));
  return completeVerifiedPayment(res, c, v);
}

module.exports = { handlePaymentCallback };
