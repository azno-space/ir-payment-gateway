const express = require('express');
const router = express.Router();

// Express 4 does not catch a rejected async handler: a bank timeout inside one (e.g. a SEP refund
// SOAP call) became an unhandled rejection that could take the whole service down. Every handler
// goes through this, so the error reaches the app's error handler as a 500 instead.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const {
  createPaymentRequest,
  handlePaymentCallback,
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
} = require('../controllers/payment.controller');
const { createAdminAuth } = require('../utils/adminAuth');

// Every admin route names its scope here: read = look-ups only; money = anything that moves money or
// changes state (a bank verify settles the payment at the bank, so verify-only is money).
const admin = createAdminAuth();

// Initiate a payment — returns { targetUrl, gateway, orderId }
router.post('/', wrap(createPaymentRequest));

// Gateway callbacks (Zibal / Zarinpal / SEP)
router.get('/callback', wrap(handlePaymentCallback));
router.post('/callback', wrap(handlePaymentCallback));

// SEP-specific callback path (some SEP configs redirect here)
router.get('/sep-callback', wrap(handlePaymentCallback));
router.post('/sep-callback', wrap(handlePaymentCallback));


// Admin: verify payment with gateway (read-only, no webhook)
router.get('/admin/verify-only', admin.money, wrap(adminVerifyOnly));

// Admin: error log
router.get('/admin/error-log', admin.read, wrap(adminGetErrorLog));

// Admin: webhook retry queue
router.get('/admin/queue', admin.read, wrap(adminGetQueue));
router.delete('/admin/queue/:id', admin.money, wrap(adminRemoveQueueItem));

// Admin: fetch unverified payments from Zarinpal (paid but callback was missed)
router.get('/admin/zarinpal-unverified', admin.read, wrap(adminZarinpalUnverified));

// Admin: SEP refund APIs
router.post('/admin/sep/refund/reg', admin.money, wrap(adminSepRefundReg));
router.post('/admin/sep/refund/exec', admin.money, wrap(adminSepRefundExec));
router.post('/admin/sep/refund/list', admin.read, wrap(adminSepRefundList));
router.post('/admin/sep/refund/status', admin.read, wrap(adminSepRefundStatus));
router.post('/admin/sep/refund/detail', admin.read, wrap(adminSepRefundDetail));
router.post('/admin/sep/refund/status-by-request-id', admin.read, wrap(adminSepRefundStatusByRequestId));
router.post('/admin/sep/refund/refresh', admin.money, wrap(adminSepRefundRefresh));
router.post('/admin/sep/report', admin.read, wrap(adminSepReport));

module.exports = router;
module.exports.wrap = wrap;
