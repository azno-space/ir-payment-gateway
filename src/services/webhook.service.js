'use strict';
const axios = require('axios');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '15000', 10);
const WEBHOOK_MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10);

// log origin+path only: webhook URLs may carry secrets in the query string
const safeUrl = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return 'invalid-url'; } };

// A webhook setting may list several addresses, comma-separated, tried in order — e.g. the merchant's
// internal docker address first (no DNS lookup) and its public one second. The next address is
// tried only when the request never reached the previous one; any HTTP answer is that attempt's
// answer.
const { neverReached } = require('../utils/reach');
const webhookUrls = (u) => String(u || '').split(',').map((x) => x.trim()).filter(Boolean);

async function postFirstReachable(urls, payload, opts) {
  let lastErr;
  for (const u of urls) {
    try {
      return { url: u, resp: await axios.post(u, payload, opts) };
    } catch (err) {
      lastErr = err;
      if (!neverReached(err)) break;
      console.warn(`[Webhook] ${safeUrl(u)} not reached (${err.code}) — trying the next address`);
    }
  }
  throw lastErr;
}

function webhookHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) headers['X-Webhook-Secret'] = WEBHOOK_SECRET;
  return headers;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => Math.min(1000 * Math.pow(2, attempt - 1), 8000);

// One try at the receiver → { ok: true, status, data } or { error } (the failure, to be retried).
async function tryOnce(urls, payload, headers, attempt, retries) {
  const url = urls[0]; // for log lines
  try {
    const { url: hit, resp } = await postFirstReachable(urls, payload, {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300) {
      console.log(`[Webhook] Success — url=${safeUrl(hit)}, status=${resp.status}, attempt=${attempt}`);
      return { ok: true, status: resp.status, data: resp.data };
    }

    const error = new Error(`Webhook returned HTTP ${resp.status}`);
    error.status = resp.status;
    console.warn(`[Webhook] Non-200 response — url=${safeUrl(url)}, status=${resp.status}, attempt=${attempt}/${retries}`);
    return { error };
  } catch (err) {
    console.warn(`[Webhook] Request failed — url=${safeUrl(url)}, attempt=${attempt}/${retries}: ${err.message}`);
    return { error: err };
  }
}

async function callWebhook(urlSetting, payload, { retries = WEBHOOK_MAX_RETRIES } = {}) {
  const urls = webhookUrls(urlSetting);
  if (!urls.length) {
    console.warn('[Webhook] No URL configured — skipping webhook call');
    return { ok: false, skipped: true };
  }

  const headers = webhookHeaders();
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await tryOnce(urls, payload, headers, attempt, retries);
    if (result.ok) return result;
    lastError = result.error;
    if (attempt < retries) await sleep(backoffMs(attempt));
  }

  console.error(`[Webhook] All retries exhausted — url=${safeUrl(urls[0])}: ${lastError?.message}`);
  return { ok: false, error: lastError?.message };
}

// An extension mounted in this process (GATEWAY_EXTENSION) may take verified successes and failures
// directly instead of over HTTP to itself: one hop less that can fail, and a failure inside it lands
// in the retry queue (success) instead of being answered 200. PAYMENT_SUCCESS_IN_PROCESS=false goes
// back to the webhook URLs for both (rollback without a code change). Without a registered handler
// nothing changes.
let successHandler = null;
let failureHandler = null;
const asHandler = (fn) => (typeof fn === 'function' ? fn : null);
function setSuccessHandler(fn) { successHandler = asHandler(fn); }
function setFailureHandler(fn) { failureHandler = asHandler(fn); }
const takenInProcess = (handler) => Boolean(handler) && process.env.PAYMENT_SUCCESS_IN_PROCESS !== 'false';
const successInProcess = () => takenInProcess(successHandler);

// Hand a verified success to the receiver: in-process when an extension took it, else the webhook URL.
async function deliverSuccess(urlSetting, payload, opts) {
  if (!successInProcess()) return callWebhook(urlSetting, payload, opts);
  try {
    // A handler may answer 'pending' (took the payment, not finished: the guest is told so) or
    // 'refused' (the order cannot be booked and the receiver refunds it).
    const outcome = await successHandler(payload);
    return { ok: true, inProcess: true, pending: outcome === 'pending', refused: outcome === 'refused' };
  } catch (err) {
    console.error(`[Webhook] in-process success handler failed — orderId=${payload.orderId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Same for a failure. Like the HTTP path it is one try with no queue: a handler that throws is the
// receiver answering 400, and the caller ignores the result.
async function deliverFailure(urlSetting, payload, opts) {
  if (!takenInProcess(failureHandler)) return callWebhook(urlSetting, payload, opts);
  try {
    await failureHandler(payload);
    return { ok: true, inProcess: true };
  } catch (err) {
    console.warn(`[Webhook] in-process failure handler refused — orderId=${payload.orderId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function pingWebhook(urlSetting) {
  if (successInProcess()) return { ok: true, inProcess: true };
  const urls = webhookUrls(urlSetting);
  const url = urls[0];
  if (!urls.length) return { ok: true, skipped: true };

  try {
    const { resp } = await postFirstReachable(
      urls,
      { type: 'ping', timestamp: new Date().toISOString() },
      { timeout: 5000, headers: webhookHeaders(), validateStatus: () => true },
    );
    const ok = resp.status >= 200 && resp.status < 300;
    console.log(`[Webhook] Ping ${ok ? 'OK' : 'FAILED'} — url=${safeUrl(url)}, status=${resp.status}`);
    return { ok, status: resp.status };
  } catch (err) {
    console.warn(`[Webhook] Ping failed — url=${safeUrl(url)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { callWebhook, pingWebhook, webhookUrls, deliverSuccess, setSuccessHandler, deliverFailure, setFailureHandler };
