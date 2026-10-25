'use strict';
// Admin endpoints: look-ups, verify-only, the retry queue, the Zarinpal list and the SEP refund and
// report calls. Which key may call which route is decided in routes/payment.routes.js.

const {
  sepRefundReg,
  sepRefundExec,
  sepGetDailyRefundList,
  sepGetRefundStatus,
  sepGetRefundDetail,
  sepGetRefundStatusByRequestId,
  sepRefreshRefundRequest,
  getZarinpalUnverified,
} = require('../services/payment-gateway.service');
const { readErrorLog } = require('../utils/errorLogger');
const sepReport = require('../services/sep-report.service');
const paymentQueue = require('../services/payment-queue.service');
const { verifyOnce, canVerifyOnce } = require('../services/bank-verify.service');
const { sendError } = require('../utils/apiError');
const { checkRefreshable } = require('../sep/refreshGuard');
const { isSepAnswer } = require('../sep/soapAnswer');
const { claimRefresh } = require('../sep/refreshClaim');
const { VALID_GATEWAYS } = require('./gatewaySelection');

// ─── GET /api/payments/admin/verify-only ─────────────────────────────────────

async function adminVerifyOnly(req, res) {
  const { gateway, code } = req.query;
  if (!gateway || !code) {
    return sendError(res, 400, 'bad_request', 'gateway and code are required');
  }
  if (!canVerifyOnce(gateway)) {
    return sendError(res, 400, 'bad_request', 'unsupported gateway', { validGateways: VALID_GATEWAYS });
  }

  let answer;
  try {
    answer = await verifyOnce(gateway, { code, amount: Number(req.query.amount || 1), refNum: req.query.RefNum || req.query.refNum });
  } catch (err) {
    console.error('[Admin] verify-only: bank call failed:', err.message);
    return sendError(res, 502, 'bank_unreachable', 'gateway verification failed');
  }
  if (!answer.verified) return sendError(res, 400, 'not_verified', null, { verified: false, gateway, code, verifyResult: answer.verifyResult });

  return res.json({ success: true, verified: true, gateway, code, verifyResult: answer.verifyResult });
}

// ─── GET /api/payments/admin/error-log ───────────────────────────────────────

async function adminGetErrorLog(req, res) {
  const logs  = readErrorLog();
  const limit = Math.min(Number(req.query.limit || 50), 500);
  return res.json({ count: logs.length, entries: logs.slice(-limit) });
}

// ─── GET /api/payments/admin/queue ───────────────────────────────────────────

async function adminGetQueue(req, res) {

  const allItems   = paymentQueue.getAllItems();
  const pending    = allItems.filter((i) => i.status === 'pending');
  const dead       = allItems.filter((i) => i.status === 'dead');

  return res.json({
    summary: {
      total: allItems.length,
      pending: pending.length,
      dead: dead.length,
      held: allItems.filter((i) => i.held).length,
    },
    items: allItems,
  });
}

// ─── DELETE /api/payments/admin/queue/:id ────────────────────────────────────

async function adminRemoveQueueItem(req, res) {
  const { id } = req.params;
  if (!id) return sendError(res, 400, 'bad_request', 'id is required');
  paymentQueue.removeItem(id);
  return res.json({ ok: true, removed: id });
}

// ─── GET /api/payments/admin/zarinpal-unverified ─────────────────────────────

async function adminZarinpalUnverified(req, res) {
  const result = await getZarinpalUnverified();
  if (!result.ok) {
    console.error('[Admin] zarinpal-unverified failed:', result.error);
    return sendError(res, 502, 'bank_unreachable', 'zarinpal did not answer', { authorities: [] });
  }
  return res.json({ success: true, count: result.count, authorities: result.authorities });
}

// ─── SEP Refund APIs ──────────────────────────────────────────────────────────

