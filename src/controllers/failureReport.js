'use strict';
// A payment the bank did not confirm: the alert, the log, the failure webhook, and the fixed reason the
// guest is sent with. The bank's own wording stays in the logs and alerts, never in the answer.

const { logPaymentEvent } = require('../utils/eventLogger');
const { sendWarningNotificationToBale } = require('../services/notification.service');
const { notifyBaleFailure, dispatchFailureWebhook } = require('./webhookDispatch');

const isZarinpal = (gateway) => gateway === 'zarinpal' || gateway === 'zarinpal_sandbox';

// The bank's own wording, kept for the logs and alerts only.
const firstOrNull = (...values) => values.find(Boolean) ?? null;

function bankMessage(gateway, verifyResult) {
  if (isZarinpal(gateway) && verifyResult?.data) return verifyResult.data.message || null;
  if (gateway === 'sep') return firstOrNull(verifyResult?.gatewayErrorDesc, verifyResult?.cancelReason, verifyResult?.ResultDescription);
  return null;
}

// buildSepCallbackCancelReason's own 4-way split: only the "gateway sent no response at all" case is a
// genuine operational anomaly — user cancellations, bank declines, and unrecognized state/status
// combos are expected business outcomes and stay warning-only.
function alertIfSepSaidNothing({ gateway, code, orderId }, verifyResult) {
  if (verifyResult?.sepState || verifyResult?.sepStatus) return;
  console.warn('[callback] sep_callback_no_response: the bank sent an empty state and status', { gateway, code, orderId });
}

// SEP told us the guest cancelled or the bank declined: an expected outcome, a warning and nothing more.
async function reportSepCancel(c, verifyResult, gatewayErrorMsg) {
  const { gateway, code, orderId } = c;
  const cancelReason = verifyResult?.cancelReason || 'نامشخص';
  await sendWarningNotificationToBale({
    title: 'انصراف یا رد پرداخت SEP',
    gateway, code, orderId, cancelReason,
    sepState: verifyResult?.sepState,
    sepStatus: verifyResult?.sepStatus,
    gatewayErrorDesc: verifyResult?.gatewayErrorDesc,
  });
  alertIfSepSaidNothing(c, verifyResult);
  logPaymentEvent('payment_warning', {
    error_source: 'gateway', gateway, orderId,
    reason: gatewayErrorMsg || cancelReason,
    cancel_reason: cancelReason,
  });
}

// The bank looked at the payment and did not confirm it: an alert and an error.
function reportRejected(c, verifyResult, gatewayErrorMsg) {
  const { gateway, code, orderId } = c;
  notifyBaleFailure({
    title: 'تأیید پرداخت ناموفق بود',
    message: gatewayErrorMsg || 'Gateway verification failed',
    gateway, code, orderId, verifyResult,
    stage: 'verify_failed',
  });
  logPaymentEvent('payment_error', {
    error_source: 'gateway', gateway, orderId,
    reason: gatewayErrorMsg || 'Verification failed',
  });
}

// The fixed reason the guest is sent with; the bank's wording never reaches them.
function guestReason(isSepCancel, isRetryAttempt) {
  if (isSepCancel) return 'cancelled';
  return isRetryAttempt ? 'verify_retry_failed' : 'verify_failed';
}

async function reportVerifyFailure(c, v, isRetryAttempt) {
  const { gateway, code, orderId } = c;
  const { verifyResult } = v;
  const gatewayErrorMsg = bankMessage(gateway, verifyResult);
  const isSepCancel = Boolean(gateway === 'sep' && verifyResult?.sepCallbackRejected);

  if (isSepCancel) await reportSepCancel(c, verifyResult, gatewayErrorMsg);
  else reportRejected(c, verifyResult, gatewayErrorMsg);

  dispatchFailureWebhook({ orderId, gateway, code, reason: gatewayErrorMsg || 'Verification failed' });

  return [400, guestReason(isSepCancel, isRetryAttempt), { gateway, ref: code }];
}

module.exports = { reportVerifyFailure };
