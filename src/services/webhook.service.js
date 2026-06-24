'use strict';
const axios = require('axios');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '15000', 10);
const WEBHOOK_MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10);

async function callWebhook(url, payload, { retries = WEBHOOK_MAX_RETRIES } = {}) {
  if (!url) {
    console.warn('[Webhook] No URL configured — skipping webhook call');
    return { ok: false, skipped: true };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) headers['X-Webhook-Secret'] = WEBHOOK_SECRET;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await axios.post(url, payload, {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers,
        validateStatus: () => true,
      });

      if (resp.status >= 200 && resp.status < 300) {
        console.log(`[Webhook] Success — url=${url}, status=${resp.status}, attempt=${attempt}`);
        return { ok: true, status: resp.status, data: resp.data };
      }

      lastError = new Error(`Webhook returned HTTP ${resp.status}`);
      lastError.status = resp.status;
      console.warn(`[Webhook] Non-2xx response — url=${url}, status=${resp.status}, attempt=${attempt}/${retries}`);
    } catch (err) {
      lastError = err;
      console.warn(`[Webhook] Request failed — url=${url}, attempt=${attempt}/${retries}: ${err.message}`);
    }

    if (attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.error(`[Webhook] All retries exhausted — url=${url}: ${lastError?.message}`);
  return { ok: false, error: lastError?.message };
}

module.exports = { callWebhook };
