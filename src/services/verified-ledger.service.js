'use strict';
// Which bank payments have already been verified and handed to the receiver. A bank callback can arrive
// twice (a reload, a replayed link, a bank retry); without this the second one verifies again and sends
// the receiver and the alert channel the same success twice. Used only when CALLBACK_REPLAY_GUARD=true.
//
// A payment is first "claimed" by the callback that verified it, then settled as pending / done / refused
// once the hand-over to the receiver has an answer. A claim that never gets settled (the process died
// between verify and hand-over) goes stale after STALE_CLAIM_MS and the next callback processes the payment
// again, exactly as it would without the guard: the guard must never be the reason a paid order is not
// handed over.
// ponytail: one process, one file read and written whole on each call; fine for the volume of one gateway.
const path = require('path');
const { readJson, writeJson } = require('../utils/atomicJson');

const FILE = process.env.VERIFIED_LEDGER_FILE || path.join(__dirname, '../../data/verified-payments.json');
const ttl = parseInt(process.env.VERIFIED_LEDGER_TTL_MS, 10);
const TTL_MS = Number.isFinite(ttl) && ttl > 0 ? ttl : 30 * 86400000; // 30 days
const STALE_CLAIM_MS = 120000; // well past the receiver wait (8 s) and a slow bank

const keyOf = (gateway, code) => `${gateway}:${code}`;
const isStaleClaim = (entry, now) => entry.outcome === 'claimed' && now - entry.at > STALE_CLAIM_MS;

function load(now) {
  const data = readJson(FILE, 'VerifiedLedger');
  // An entry that is not an object, or has no usable time, is junk: drop it rather than throw on it.
  for (const [k, v] of Object.entries(data)) if (!v || typeof v !== 'object' || !(now - v.at <= TTL_MS)) delete data[k];
  return data;
}

// → { outcome, orderId } when this payment was already taken, else null.
// outcome: 'claimed' (being handed over now) | 'pending' | 'done' | 'refused'
function seen(gateway, code) {
  const now = Date.now();
  const entry = load(now)[keyOf(gateway, code)];
  if (!entry || isStaleClaim(entry, now)) return null;
  return { outcome: entry.outcome, orderId: entry.orderId || '' };
}

// Takes the payment for this callback. → { claimed: false } when another callback already holds it;
// { claimed: true, stored } otherwise, stored=false when the ledger file could not be written (the
// caller must make that loud: a replay would not be caught).
// takeOverPending: the caller is the re-callback recovery path (retry=true), which may take a payment
// whose hand-over was only queued ('pending') — if that queue item died, nothing else would ever hand
// it over. A payment that is done or refused is never taken over.
function claim(gateway, code, orderId, { takeOverPending = false } = {}) {
  const now = Date.now();
  const data = load(now);
  const key = keyOf(gateway, code);
  const held = Object.hasOwn(data, key) && !isStaleClaim(data[key], now);
  if (held && !(takeOverPending && data[key].outcome === 'pending')) return { claimed: false };
  data[key] = { at: now, outcome: 'claimed', orderId: orderId || '' };
  return { claimed: true, stored: writeJson(FILE, data, 'VerifiedLedger') };
}

function settle(gateway, code, outcome) {
  const data = load(Date.now());
  const key = keyOf(gateway, code);
  if (!Object.hasOwn(data, key)) return;
  data[key].outcome = outcome;
  writeJson(FILE, data, 'VerifiedLedger');
}

// The hand-over threw: forget the claim so the next callback processes the payment.
function release(gateway, code) {
  const data = load(Date.now());
  const key = keyOf(gateway, code);
  if (!Object.hasOwn(data, key)) return;
  delete data[key];
  writeJson(FILE, data, 'VerifiedLedger');
}

module.exports = { seen, claim, settle, release, TTL_MS, STALE_CLAIM_MS };
