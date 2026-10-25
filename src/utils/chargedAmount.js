'use strict';

// The amount the bank confirmed it charged, taken only from a server-to-server answer — never from
// the callback the guest's browser relays. A receiver should refuse to confirm an order when this
// is missing or below the order's own amount, so it must be trustworthy:
// - zibal: the verify response's amount.
// - zarinpal: verify succeeds only when the amount we send matches what was paid, and we send the
//   amount stored when the payment was started.
// - sep: VerifyTransaction's TransactionDetail.OrginalAmount (SEP's spelling).
// null when the gateway did not report one.
const RAW_AMOUNT = {
  zibal: (verifyResult) => verifyResult?.amount,
  zarinpal: (verifyResult, sessionAmount) => sessionAmount,
  zarinpal_sandbox: (verifyResult, sessionAmount) => sessionAmount,
  sep: (verifyResult) => verifyResult?.TransactionDetail?.OrginalAmount,
};

function chargedRial(gateway, verifyResult, sessionAmount) {
  const known = typeof gateway === 'string' && Object.hasOwn(RAW_AMOUNT, gateway);
  const raw = known ? RAW_AMOUNT[gateway](verifyResult, sessionAmount) : undefined;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

module.exports = { chargedRial };