async function adminSepRefundReg(req, res) {
  const { refNum, resNum, amount, requestId, exeTime, email, cellNumber, documentDescription, dicData } = req.body || {};
  if (!refNum || !resNum || !amount || !requestId) {
    return sendError(res, 400, 'bad_request', 'missing required fields: refNum, resNum, amount, requestId');
  }
  const result = await sepRefundReg({ refNum, resNum, amount, requestId, exeTime, email, cellNumber, documentDescription, dicData });
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundExec(req, res) {
  const { partialRefundId, typRefundAction } = req.body || {};
  if (!partialRefundId || !typRefundAction) {
    return sendError(res, 400, 'bad_request', 'missing required fields: partialRefundId, typRefundAction');
  }
  const result = await sepRefundExec({ partialRefundId, typRefundAction });
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundList(req, res) {
  const result = await sepGetDailyRefundList();
  res.status(result.status).type('application/xml').send(result.data);
}

// Digits only: Number('0x5') is 5, and the old check let it through to refresh request 5.
const isRefundId = (v) => /^[1-9]\d*$/.test(String(v)) && (typeof v === 'string' || typeof v === 'number');

async function adminSepRefundStatus(req, res) {
  const { refundId } = req.body || {};
  if (!refundId) return sendError(res, 400, 'bad_request', 'missing required field: refundId');
  const result = await sepGetRefundStatus({ refundId });
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundDetail(req, res) {
  const { refundId } = req.body || {};
  if (!refundId) return sendError(res, 400, 'bad_request', 'missing required field: refundId');
  const result = await sepGetRefundDetail({ refundId });
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundStatusByRequestId(req, res) {
  const { requestId } = req.body || {};
  if (!(Number(requestId) > 0)) return sendError(res, 400, 'bad_request', 'missing or invalid field: requestId');
  const result = await sepGetRefundStatusByRequestId({ requestId });
  res.status(result.status).type('application/xml').send(result.data);
}

// Looks the request up at SEP and refreshes it when (and only when) it is safe; the caller holds the claim.
async function refreshWhenSafe(res, claim, refundId, description) {
  // SEP being down (the SOAP call throws) is not "no such refund" and not a server bug: it is a bank outage, 502.
  let detail;
  try {
    detail = await sepGetRefundDetail({ refundId });
  } catch (_) {
    return sendError(res, 502, 'bank_unreachable', 'SEP did not answer the refund lookup', { refundId });
  }
  // SEP being down is not "no such refund": an operator could take that for "never registered".
  if (!isSepAnswer(detail)) return sendError(res, 502, 'bank_unreachable', 'SEP did not answer the refund lookup', { refundId });
  const verdict = checkRefreshable(detail.data, refundId);
  if (!verdict.ok) return sendError(res, verdict.status, verdict.code, verdict.message, { refundId, ...verdict.details });
  await claim.stamp(); // the cooldown starts before the request goes out; if it cannot be recorded, nothing is sent
  let result;
  try {
    result = await sepRefreshRefundRequest({ partialRefundInfoId: refundId, description });
  } catch (_) {
    // nothing was refreshed; the cooldown stays, so a retry waits for it like any other refresh
    return sendError(res, 502, 'bank_unreachable', 'SEP did not accept the refresh', { refundId });
  }
  res.status(result.status).type('application/xml').send(result.data);
}

// Not now: something else owns this refund (a person pays it by hand, it is already paid back), or a refresh
// was just sent or is being sent.
function refuseClaim(res, refundId, claim) {
  if (claim.hold) return sendError(res, 409, claim.hold, 'this refund is no longer the gateway\'s to refresh', { refundId });
  return sendError(res, 409, 'refresh_cooldown', 'a refresh of this refund was just sent or is being sent; SEP needs a full cycle to act on it', { refundId, retryAfterSeconds: claim.retryAfterSeconds });
}

async function adminSepRefundRefresh(req, res) {
  const { refundId, description } = req.body || {};
  if (!isRefundId(refundId)) return sendError(res, 400, 'bad_request', 'missing or invalid field: refundId');
  const claim = await claimRefresh(refundId);
  if (!claim.ok) return refuseClaim(res, refundId, claim);
  try {
    await refreshWhenSafe(res, claim, refundId, description);
  } finally {
    claim.release();
  }
}

// Every SEP transaction for a Persian date range, from SEP's own report service — finds a
// charge whose callback never reached you. Body: { fromDate, toDate } as 'YYYY/MM/DD'.
async function adminSepReport(req, res) {
  if (!sepReport.isConfigured()) return sendError(res, 503, 'not_configured', 'SEP report is not configured');
  try {
    const { fromDate, toDate } = req.body || {};
    const rows = await sepReport.sepGetTransactionReport({ fromDate, toDate });
    res.json({ count: rows.length, rows });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, 'bad_request', 'fromDate and toDate must be Persian dates YYYY/MM/DD');
    console.error('[Admin] sep report failed:', err.message);
    return sendError(res, 502, 'bank_unreachable', 'SEP report failed');
  }
}

module.exports = {
  adminVerifyOnly,
  adminGetErrorLog,
  adminGetQueue,
  adminRemoveQueueItem,
  adminZarinpalUnverified,
  adminSepRefundReg,
  adminSepRefundExec,
  adminSepRefundList,
  adminSepRefundStatus,
  adminSepRefundDetail,
  adminSepRefundStatusByRequestId,
  adminSepRefundRefresh,
  adminSepReport,
};
