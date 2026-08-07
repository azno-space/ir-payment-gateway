'use strict';
const axios = require('axios');
const crypto = require('crypto');

// Forwards caught payment failures to the Self-Healing Agent's sensor webhook
// (see /Users/sy313/projects/shahriyari/self-healing-agent). This repo is
// registered there as failing_service "payment-gateway" with toolchain: null,
// so the agent is alert-only for this service — it will never attempt a
// code-fix here until that's flipped on deliberately from the agent side.

const FAILING_SERVICE = 'payment-gateway';
const FORWARD_TIMEOUT_MS = 30000;
const DEDUPE_WINDOW_MS = 30000;

const NETWORK_ERROR_PATTERN = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ECONNABORTED|network error/i;

const recentReports = new Map();

// Local throttle so a failure loop can't flood the sensor (agent also dedupes server-side).
function isDuplicate(key, now) {
  const last = recentReports.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentReports.set(key, now);
  if (recentReports.size > 200) {
    recentReports.forEach((t, k) => {
      if (now - t > DEDUPE_WINDOW_MS) recentReports.delete(k);
    });
  }
  return false;
}

// notifyBaleFailure()'s errorDetails carries no httpStatus/err.code in this repo
// (see payment.controller.js) — the only reliable signals are the message text
// and the `stage` marker added at each call site, so classification leans on those.
function inferErrorCode(details, text) {
  if (NETWORK_ERROR_PATTERN.test(text)) {
    // Messages matching this pattern ("Zibal verify network error: ...",
    // "Zarinpal verify network error: ...") are only produced after
    // payment-gateway.service.js's internal retry() has already exhausted its attempts.
    return 'NETWORK_EXHAUSTED';
  }
  if (details.stage === 'callback_missing_params' || details.stage === 'session_not_found') {
    return 'VALIDATION_ERROR';
  }
  if (details.stage === 'verify_failed') {
    return 'HTTP_ERROR';
  }
  return 'UNKNOWN';
}

function buildCategory(details) {
  return details.stage || (details.gateway ? `gateway_${String(details.gateway).toLowerCase()}` : 'unhandled');
}

// Only known-safe, non-PII identifiers — never verifyResult/error wholesale,
// since gateway verify payloads can carry masked card numbers (card_pan,
// cardNumber, SecurePan) or phone numbers.
function buildContext(details) {
  const context = {};
  if (details.orderId) context.orderId = String(details.orderId);
  if (details.gateway) context.gateway = String(details.gateway);
  if (details.code) context.code = String(details.code);
  if (details.stage) context.stage = String(details.stage);
  return context;
}

// Fire-and-forget: reports a payment failure to the Self-Healing Agent.
// Never throws, is not awaited by callers, and safely no-ops if
// AGENT_SENSOR_URL / AGENT_SENSOR_HMAC_SECRET aren't configured.
function forwardErrorToAgent(errorDetails) {
  try {
    const sensorUrl = process.env.AGENT_SENSOR_URL;
    const secret = process.env.AGENT_SENSOR_HMAC_SECRET;
    if (!sensorUrl || !secret) return;

    const details = errorDetails || {};
    const errorMessage = String(details.message || details.title || 'Unknown payment error');
    const errorCode = inferErrorCode(details, errorMessage);
    const errorType = `payment-gateway.${buildCategory(details)}`;

    const now = Date.now();
    const dedupeKey = `${errorType}|${errorCode}|${details.orderId || ''}|${errorMessage}`;
    if (isDuplicate(dedupeKey, now)) return;

    const payload = {
      errorType,
      errorCode,
      // httpStatus intentionally omitted: this repo's notifyBaleFailure() errorDetails
      // never carries an HTTP status code, so it's always undefined per the contract.
      failing_service: FAILING_SERVICE,
      errorMessage,
      context: buildContext(details),
      observedAt: new Date(now).toISOString(),
    };

    // Serialized once and reused verbatim for both the signature and the request
    // body — re-serializing (or letting axios do it) could reorder keys and
    // break the agent's raw-body HMAC check.
    const body = JSON.stringify({ source: FAILING_SERVICE, payload });
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    axios
      .post(sensorUrl, body, {
        timeout: FORWARD_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Sensor-Service': FAILING_SERVICE,
          'X-Agent-Sensor-Signature': signature,
        },
        transformRequest: [(data) => data],
      })
      .catch((err) => {
        console.error('[agentSensor] failed to forward error to agent:', err.message);
      });
  } catch (err) {
    console.error('[agentSensor] unexpected error while forwarding:', err.message);
  }
}

module.exports = { forwardErrorToAgent };
