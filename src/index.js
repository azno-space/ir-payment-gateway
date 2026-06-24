require('dotenv').config();
const { patchConsole } = require('./utils/fileLogger');
patchConsole();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const paymentRoutes = require('./routes/payment.routes');
const { processQueuedWebhook } = require('./controllers/payment.controller');
const paymentQueue = require('./services/payment-queue.service');

app.use('/api/payments', paymentRoutes);

if (process.env.NODE_ENV !== 'production') {
  app.use('/api/test', require('./routes/test.routes'));
}

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

paymentQueue.startWorker(processQueuedWebhook);
