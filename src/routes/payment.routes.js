const express = require('express');
const router = express.Router();
const {
  createPaymentRequest,
  handlePaymentCallback,
  handleSepCallbackDebug,
  adminVerifyOnly,
  adminTriggerWebhook,
  adminGetErrorLog,
  adminGetQueue,
  adminRemoveQueueItem,
  adminZarinpalUnverified,
  adminSepRefundReg,
  adminSepRefundExec,
  adminSepRefundList,
  adminSepRefundStatus,
} = require('../controllers/payment.controller');

// Initiate a payment — returns { targetUrl, gateway, orderId }
router.post('/', createPaymentRequest);

// Gateway callbacks (Zibal / Zarinpal / SEP)
router.get('/callback', handlePaymentCallback);
router.post('/callback', handlePaymentCallback);

// SEP-specific callback path (some SEP configs redirect here)
router.get('/sep-callback', handlePaymentCallback);
router.post('/sep-callback', handlePaymentCallback);

// SEP callback debug endpoint
router.get('/sep-callback-debug', handleSepCallbackDebug);
router.post('/sep-callback-debug', handleSepCallbackDebug);

// Admin: verify payment with gateway (read-only, no webhook)
router.get('/admin/verify-only', adminVerifyOnly);

// Admin: manually trigger success webhook for a completed payment
router.post('/admin/trigger-webhook', adminTriggerWebhook);

// Admin: error log
router.get('/admin/error-log', adminGetErrorLog);

// Admin: webhook retry queue
router.get('/admin/queue', adminGetQueue);
router.delete('/admin/queue/:id', adminRemoveQueueItem);

// Admin: fetch unverified payments from Zarinpal (paid but callback was missed)
router.get('/admin/zarinpal-unverified', adminZarinpalUnverified);

// Admin: SEP refund APIs
router.post('/admin/sep/refund/reg', adminSepRefundReg);
router.post('/admin/sep/refund/exec', adminSepRefundExec);
router.post('/admin/sep/refund/list', adminSepRefundList);
router.post('/admin/sep/refund/status', adminSepRefundStatus);

// Preview error page (development only)
router.get('/preview-error', (req, res) => {
  const { renderErrorPage } = require('../views/error-page');
  res.send(renderErrorPage({
    title: 'خطا در پرداخت',
    message: 'در حین پردازش پرداخت مشکلی رخ داد.',
    technicalDetails: {
      error: 'Sample error for preview',
      gateway: 'zibal',
      code: '123456789',
    },
  }));
});

module.exports = router;
