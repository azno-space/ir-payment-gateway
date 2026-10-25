'use strict';
// Verified payments the success receiver has not taken yet. It must never lose one: a write goes to a
// temp file and is renamed (a full disk cannot truncate the queue), a failed write alerts and keeps the
// item in memory until the disk takes it, a corrupt file is moved aside for a human instead of being
// read as empty, retries back off, and an item that keeps failing ends in a visible dead state with an
// alert rather than expiring silently.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendErrorNotificationToBale } = require('./notification.service');
const { writeJsonAtomic, assertRoom, cutError } = require('../utils/queueFile');

const QUEUE_FILE = process.env.PAYMENT_QUEUE_FILE ||
  path.join(__dirname, '../../data/payment-queue.json');
const MAX_ITEMS = parseInt(process.env.QUEUE_MAX_ITEMS || '2000', 10);
const MAX_ATTEMPTS = parseInt(process.env.QUEUE_MAX_ATTEMPTS || '8', 10);
const POLL_MS = parseInt(process.env.QUEUE_RETRY_INTERVAL_MS || '60000', 10);
const HOLD_RETRY_MS = parseInt(process.env.QUEUE_HOLD_RETRY_MS || '5000', 10);
const BACKOFF_MIN = [1, 5, 15, 30, 60, 120, 360, 1440]; // minutes after attempt n (last value repeats)

const alert = (details) => { sendErrorNotificationToBale({ title: 'صف وب‌هوک پرداخت', ...details }).catch(() => {}); };
const forAlert = (i) => ({ orderId: i.orderId, gateway: i.gateway, code: i.code, amount: i.verifyDetails?.charged_rial });

// ponytail: held items live in memory only — a restart while the disk is still full loses them; the
// queue_write_failed alert (order, ref, amount) is the safety net for that case.
let held = [];
let holdTimer = null;
let holdDelay = HOLD_RETRY_MS;
let workerTimer = null;
let processing = false;

