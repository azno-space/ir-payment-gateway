const express = require('express');
const router = express.Router();
const paymentSession = require('../services/payment-session.service');
const paymentQueue = require('../services/payment-queue.service');

// GET /api/test/health
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      CALLBACK_BASE_URL: process.env.CALLBACK_BASE_URL || '(not set)',
      FRONT_BASE_URL: process.env.FRONT_BASE_URL || '(not set)',
      PAYMENT_SUCCESS_WEBHOOK_URL: process.env.PAYMENT_SUCCESS_WEBHOOK_URL ? '(set)' : '(not set)',
      PAYMENT_FAILURE_WEBHOOK_URL: process.env.PAYMENT_FAILURE_WEBHOOK_URL ? '(set)' : '(not set)',
      ZIBAL_MERCHANT: process.env.ZIBAL_MERCHANT ? '(set)' : '(not set)',
      ZARINPAL_MERCHANT: process.env.ZARINPAL_MERCHANT ? '(set)' : '(not set)',
      SEP_TERMINAL_ID: process.env.SEP_TERMINAL_ID ? '(set)' : '(not set)',
      ADMIN_KEY: process.env.ADMIN_KEY ? '(set)' : '(not set)',
    },
  });
});

// GET /api/test/session/:orderId
router.get('/session/:orderId', (req, res) => {
  const session = paymentSession.get(req.params.orderId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ orderId: req.params.orderId, session });
});

// GET /api/test/queue
router.get('/queue', (req, res) => {
  const items = paymentQueue.getQueue();
  res.json({ count: items.length, items });
});

// DELETE /api/test/queue/:id
router.delete('/queue/:id', (req, res) => {
  paymentQueue.updateItem(req.params.id, { status: 'cancelled' });
  res.json({ ok: true });
});

module.exports = router;
