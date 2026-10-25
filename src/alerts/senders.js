'use strict';
// One POST to a chat platform (Telegram or Bale), a retry loop and the error texts around them.
// Nothing here knows what is being reported or who receives it: callers pass the destination.

const axios = require('axios');
const http = require('http');
const https = require('https');

let sharedAxios;
function defaultHttp() {
  if (!sharedAxios) {
    const o = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 50 };
    sharedAxios = axios.create({ httpAgent: new http.Agent(o), httpsAgent: new https.Agent(o) });
  }
  return sharedAxios;
}

const telegramUrl = (token, base = 'https://api.telegram.org') => `${String(base).replace(/\/$/, '')}/bot${token}/sendMessage`;
const baleUrl = (token) => `https://tapi.bale.ai/bot${token}/sendMessage`;

// The request body for one platform. opts: parseMode, silent (Telegram), noPreview (Telegram),
// button {text,url}, replyMarkup (raw markup object; wins over button).
function buildBody(platform, chatId, text, opts = {}) {
  const body = { chat_id: chatId, text };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  const markup = opts.replyMarkup || (opts.button ? { inline_keyboard: [[opts.button]] } : null);
  if (platform === 'telegram') {
    if (opts.noPreview) body.disable_web_page_preview = true;
    if (opts.silent) body.disable_notification = true;
    if (markup) body.reply_markup = markup;
  } else if (markup) {
    body.reply_markup = JSON.stringify(markup); // Bale wants a JSON string
  }
  return body;
}

// One POST, no retry. `getHttp` is injectable so tests never touch the network.
async function postMessage(platform, dest, text, opts = {}, getHttp = defaultHttp) {
  if (!dest) return false;
  if (!text) throw Object.assign(new Error('alert has no text'), { code: 'EMPTY_ALERT' }); // never "sent": the caller must see it
  await getHttp().post(dest.url, buildBody(platform, dest.chatId, text, opts), { timeout: platform === 'bale' ? 20000 : 10000 });
  return true;
}

// Retries `fn` while the error is retryable, up to `attempts` tries; the last error is thrown.
async function withRetry(fn, { attempts, isRetryable, delayMs, sleep }) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (!isRetryable(err) || i >= attempts) throw err;
      await sleep(delayMs(err, i));
    }
  }
}

// No HTTP answer at all counts as network trouble (retry); 429 and 5xx are retried, other statuses are not.
const isRetryable = (err) => {
  if (err && err.code === 'EMPTY_ALERT') return false;
  const s = err && err.response && err.response.status;
  if (s) return s === 429 || s >= 500;
  return true;
};

// Why a send failed, without the request URL (it carries the bot token).
const platformReason = (d) => (typeof d === 'object' && d ? d.description : undefined);
function describeAlertError(err) {
  const res = (err && err.response) || {};
  const desc = platformReason(res.data);
  const code = (res.data && res.data.error_code) || res.status;
  return desc ? `${err.message} [${code}: ${desc}]` : (err && err.message) || String(err);
}

// Same idea, the older text shape: "message | code | platform reason".
function describeSendError(err) {
  const reason = err?.response?.data?.description;
  return [err?.message, err?.code, reason].filter(Boolean).join(' | ') || String(err);
}

// A blocked bot (403) logs one line per window, not one per message.
const WINDOW_MS = 10 * 60 * 1000;
function createFailureLine() {
  const state = new Map();
  return function failureLine(key, err, now = Date.now()) {
    const text = describeAlertError(err);
    if (!(err && err.response && err.response.status === 403)) return text;
    const st = state.get(key);
    if (st && now - st.last < WINDOW_MS) { st.suppressed++; return null; }
    state.set(key, { last: now, suppressed: 0 });
    return st && st.suppressed ? `${text} (${st.suppressed} similar 403s suppressed in the last window)` : text;
  };
}

module.exports = {
  defaultHttp, telegramUrl, baleUrl, buildBody, postMessage, withRetry, isRetryable,
  describeAlertError, describeSendError, createFailureLine, failureLine: createFailureLine(),
};
