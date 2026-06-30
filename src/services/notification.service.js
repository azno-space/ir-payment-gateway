require('dns').setDefaultResultOrder('ipv4first');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const agentOptions = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 50 };
const notificationAxios = axios.create({
  httpAgent: new http.Agent(agentOptions),
  httpsAgent: new https.Agent(agentOptions),
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_FAILED_BOT_TOKEN = process.env.TELEGRAM_FAILED_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const TELEGRAM_FAILED_CHAT_ID = process.env.TELEGRAM_FAILED_CHAT_ID || TELEGRAM_CHAT_ID;
const TELEGRAM_BASE_URL = (process.env.TELEGRAM_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');

const BALE_BOT_TOKEN = process.env.BALE_BOT_TOKEN;
const BALE_CHAT_ID = process.env.BALE_CHAT_ID;
const BALE_FAILED_BOT_TOKEN = process.env.BALE_FAILED_BOT_TOKEN;
const BALE_FAILED_CHAT_ID = process.env.BALE_FAILED_CHAT_ID;
const BALE_BASE_URL = 'https://tapi.bale.ai';

const BALE_ERROR_QUEUE_FILE =
  process.env.BALE_ERROR_QUEUE_FILE ||
  path.join(__dirname, '../../data/bale-error-notification-queue.json');
const BALE_ERROR_QUEUE_INTERVAL_MS = parseInt(process.env.BALE_ERROR_QUEUE_INTERVAL_MS || '60000', 10);
const BALE_ERROR_QUEUE_MAX_AGE_MS = parseInt(process.env.BALE_ERROR_QUEUE_MAX_AGE_MS || '600000', 10);
const BALE_ERROR_QUEUE_MAX_RETRIES = parseInt(process.env.BALE_ERROR_QUEUE_MAX_RETRIES || '10', 10);

let baleWorkerStarted = false;
let baleQueueProcessing = false;

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readBaleQueue() {
  try {
    if (!fs.existsSync(BALE_ERROR_QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(BALE_ERROR_QUEUE_FILE, 'utf8')) || [];
  } catch { return []; }
}

function writeBaleQueue(items) {
  try {
    ensureDir(BALE_ERROR_QUEUE_FILE);
    fs.writeFileSync(BALE_ERROR_QUEUE_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (err) {
    console.error('[Notification] Failed to write Bale queue:', err.message);
  }
}

function queueBaleNotification({ botToken, chatId, message, source, replyMarkup }) {
  if (!botToken || !chatId || !message) return false;
  const items = readBaleQueue();
  items.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    nextAttemptAt: new Date().toISOString(),
    retryCount: 0, lastAttemptAt: null, lastError: null,
    botToken, chatId, message, source: source || 'error',
    ...(replyMarkup && { replyMarkup }),
  });
  writeBaleQueue(items);
  startBaleWorker();
  return true;
}

async function sendBaleMessageOnce({ botToken, chatId, message, replyMarkup }) {
  if (!botToken || !chatId || !message) return false;
  const body = { chat_id: chatId, text: message, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
  await retryBaleRequest(async () =>
    notificationAxios.post(`${BALE_BASE_URL}/bot${botToken}/sendMessage`, body, { timeout: 20000 }),
  );
  return true;
}

async function processBaleQueue() {
  if (baleQueueProcessing) return;
  baleQueueProcessing = true;
  try {
    const items = readBaleQueue();
    if (!items.length) return;
    const now = Date.now();
    let changed = false;
    for (const item of items) {
      if (item.status === 'sent' || item.status === 'failed') continue;
      const nextMs = Date.parse(item.nextAttemptAt || '');
      const createdMs = Date.parse(item.createdAt || '');
      const isDue = !Number.isNaN(nextMs) && nextMs <= now;
      const isExpired = !Number.isNaN(createdMs) && now - createdMs > BALE_ERROR_QUEUE_MAX_AGE_MS;
      if (!isDue && !isExpired) continue;
      if (isExpired || item.retryCount >= BALE_ERROR_QUEUE_MAX_RETRIES) {
        item.status = 'failed';
        item.lastAttemptAt = new Date().toISOString();
        item.lastError = isExpired ? 'Expired' : 'Max retries reached';
        changed = true;
        continue;
      }
      item.lastAttemptAt = new Date().toISOString();
      try {
        await sendBaleMessageOnce({ botToken: item.botToken, chatId: item.chatId, message: item.message, replyMarkup: item.replyMarkup });
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        item.lastError = null;
        changed = true;
      } catch (err) {
        item.retryCount = (item.retryCount || 0) + 1;
        item.lastError = err.message;
        const delay = Math.min(60000 * Math.pow(2, item.retryCount - 1), 300000);
        item.nextAttemptAt = new Date(Date.now() + delay).toISOString();
        changed = true;
      }
    }
    if (changed) writeBaleQueue(items);
  } finally {
    baleQueueProcessing = false;
  }
}

function startBaleWorker() {
  if (baleWorkerStarted) return;
  baleWorkerStarted = true;
  processBaleQueue().catch(() => {});
  const timer = setInterval(() => processBaleQueue().catch(() => {}), BALE_ERROR_QUEUE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

startBaleWorker();

async function retryBaleRequest(requestFn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      const isRetryable =
        error.response?.status === 503 || error.response?.status === 502 ||
        ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code);
      if (!isRetryable || attempt === maxRetries) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function sanitizeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 2000);
}

function formatErrorMessage({ title, message, gateway, code, orderId, paymentId, error }) {
  let text = `<b>🔴 ${title || 'خطا در سیستم پرداخت'}</b>\n\n`;
  text += `<b>پیام:</b>\n${message || 'بدون توضیح'}\n\n`;
  if (gateway && code) {
    text += `<b>📊 اطلاعات پرداخت:</b>\n`;
    text += `• درگاه: <code>${gateway}</code>\n`;
    text += `• کد: <code>${code}</code>\n`;
    if (paymentId) text += `• شناسه پرداخت: <code>${paymentId}</code>\n`;
    if (orderId) text += `• شناسه سفارش: <code>${orderId}</code>\n\n`;
  }
  if (error) text += `<b>⚙️ جزئیات فنی:</b>\n<pre>${sanitizeHtml(error)}</pre>\n`;
  text += `<b>⏰ زمان:</b> ${new Date().toISOString()}\n`;
  return text;
}

function formatSuccessMessage({ gateway, code, orderId }) {
  let text = `<b>🟢 پرداخت موفق</b>\n\n`;
  text += `• درگاه: <code>${gateway || '-'}</code>\n`;
  text += `• کد: <code>${code || '-'}</code>\n`;
  if (orderId) text += `• شناسه سفارش: <code>${orderId}</code>\n`;
  text += `\n<b>⏰ زمان:</b> ${new Date().toISOString()}\n`;
  return text;
}

function formatWarningMessage({ title, gateway, code, orderId, cancelReason, sepState, sepStatus, gatewayErrorDesc }) {
  let text = `<b>⚠️ ${title || 'اطلاع‌رسانی پرداخت'}</b>\n\n`;
  text += `<b>علت:</b> ${sanitizeHtml(cancelReason || 'نامشخص')}\n`;
  if (gatewayErrorDesc && gatewayErrorDesc !== cancelReason)
    text += `<b>شرح خطا:</b> ${sanitizeHtml(gatewayErrorDesc)}\n`;
  if (sepState) text += `• State: <code>${sanitizeHtml(String(sepState))}</code>\n`;
  if (sepStatus) text += `• Status: <code>${sanitizeHtml(String(sepStatus))}</code>\n`;
  if (gateway) {
    text += `\n<b>📊 تراکنش:</b>\n• درگاه: <code>${gateway}</code>\n`;
    if (code) text += `• RefNum: <code>${code}</code>\n`;
    if (orderId) text += `• سفارش: <code>${orderId}</code>\n`;
  }
  text += `\n<b>⏰ زمان:</b> ${new Date().toISOString()}\n`;
  return text;
}

async function sendTelegramNotification({ botToken, chatId, message }) {
  if (!botToken || !chatId) return false;
  try {
    await notificationAxios.post(
      `${TELEGRAM_BASE_URL}/bot${botToken}/sendMessage`,
      { chat_id: chatId, text: message, parse_mode: 'HTML' },
      { timeout: 10000 },
    );
    return true;
  } catch (err) {
    console.error('[Notification] Telegram failed:', err.message);
    return false;
  }
}

async function sendErrorNotificationToBale(errorDetails) {
  if (!BALE_BOT_TOKEN || !BALE_FAILED_CHAT_ID) return false;
  const message = formatErrorMessage(errorDetails);
  try {
    await sendBaleMessageOnce({ botToken: BALE_BOT_TOKEN, chatId: BALE_FAILED_CHAT_ID, message });
    setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
    return true;
  } catch (err) {
    queueBaleNotification({ botToken: BALE_BOT_TOKEN, chatId: BALE_FAILED_CHAT_ID, message, source: 'error' });
    setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
    return false;
  }
}

async function sendFailedPaymentNotificationToBale(errorDetails) {
  const botToken = BALE_FAILED_BOT_TOKEN || BALE_BOT_TOKEN;
  const chatId = BALE_FAILED_CHAT_ID;
  if (!botToken || !chatId) return false;
  const message = formatErrorMessage(errorDetails);
  try {
    await sendBaleMessageOnce({ botToken, chatId, message });
    setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
    return true;
  } catch (err) {
    queueBaleNotification({ botToken, chatId, message, source: 'failed-payment' });
    setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
    return false;
  }
}

async function sendPaymentSuccessNotificationToBale(details) {
  const message = formatSuccessMessage(details);
  if (BALE_BOT_TOKEN && BALE_CHAT_ID) {
    try {
      await retryBaleRequest(async () =>
        notificationAxios.post(
          `${BALE_BASE_URL}/bot${BALE_BOT_TOKEN}/sendMessage`,
          { chat_id: BALE_CHAT_ID, text: message, parse_mode: 'HTML' },
          { timeout: 20000 },
        ),
      );
    } catch (err) {
      console.error('[Notification] Bale success notification failed:', err.message);
    }
  }
  setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID, message }));
  return true;
}

async function sendWarningNotificationToBale(details) {
  const message = formatWarningMessage(details);
  if (BALE_BOT_TOKEN && BALE_FAILED_CHAT_ID) {
    try {
      await sendBaleMessageOnce({ botToken: BALE_BOT_TOKEN, chatId: BALE_FAILED_CHAT_ID, message });
    } catch (err) {
      console.warn('[Notification] Bale warning notification failed:', err.message);
    }
  }
  setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
  return true;
}

async function sendBaleRecoveryMessage(message) {
  const botToken = BALE_FAILED_BOT_TOKEN || BALE_BOT_TOKEN;
  const chatId = BALE_FAILED_CHAT_ID;
  if (botToken && chatId) {
    try {
      await sendBaleMessageOnce({ botToken, chatId, message });
    } catch (err) {
      queueBaleNotification({ botToken, chatId, message, source: 'recovery-log' });
    }
  }
  setImmediate(() => sendTelegramNotification({ botToken: TELEGRAM_FAILED_BOT_TOKEN, chatId: TELEGRAM_FAILED_CHAT_ID, message }));
  return true;
}

module.exports = {
  sendErrorNotificationToBale,
  sendFailedPaymentNotificationToBale,
  sendPaymentSuccessNotificationToBale,
  sendWarningNotificationToBale,
  sendBaleRecoveryMessage,
};
