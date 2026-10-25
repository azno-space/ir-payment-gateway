'use strict';
// A refresh asks SEP to re-queue a failed refund. It is only safe when the request failed overall
// with exec code 114: refreshing an unknown outcome is how a refund gets paid twice (SEP refund doc
// §5.13). Judged from SEP's own detail row, never from the caller's word.
const { parseDailyRefundList, REFUND_STATUS } = require('./refundResponse');

// The one definition of "safe to refresh": the request failed overall with exec code 114. The refund
// job and the admin route both ask this, so they cannot drift apart.
const isRefreshable = (row) => row.refundStatusCode === REFUND_STATUS.FAIL && row.attemptStatusCode === '114';

// `refundId` is the id the caller asked about: SEP must have answered for exactly that request.
function checkRefreshable(detailXml, refundId) {
  const row = parseDailyRefundList(detailXml).rows[0];
  if (!row) return { ok: false, status: 404, code: 'not_found', message: 'SEP has no report row for this refundId' };
  if (String(row.refundId) !== String(refundId)) {
    return { ok: false, status: 409, code: 'refresh_refused', message: 'SEP answered for a different refund than the one asked' };
  }
  if (!isRefreshable(row)) {
    return {
      ok: false,
      status: 409,
      code: 'refresh_refused',
      message: 'only an overall Fail with exec code 114 is safe to refresh',
      details: {
        refundStatus: `${row.refundStatusCode}/${row.refundStatusText}`,
        attemptStatus: `${row.attemptStatusCode}/${row.attemptStatusText}`,
      },
    };
  }
  return { ok: true, row };
}

module.exports = { checkRefreshable, isRefreshable };
