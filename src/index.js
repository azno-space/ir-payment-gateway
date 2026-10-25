const envFile = `.env.${process.env.NODE_ENV || 'development'}`;
require('dotenv').config({ path: envFile });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const requestLog = require('./utils/requestLog');
const { sendError } = require('./utils/apiError');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(requestLog());
// API v2 beside v1 (src/v2/openapi.json). Off unless switched on; v1 is untouched either way. It is
// mounted before GATEWAY_EXTENSION, so an extension never wraps /api/v2 (it only adds routes under v1).
if (process.env.API_V2_ENABLED === 'true') {
  app.use('/api/v2', require('./v2/routes'));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Optional extension: GATEWAY_EXTENSION names a module that is called with the Express app before the
// built-in routes, to add your own routes or background work (e.g. confirming orders in your system).
// Unset = the gateway alone.
if (process.env.GATEWAY_EXTENSION) {
  require(require('path').resolve(process.env.GATEWAY_EXTENSION))(app);
}

const paymentRoutes = require('./routes/payment.routes');
const { processQueuedWebhook } = require('./controllers/payment.controller');
const paymentQueue = require('./services/payment-queue.service');

app.use('/api/payments', paymentRoutes);

// Debug routes (session amounts, queue items): only on a laptop, never on a deployed host — dev
// runs NODE_ENV=development and is reachable from the internet.
if (process.env.ENABLE_TEST_ROUTES === 'true') {
  app.use('/api/test', require('./routes/test.routes'));
}

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

app.use((req, res) => sendError(res, 404, 'not_found'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  // no internals or stack in replies: a client error keeps its own short message (e.g. bad JSON)
  return status < 500 ? sendError(res, status, 'bad_request', err.expose ? err.message : undefined) : sendError(res, 500, 'internal_error');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  if (!process.env.PAYMENT_CREATE_SECRET) {
    console.warn('[Config] PAYMENT_CREATE_SECRET is not set: anyone who can reach this service can start a payment for any order and amount.');
  }
});

paymentQueue.startWorker(processQueuedWebhook);
