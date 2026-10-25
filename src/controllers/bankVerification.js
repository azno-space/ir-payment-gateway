'use strict';
// Asking the bank whether a callback's payment really went through: one function per bank, and the
// dispatcher that picks it. Returns what the failure report and the success hand-off need.

const {
  zibalVerifyPayment,
  zarinpalVerifyPayment,
  zarinpalSandboxVerifyPayment,
  sepVerifyPayment,
} = require('../services/payment-gateway.service');
const paymentSession = require('../services/payment-session.service');
const { isBankVerified } = require('../services/bank-verify.service');
const { chargedRial } = require('../utils/chargedAmount');
const {
  isSepCallbackConfirmed,
  extractSepGatewayErrorDesc,
  buildSepCallbackCancelReason,
  buildSepVerifyDetails,
  pick,
} = require('./callbackParams');
const { notifyBaleFailure } = require('./webhookDispatch');

async function verifyZibal(code) {
  const verifyResult = await zibalVerifyPayment(code);
  const verifyOk = isBankVerified('zibal', verifyResult);
  let verifyDetails = {};
  if (verifyOk) {
    verifyDetails = {
      paid_at: verifyResult.paidAt,
      card_number: verifyResult.cardNumber,
      ref_number: verifyResult.refNumber,
      description: verifyResult.description,
      zibal_result: verifyResult.result,
      zibal_message: verifyResult.message,
      zibal_status: verifyResult.status,
      zibal_order_id: verifyResult.orderId,
      zibal_amount: verifyResult.amount,
    };
  }
  return { verifyOk, verifyResult, verifyDetails, zarinpalVerifiedAmount: null };
}

function zarinpalDetails(verifyResult) {
  return {
    card_number: verifyResult.data?.card_pan,
    ref_number: verifyResult.data?.ref_id,
    zarinpal_code: verifyResult.data?.code,
    zarinpal_message: verifyResult.data?.message,
    zarinpal_fee: verifyResult.data?.fee,
    zarinpal_fee_type: verifyResult.data?.fee_type,
  };
}

// The session (2 h) is gone: a late return or a reload. Not verified, so the bank returns the money.
function zarinpalSessionMissing({ gateway, code, orderId }) {
  console.warn(`[Callback] No session found for orderId=${orderId} — cannot verify Zarinpal`);
  notifyBaleFailure({
    title: 'خطا در تأیید پرداخت',
    message: 'نشست پرداخت منقضی شده یا یافت نشد. لطفاً با پشتیبانی تماس بگیرید.',
    gateway, code, orderId,
    stage: 'session_not_found',
  });
  return { stop: [400, 'verify_failed', { gateway, ref: code }] };
}

async function verifyZarinpal(c) {
  const { gateway, code, orderId } = c;
  const amount = paymentSession.get(orderId)?.amount;
  if (!amount) return zarinpalSessionMissing(c);

  const verifyResult = gateway === 'zarinpal_sandbox'
    ? await zarinpalSandboxVerifyPayment(code, amount)
    : await zarinpalVerifyPayment(code, amount);
  const verifyOk = isBankVerified(gateway, verifyResult);
  // zarinpalVerifiedAmount: the exact amount Zarinpal's verify was checked against
  return { verifyOk, verifyResult, verifyDetails: verifyOk ? zarinpalDetails(verifyResult) : {}, zarinpalVerifiedAmount: amount };
}

// SEP sent the guest back without confirming (cancel, decline, or nothing usable): nothing to verify.
function sepCallbackRejected(params) {
  const gatewayErrorDesc = extractSepGatewayErrorDesc(params);
  const cancelReason = buildSepCallbackCancelReason(params);
  return {
    Success: false, sepCallbackRejected: true,
    ResultDescription: gatewayErrorDesc || cancelReason,
    cancelReason, gatewayErrorDesc,
    sepState: params.State || params.state,
    sepStatus: params.Status || params.status,
  };
}

async function askSep(code, params) {
  const refNumToVerify = pick(params, 'RefNum', 'refNum', 'refnum') || code;
  try {
    const verifyResult = await sepVerifyPayment(refNumToVerify);
    return { verifyOk: isBankVerified('sep', verifyResult), verifyResult };
  } catch (err) {
    return { verifyOk: false, verifyResult: { Success: false, ResultDescription: `Verify exception: ${err.message}` } };
  }
}

async function verifySep(code, params) {
  const { verifyOk, verifyResult } = isSepCallbackConfirmed(params)
    ? await askSep(code, params)
    : { verifyOk: false, verifyResult: sepCallbackRejected(params) };
  const verifyDetails = verifyOk ? buildSepVerifyDetails(params, verifyResult) : {};
  return { verifyOk, verifyResult, verifyDetails, zarinpalVerifiedAmount: null };
}

// → { verifyOk, verifyResult, verifyDetails, zarinpalVerifiedAmount } or { stop: sendFailure args }
async function verifyWithGateway(c, params) {
  const { gateway, code } = c;
  let v = { verifyOk: false, verifyResult: null, verifyDetails: {}, zarinpalVerifiedAmount: null };
  if (gateway === 'zibal') v = await verifyZibal(code);
  else if (gateway === 'zarinpal' || gateway === 'zarinpal_sandbox') v = await verifyZarinpal(c);
  else if (gateway === 'sep') v = await verifySep(code, params);
  if (v.stop) return v;

  if (v.verifyOk) {
    // Never re-read the session here: a new payment for the same order may have replaced it while
    // the verify call was in flight.
    v.verifyDetails.charged_rial = chargedRial(gateway, v.verifyResult, v.zarinpalVerifiedAmount);
  }
  return v;
}


module.exports = { verifyWithGateway };
