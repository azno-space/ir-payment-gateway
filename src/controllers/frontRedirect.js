'use strict';
// Where the guest is sent after the bank: the success page, the result page for a failure or a pending
// payment. The gateway renders no pages. The URLs are read from the environment when this module loads.

const FRONT_BASE_URL = process.env.FRONT_BASE_URL || '';
const SAFE_ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FRONT_SUCCESS_URL = process.env.FRONT_SUCCESS_URL || (FRONT_BASE_URL ? `${FRONT_BASE_URL}/payment/success` : '');
const frontUrl = (p) => `${FRONT_BASE_URL}${p}`;

// FRONT_SUCCESS_URL may contain {orderId}; it is replaced by the paid order's id (plain ids only).
// Without the placeholder the URL is used exactly as given. A placeholder with no usable id falls back to
// FRONT_SUCCESS_FALLBACK_URL, else to <FRONT_BASE_URL>/payment/success.
function withOrderId(url, orderId) {
  if (!url.includes('{orderId}')) return url;
  const id = String(orderId ?? '');
  if (SAFE_ORDER_ID.test(id)) return url.split('{orderId}').join(id);
  return process.env.FRONT_SUCCESS_FALLBACK_URL || frontUrl('/payment/success') || '/';
}

// The gateway renders no pages. A failed or cancelled payment sends the customer to your front end's
// result page with a stable reason code (your page owns the wording); without FRONT_FAILURE_URL the
// answer is plain JSON. Codes: cancelled, incomplete_params, verify_failed,
// verify_retry_failed, booking_refused (paid, but the receiver could not book it and refunds it). `ref` is the bank reference when it is a plain id.
// A malformed value is reported once at start and ignored (JSON answers), never a 500 per request.
const FRONT_FAILURE_URL = (() => {
  const v = process.env.FRONT_FAILURE_URL || '';
  if (!v) return '';
  try { new URL(v); return v; } catch { console.error(`[Config] FRONT_FAILURE_URL is not a URL, ignored: ${v}`); return ''; }
})();
const SAFE_REF = /^[A-Za-z0-9-]{1,64}$/;
function sendFailure(res, status, reason, { gateway, ref } = {}) {
  if (FRONT_FAILURE_URL) {
    const u = new URL(FRONT_FAILURE_URL);
    u.searchParams.set('kind', 'error');
    u.searchParams.set('reason', reason);
    if (gateway && SAFE_REF.test(gateway)) u.searchParams.set('gateway', gateway);
    if (typeof ref === 'string' && SAFE_REF.test(ref)) u.searchParams.set('ref', ref);
    return res.redirect(302, u.toString());
  }
  return res.status(status).json({ success: false, error: { code: reason } });
}

const successUrl = () => FRONT_SUCCESS_URL || frontUrl('/payment/success') || '/';

// Paid, but the receiver has not taken it yet: the result page's pending state tells the guest not to pay twice.
function redirectPending(res, { gateway, code }) {
  const u = new URL(FRONT_FAILURE_URL);
  u.searchParams.set('kind', 'pending');
  if (gateway && SAFE_REF.test(gateway)) u.searchParams.set('gateway', gateway);
  if (typeof code === 'string' && SAFE_REF.test(code)) u.searchParams.set('ref', code);
  return res.redirect(302, u.toString());
}

module.exports = { FRONT_FAILURE_URL, SAFE_ORDER_ID, SAFE_REF, frontUrl, withOrderId, sendFailure, successUrl, redirectPending };
