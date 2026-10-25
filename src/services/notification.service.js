require('dns').setDefaultResultOrder('ipv4first');
const path = require('path');
const crypto = require('crypto');
const alerts = require('../alerts');
const { formatErrorMessage, formatWarningMessage } = require('./paymentAlertText');

const { describeSendError } = alerts;
const env = process.env;

const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
const TELEGRAM_FAILED_BOT_TOKEN = env.TELEGRAM_FAILED_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const TELEGRAM_FAILED_CHAT_ID = env.TELEGRAM_FAILED_CHAT_ID || TELEGRAM_CHAT_ID;
const TELEGRAM_BASE_URL = env.TELEGRAM_BASE_URL || 'https://api.telegram.org';

const BALE_BOT_TOKEN = env.BALE_BOT_TOKEN;
const BALE_FAILED_BOT_TOKEN = env.BALE_FAILED_BOT_TOKEN;
const BALE_FAILED_CHAT_ID = env.BALE_FAILED_CHAT_ID;
// Every error/warning/recovery message goes out through the bot that is a member of the alerts group.
const BALE_ALERT_BOT_TOKEN = BALE_FAILED_BOT_TOKEN || BALE_BOT_TOKEN;

const QUEUE_FILE = env.BALE_ERROR_QUEUE_FILE || path.join(__dirname, '../../data/bale-error-notification-queue.json');
const QUEUE_MAX_AGE_MS = parseInt(env.BALE_ERROR_QUEUE_MAX_AGE_MS || '600000', 10);
const QUEUE_MAX_RETRIES = parseInt(env.BALE_ERROR_QUEUE_MAX_RETRIES || '10', 10);

const queue = alerts.createFileQueue({ file: QUEUE_FILE, writeErrorLabel: '[Notification] Failed to write Bale queue:' });

const RETRY_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'];
const isBaleRetryable = (e) => e.response?.status === 503 || e.response?.status === 502 || RETRY_CODES.includes(e.code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendBaleMessageOnce({ botToken, chatId, message, replyMarkup }) {
  if (!botToken || !chatId || !message) return false;
  const dest = { chatId, url: alerts.baleUrl(botToken) };
  await alerts.withRetry(() => alerts.postMessage('bale', dest, message, { parseMode: 'HTML', replyMarkup }), {
    attempts: 3, isRetryable: isBaleRetryable, sleep, delayMs: (_e, i) => Math.min(1000 * 2 ** (i - 1), 5000),
  });
  return true;
}

// ---- the queue: what to do with each undelivered item
const isFinished = (item) => item.status === 'sent' || item.status === 'failed';

// → { action: 'skip' } | { action: 'fail', reason } | { action: 'send' }
function queueDecision(item, now) {
  const nextMs = Date.parse(item.nextAttemptAt || '');
  const createdMs = Date.parse(item.createdAt || '');
  const isDue = !Number.isNaN(nextMs) && nextMs <= now;
  const isExpired = !Number.isNaN(createdMs) && now - createdMs > QUEUE_MAX_AGE_MS;
  if (!isDue && !isExpired) return { action: 'skip' };
  if (isExpired || item.retryCount >= QUEUE_MAX_RETRIES) return { action: 'fail', reason: isExpired ? 'Expired' : 'Max retries reached' };
  return { action: 'send' };
}

function markFailed(item, reason) {
  item.status = 'failed';
  item.lastAttemptAt = new Date().toISOString();
  item.lastError = reason;
}

async function attemptQueuedSend(item) {
  item.lastAttemptAt = new Date().toISOString();
  try {
    await sendBaleMessageOnce({ botToken: item.botToken, chatId: item.chatId, message: item.message, replyMarkup: item.replyMarkup });
    item.status = 'sent';
    item.sentAt = new Date().toISOString();
    item.lastError = null;
  } catch (err) {
    item.retryCount = (item.retryCount || 0) + 1;
    item.lastError = describeSendError(err);
    item.nextAttemptAt = new Date(Date.now() + Math.min(60000 * 2 ** (item.retryCount - 1), 300000)).toISOString();
  }
}

async function handleItems(items) {
  const now = Date.now();
  let changed = false;
  for (const item of items) {
    if (isFinished(item)) continue;
    const decision = queueDecision(item, now);
    if (decision.action === 'skip') continue;
    if (decision.action === 'fail') markFailed(item, decision.reason);
    else await attemptQueuedSend(item);
    changed = true;
  }
  return changed;
}

const worker = alerts.createQueueWorker({
  queue, handle: handleItems, intervalMs: parseInt(env.BALE_ERROR_QUEUE_INTERVAL_MS || '60000', 10),
});

function queueBaleNotification({ botToken, chatId, message, source, replyMarkup }) {
  if (!botToken || !chatId || !message) return false;
  const nowIso = new Date().toISOString();
  queue.write([...queue.read(), {
    id: crypto.randomUUID(), createdAt: nowIso, nextAttemptAt: nowIso,
    retryCount: 0, lastAttemptAt: null, lastError: null,
    botToken, chatId, message, source: source || 'error',
    ...(replyMarkup && { replyMarkup }),
  }]);
  worker.start();
  return true;
}

worker.start();

// ---- senders
async function sendTelegramNotification({ botToken, chatId, message }) {
  if (!botToken || !chatId) return false;
  try {
    await alerts.postMessage('telegram', { chatId, url: alerts.telegramUrl(botToken, TELEGRAM_BASE_URL) }, message, { parseMode: 'HTML' });
    return true;
  } catch (err) {
    console.error('[Notification] Telegram failed:', describeSendError(err));
    return false;
  }
}

const toTelegram = (message) => setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
const baleReady = () => Boolean(BALE_ALERT_BOT_TOKEN && BALE_FAILED_CHAT_ID);
const baleTarget = (message) => ({ botToken: BALE_ALERT_BOT_TOKEN, chatId: BALE_FAILED_CHAT_ID, message });

// Bale first; if it fails the message goes to the durable queue. Telegram gets a copy either way.
async function sendQueued(message, source) {
  if (!baleReady()) return false;
  let ok = true;
  try {
    await sendBaleMessageOnce(baleTarget(message));
  } catch (err) {
    queueBaleNotification({ ...baleTarget(message), source });
    ok = false;
  }
  toTelegram(message);
  return ok;
}

const sendErrorNotificationToBale = (details) => sendQueued(formatErrorMessage(details), 'error');
const sendFailedPaymentNotificationToBale = (details) => sendQueued(formatErrorMessage(details), 'failed-payment');

// Payment-success messages are switched off (2026-10-13): only errors/warnings are sent. Kept as a no-op so callers stay unchanged.
async function sendPaymentSuccessNotificationToBale() {
  return true;
}

async function sendWarningNotificationToBale(details) {
  const message = formatWarningMessage(details);
  if (baleReady()) {
    try {
      await sendBaleMessageOnce(baleTarget(message));
    } catch (err) {
      console.warn('[Notification] Bale warning notification failed:', describeSendError(err));
    }
  }
  toTelegram(message);
  return true;
}

async function sendBaleRecoveryMessage(message) {
  if (baleReady()) {
    try {
      await sendBaleMessageOnce(baleTarget(message));
    } catch (err) {
      queueBaleNotification({ ...baleTarget(message), source: 'recovery-log' });
    }
  }
  toTelegram(message);
  return true;
}

module.exports = {
  sendErrorNotificationToBale,
  sendFailedPaymentNotificationToBale,
  sendPaymentSuccessNotificationToBale,
  sendWarningNotificationToBale,
  sendBaleRecoveryMessage,
  describeSendError,
};
