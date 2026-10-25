'use strict';
// The one error shape of this API: { success: false, error: { code, message? } }. `code` is stable and
// machine-readable; `message` is a short human hint. Never a stack trace or an internal error text.
// `extra` keeps fields an older caller already reads (e.g. verified/verifyResult), next to the error.
function sendError(res, status, code, message, extra) {
  return res.status(status).json({ ...extra, success: false, error: message ? { code, message } : { code } });
}

module.exports = { sendError };
