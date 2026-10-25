'use strict';
// A JSON file that holds undelivered alerts, plus the worker that retries them and a small
// "same alert within a window" filter. The per-item rules (when to retry, when to give up) stay
// with the caller: `handle` gets the items and returns true when it changed any of them.

const fs = require('fs');
const path = require('path');

function createFileQueue({ file, writeErrorLabel = '[Alerts] cannot write queue file:' }) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch { return []; }
  };
  const write = (items) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
    } catch (err) { console.error(writeErrorLabel, err.message); }
  };
  return { read, write };
}

// `persist(items)` picks what is written back (default: everything).
function createQueueWorker({ queue, handle, persist = (items) => items, intervalMs = 60000, onError = () => {} }) {
  let processing = false;
  let started = false;
  async function processOnce() {
    if (processing) return;
    processing = true;
    try {
      const items = queue.read();
      if (!items.length) return;
      if (await handle(items)) queue.write(persist(items));
    } finally { processing = false; }
  }
  function start() {
    if (started) return;
    started = true;
    const run = () => processOnce().catch(onError);
    run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return { processOnce, start };
}

// seen(key, windowMs) is true when the key was already accepted within the window; otherwise it records the key.
function createDedupe({ now = Date.now, cap = 2000, keepMs = 6 * 3600 * 1000 } = {}) {
  const last = new Map();
  function seen(key, windowMs) {
    const t = now();
    const prev = last.get(key);
    if (prev !== undefined && t - prev < windowMs) return true;
    last.set(key, t);
    if (last.size > cap) for (const [k, v] of last) if (t - v > keepMs) last.delete(k);
    return false;
  }
  return { seen, _last: last };
}

module.exports = { createFileQueue, createQueueWorker, createDedupe };
