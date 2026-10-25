'use strict';
// Which bank to use for a payment, the failover chain, and one request attempt per bank.

const {
  ZARINPAL_PAY_BASE,
  ZARINPAL_SANDBOX_PAY_BASE,
  zarinpalSandboxRequestPayment,
  zibalRequestPayment,
  zarinpalRequestPayment,
  sepRequestPayment,
} = require('../services/payment-gateway.service');
const { pick } = require('./callbackParams');

const VALID_GATEWAYS = ['zibal', 'zarinpal', 'zarinpal_sandbox', 'sep'];
const FORCED_GATEWAY = (process.env.FORCED_PAYMENT_GATEWAY || '').toLowerCase().trim();

const PAYMENT_FAILOVER_ENABLED =
  (process.env.PAYMENT_FAILOVER_ENABLED || 'true').toLowerCase().trim() !== 'false';

const FAILOVER_CHAINS = {
  sep: ['sep', 'zarinpal'],
  zarinpal: ['zarinpal'],
  zarinpal_sandbox: ['zarinpal_sandbox'],
  zibal: ['zibal'],
};

const GATEWAY_LAST_TIMEOUT_MS = Number(process.env.GATEWAY_LAST_TIMEOUT_MS) || 15000;
const GATEWAY_LAST_RETRIES = Number(process.env.GATEWAY_LAST_RETRIES) || 2;

function resolveGateway(requestedGateway) {
  if (FORCED_GATEWAY) {
    if (!VALID_GATEWAYS.includes(FORCED_GATEWAY)) {
      console.warn(`Invalid FORCED_PAYMENT_GATEWAY="${FORCED_GATEWAY}"`);
    } else {
      return FORCED_GATEWAY;
    }
  }
  return VALID_GATEWAYS.includes(requestedGateway) ? requestedGateway : 'zarinpal';
}

function buildGatewayChain(primary) {
  if (!PAYMENT_FAILOVER_ENABLED) return [primary];
  return FAILOVER_CHAINS[primary] || [primary];
}

// The first of these fields that is present (null and undefined are absent, 0 is not).
const firstPresent = (obj, ...names) => names.map((name) => obj[name]).find((value) => value != null);

async function attemptZibal(args) {
  const raw = await zibalRequestPayment(args);
  if (raw.result === 100 && raw.trackId) {
    return {
      ok: true, gateway: 'zibal',
      targetUrl: `https://gateway.zibal.ir/start/${raw.trackId}`,
      identifier: raw.trackId, raw,
    };
  }
  return { ok: false, gateway: 'zibal', reason: raw.message || 'Zibal returned non-100 result', raw };
}

async function attemptZarinpal(gateway, args) {
  const isSandbox = gateway === 'zarinpal_sandbox';
  const requestFn = isSandbox ? zarinpalSandboxRequestPayment : zarinpalRequestPayment;
  const payBase = isSandbox ? ZARINPAL_SANDBOX_PAY_BASE : ZARINPAL_PAY_BASE;
  const raw = await requestFn(args);
  if (raw.data && raw.data.code === 100 && raw.data.authority) {
    return {
      ok: true, gateway,
      targetUrl: `${payBase}${raw.data.authority}`,
      identifier: raw.data.authority, raw,
    };
  }
  const reason = raw.data?.message || (raw.errors ? JSON.stringify(raw.errors) : 'Zarinpal returned non-100 code');
  return { ok: false, gateway, reason, raw };
}

async function attemptSep(args) {
  const raw = await sepRequestPayment(args);
  const status = Number(firstPresent(raw, 'Status', 'status', 'result'));
  const token = pick(raw, 'Token', 'token');
  const refNum = pick(raw, 'RefNum', 'refNum', 'refnum');
  if (status === 1 && token) {
    return {
      ok: true, gateway: 'sep',
      targetUrl: `https://sep.shaparak.ir/OnlinePG/SendToken?token=${token}`,
      identifier: refNum || token, raw,
    };
  }
  return { ok: false, gateway: 'sep', reason: pick(raw, 'ErrorDesc', 'errorDesc') || 'SEP returned non-1 status', raw };
}

const ATTEMPTS = {
  zibal: attemptZibal,
  zarinpal: (args) => attemptZarinpal('zarinpal', args),
  zarinpal_sandbox: (args) => attemptZarinpal('zarinpal_sandbox', args),
  sep: attemptSep,
};

// args: { amount, orderId, mobile, timeout, retries }
async function attemptGatewayRequest(gateway, { amount, orderId, mobile, timeout, retries }) {
  if (typeof gateway !== 'string' || !Object.hasOwn(ATTEMPTS, gateway)) return { ok: false, gateway, reason: `Invalid gateway: ${gateway}` };
  return ATTEMPTS[gateway]({ amount, orderId, mobile, timeout, retries });
}

module.exports = {
  VALID_GATEWAYS,
  GATEWAY_LAST_TIMEOUT_MS,
  GATEWAY_LAST_RETRIES,
  resolveGateway,
  buildGatewayChain,
  attemptGatewayRequest,
};