function readQueue() {
  let raw;
  try { raw = fs.readFileSync(QUEUE_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try {
    const items = JSON.parse(raw);
    if (Array.isArray(items)) return items;
  } catch { /* corrupt: moved aside below */ }
  const aside = `${QUEUE_FILE}.corrupt-${Date.now()}`;
  fs.renameSync(QUEUE_FILE, aside);
  console.error(`[PaymentQueue] unreadable queue file moved aside to ${aside} — check it by hand`);
  alert({ stage: 'queue_file_corrupt', message: `فایل صف خراب بود و کنار گذاشته شد: ${aside}` });
  return [];
}

const writeQueue = (items) => writeJsonAtomic(QUEUE_FILE, items);

const live = (items) => items.filter((i) => i.status !== 'dead').length; // dead items wait for a human and do not use the cap

// Every change goes through here: read, change, write. Held items ride along on the next good write
// only while they fit under the cap (hard cap); otherwise they stay held and the change applies to them in memory.
function mutate(fn) {
  const items = readQueue();
  const extra = held.filter((h) => !items.some((i) => i.id === h.id));
  if (live(items) + live(extra) > MAX_ITEMS) {
    writeQueue(fn(items).map(({ held: _h, ...i }) => i));
    held = fn(held);
    return items;
  }
  const next = fn(items.concat(extra));
  writeQueue(next.map(({ held: _h, ...i }) => i));
  held = [];
  return next;
}

function flushHeld() {
  holdTimer = null;
  if (!held.length) return;
  try {
    assertRoom(live(readQueue()) + live(held), MAX_ITEMS);
    mutate((items) => items);
    holdDelay = HOLD_RETRY_MS;
    console.warn('[PaymentQueue] held items written to disk');
  } catch (e) {
    holdDelay = Math.min(holdDelay * 2, 5 * 60_000);
    console.error(`[PaymentQueue] held items still not written (${held.length}), retry in ${holdDelay}ms: ${e.message}`);
    holdTimer = setTimeout(flushHeld, holdDelay);
    holdTimer.unref?.();
  }
}

function addToQueue(item) {
  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
    lastAttemptAt: null,
    nextRetryAt: new Date().toISOString(),
    lastError: null,
    ...item,
  };
  try {
    assertRoom(live(readQueue()) + live(held) + 1, MAX_ITEMS); // over the cap the item is held in memory and alerted, never dropped
    mutate((items) => [...items, entry]);
    console.log(`[PaymentQueue] Added: id=${entry.id} orderId=${entry.orderId} gateway=${entry.gateway}`);
  } catch (e) {
    held.push({ ...entry, held: true });
    console.error(`[PaymentQueue] write failed — item held in memory, retrying: orderId=${entry.orderId} ${e.message}`);
    alert({ stage: 'queue_write_failed', ...forAlert(entry), message: e.message });
    if (!holdTimer) { holdTimer = setTimeout(flushHeld, holdDelay); holdTimer.unref?.(); }
  }
  return entry;
}

function getAllItems() {
  let items = [];
  try { items = readQueue(); } catch (e) { console.error('[PaymentQueue] queue file unreadable:', e.message); }
  return items.concat(held.filter((h) => !items.some((i) => i.id === h.id)));
}

const pendingCount = () => getAllItems().filter((i) => i.status === 'pending').length;
const deadCount = () => getAllItems().filter((i) => i.status === 'dead').length;

function updateItem(id, updates) {
  mutate((items) => items.map((i) => (i.id === id ? { ...i, ...updates } : i)));
}

function removeItem(id) {
  mutate((items) => items.filter((i) => i.id !== id));
}

// One pass: deliver every due pending item. deliver(item) resolves = taken (item removed), throws =
// retry later; after MAX_ATTEMPTS failures the item is dead and alerted (an admin decides by hand and
// deletes it). Items left by the old queue (no nextRetryAt) are due at once — except those the old
// queue had already given up on: delivering a days-old payment again could act on an order someone
// already settled by hand, so they are marked dead and alerted instead.
async function runPass(deliver) {
  const now = Date.now();
  const due = getAllItems().filter((i) => i.status === 'pending' && new Date(i.nextRetryAt || 0).getTime() <= now);
  for (const item of due) {
    if (!item.nextRetryAt && (item.retryCount || 0) >= MAX_ATTEMPTS) {
      updateItem(item.id, { status: 'dead', lastError: 'expired in the old queue; decide by hand' });
      alert({ stage: 'queue_item_dead', ...forAlert(item), message: 'old queue item past its retries — not delivered again' });
      continue;
    }
    try {
      await deliver(item);
      removeItem(item.id);
    } catch (e) {
      const retryCount = (item.retryCount || 0) + 1;
      const dead = retryCount >= MAX_ATTEMPTS;
      const wait = BACKOFF_MIN[Math.min(retryCount - 1, BACKOFF_MIN.length - 1)] * 60_000;
      updateItem(item.id, {
        retryCount,
        lastAttemptAt: new Date().toISOString(),
        lastError: cutError(e.message),
        status: dead ? 'dead' : 'pending',
        nextRetryAt: new Date(Date.now() + wait).toISOString(),
      });
      if (dead) {
        console.error(`[PaymentQueue] item dead after ${retryCount} attempts: id=${item.id} orderId=${item.orderId}`);
        alert({ stage: 'queue_item_dead', ...forAlert(item), message: e.message });
      }
    }
  }
}

function startWorker(deliver) {
  console.log(`[PaymentQueue] Worker started, interval=${POLL_MS}ms, maxAttempts=${MAX_ATTEMPTS}`);
  workerTimer = setInterval(async () => {
    if (processing) return;
    processing = true;
    try { await runPass(deliver); } catch (e) { console.error('[PaymentQueue] pass failed:', e.message); } finally { processing = false; }
  }, POLL_MS);
}

function stopWorker() {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
}

module.exports = { addToQueue, getAllItems, pendingCount, deadCount, updateItem, removeItem, runPass, startWorker, stopWorker };
