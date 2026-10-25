'use strict';
// Telling the receiver (your backend) and the alert channel what happened to a payment.

const { deliverFailure, deliverSuccess } = require('../services/webhook.service');
const paymentQueue = require('../services/payment-queue.service');
const { appendErrorLog } = require('../utils/errorLogger');
const {
  sendFailedPaymentNotificationToBale,
  sendPaymentSuccessNotificationToBale,
} = require('../services/notification.service');

const PAYMENT_SUCCESS_WEBHOOK_URL = process.env.PAYMENT_SUCCESS_WEBHOOK_URL || '';
const PAYMENT_FAILURE_WEBHOOK_URL = process.env.PAYMENT_FAILURE_WEBHOOK_URL || '';

function notifyBaleFailure(errorDetails) {
  setImmediate(() => {
    sendFailedPaymentNotificationToBale(errorDetails).catch((err) =>
      console.error('Failed to send Bale failure notification:', err.message),
    );
  });
  appendErrorLog({ type: 'payment_failure', ...errorDetails });
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

// How long the bank callback waits for the receiver before sending the guest on. A slow receiver
// must not keep a guest who has paid on a blank page (they may pay again); the hand-over keeps
// running and lands in the retry queue if it fails.
const SUCCESS_HANDOFF_WAIT_MS = parseInt(process.env.SUCCESS_HANDOFF_WAIT_MS || '8000', 10);

async function dispatchSuccessWebhook({ orderId, gateway, code, verifyDetails, onDelivered }) {
  const payload = {
    orderId,
    gateway,
    code,
    status: 'success',
    verifyDetails,
    timestamp: new Date().toISOString(),
  };

  const delivery = deliverSuccess(PAYMENT_SUCCESS_WEBHOOK_URL, payload).then((result) => {
    if (!result.ok && !result.skipped) {
      paymentQueue.addToQueue({ orderId, gateway, code, verifyDetails, payload });
      console.warn(`[Webhook] Success webhook failed — queued for retry. orderId=${orderId}`);
    }
    if (onDelivered && result.ok && !result.pending && !result.refused) onDelivered(); // a slow receiver that answered after the guest moved on
    return result;
  });
  let timer;
  const waited = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: true, pending: true, slow: true }), SUCCESS_HANDOFF_WAIT_MS); });
  const result = await Promise.race([delivery, waited]);
  clearTimeout(timer);
  if (result.slow) console.warn(`[Webhook] receiver still working after ${SUCCESS_HANDOFF_WAIT_MS}ms — guest sent to the pending page. orderId=${orderId}`);
  return result;
}

async function dispatchFailureWebhook({ orderId, gateway, code, reason }) {
  // PAYMENT_FAILURE_WEBHOOK_URL must stay set even though an in-process handler no longer calls it:
  // this early return is what keeps failures from being handled where it is unset. When the
  // /webhook/* routes are removed, change this gate in the same change or failures silently stop.
  if (!PAYMENT_FAILURE_WEBHOOK_URL) return;
  // A failure the merchant cannot place (a repeated bank cancel callback carries no order id) is only
  // logged; posting it just earns a 400 from the merchant and an error line.
  if (!orderId) {
    console.warn(`[Webhook] failure without an order id not sent — gateway=${gateway} reason=${String(reason).slice(0, 120)}`);
    return;
  }
  const payload = {
    orderId,
    gateway,
    code,
    status: 'failed',
    reason,
    timestamp: new Date().toISOString(),
  };
  deliverFailure(PAYMENT_FAILURE_WEBHOOK_URL, payload, { retries: 1 }).catch(() => {});
}

// Queue worker: retries a success the receiver did not take. Throws to keep the item queued (the queue
// backs off and, after its last attempt, marks it dead with an alert).
async function processQueuedWebhook(item) {
  const { id, orderId, gateway, code, verifyDetails, retryCount } = item;
  console.log(`[Queue] Retrying webhook id=${id} orderId=${orderId} retry=${retryCount}`);

  const result = await deliverSuccess(PAYMENT_SUCCESS_WEBHOOK_URL, item.payload || {
    orderId, gateway, code, status: 'success', verifyDetails, timestamp: new Date().toISOString(),
  }, { retries: 1 });

  if (!result.ok) throw new Error(result.error?.message || result.error || 'success receiver did not take it');
  if (process.env.CALLBACK_REPLAY_GUARD === 'true') require('../services/verified-ledger.service').settle(gateway, code, 'done');
  console.log(`[Queue] Webhook delivered — id=${id} orderId=${orderId}`);
  setImmediate(() => {
    sendPaymentSuccessNotificationToBale({ gateway, code, orderId }).catch(() => {});
  });
}

module.exports = {
  PAYMENT_SUCCESS_WEBHOOK_URL,
  notifyBaleFailure,
  dispatchSuccessWebhook,
  dispatchFailureWebhook,
  processQueuedWebhook,
};
