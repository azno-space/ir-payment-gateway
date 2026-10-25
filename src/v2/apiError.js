'use strict';
// The v2 error shape: { error: <short message>, code: <stable machine-readable code> } with a meaningful
// HTTP status. Callers branch on `code`; `error` is for people. Never a stack trace or an internal text.
function sendV2Error(res, status, code, message) {
  return res.status(status).json({ error: message || code.replace(/_/g, ' '), code });
}

module.exports = { sendV2Error };
