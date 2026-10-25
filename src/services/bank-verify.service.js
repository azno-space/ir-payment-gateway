'use strict';
// "Did the bank confirm this payment?" has one owner: the success rule per bank, and the
// one bank question for the admin verify-only (v1) and the v2 verifications. The bank callback keeps its own
// asking (it needs the stored session amount and builds the verify details) but judges the answer here.
//   zibal: result 100 (verified) or 201 (already verified)
//   zarinpal / sandbox: data.code 100 (verified) or 101 (already verified)
//   sep: Success === true (a repeat VerifyTransaction answers ResultCode 2 with Success false: not a yes here)
const {
  zibalVerifyPayment,
  zarinpalVerifyPayment,
  sepVerifyPayment,
} = require('./payment-gateway.service');

const zarinpalOk = (r) => Boolean(r?.data && (r.data.code === 100 || r.data.code === 101));

const SUCCESS = {
  zibal: (r) => Boolean(r && (r.result === 100 || r.result === 201)),
  zarinpal: zarinpalOk,
  zarinpal_sandbox: zarinpalOk,
  sep: (r) => r?.Success === true,
};

// One bank question each. Throws when the bank cannot be reached.
const ASK = {
  zibal: ({ code }) => zibalVerifyPayment(Number(code)),
  zarinpal: ({ code, amount }) => zarinpalVerifyPayment(String(code), amount),
  sep: ({ code, refNum }) => sepVerifyPayment(String(refNum || code)),
};

const isBankVerified = (gateway, verifyResult) => Object.hasOwn(SUCCESS, gateway) && SUCCESS[gateway](verifyResult);
const canVerifyOnce = (gateway) => typeof gateway === 'string' && Object.hasOwn(ASK, gateway);

// → { verifyResult, verified }
async function verifyOnce(gateway, args) {
  const verifyResult = await ASK[gateway](args);
  return { verifyResult, verified: isBankVerified(gateway, verifyResult) };
}

module.exports = { isBankVerified, canVerifyOnce, verifyOnce };
