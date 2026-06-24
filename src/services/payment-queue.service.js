'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_FILE = process.env.PAYMENT_QUEUE_FILE ||
  path.join(__dirname, '../../data/payment-queue.json');
const MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES || '2880', 10);
const RETRY_INTERVAL_MS = parseInt(process.env.QUEUE_RETRY_INTERVAL_MS || '60000', 10);

class PaymentQueueService {
  constructor() {
    this._workerTimer = null;
    this._processing = false;
    this._ensureDataDir();
  }

  _ensureDataDir() {
    const dir = path.dirname(QUEUE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _readQueue() {
    try {
      if (!fs.existsSync(QUEUE_FILE)) return [];
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || [];
    } catch {
      return [];
    }
  }

  _writeQueue(items) {
    try {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), 'utf8');
    } catch (e) {
      console.error('[PaymentQueue] Write failed:', e.message);
    }
  }

  addToQueue(item) {
    const items = this._readQueue();
    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      retryCount: 0,
      lastAttemptAt: null,
      lastError: null,
      ...item,
    };
    items.push(entry);
    this._writeQueue(items);
    console.log(`[PaymentQueue] Added: id=${entry.id} orderId=${entry.orderId} gateway=${entry.gateway}`);
    return entry;
  }

  getPendingItems() {
    return this._readQueue().filter(
      (i) => i.status === 'pending' && i.retryCount < MAX_RETRIES,
    );
  }

  updateItem(id, updates) {
    const items = this._readQueue();
    const idx = items.findIndex((i) => i.id === id);
    if (idx !== -1) {
      items[idx] = { ...items[idx], ...updates };
      this._writeQueue(items);
    }
  }

  removeItem(id) {
    const items = this._readQueue();
    this._writeQueue(items.filter((i) => i.id !== id));
  }

  getAllItems() {
    return this._readQueue();
  }

  startWorker(processQueueFn) {
    console.log(`[PaymentQueue] Worker started, interval=${RETRY_INTERVAL_MS}ms, maxRetries=${MAX_RETRIES}`);
    this._workerTimer = setInterval(async () => {
      if (this._processing) return;
      this._processing = true;
      try {
        const pending = this.getPendingItems();
        if (pending.length > 0) {
          console.log(`[PaymentQueue] Processing ${pending.length} pending item(s)`);
          for (const item of pending) {
            await processQueueFn(item).catch((e) => {
              console.error(`[PaymentQueue] Error processing item ${item.id}:`, e.message);
            });
          }
        }
      } catch (e) {
        console.error('[PaymentQueue] Worker loop error:', e.message);
      } finally {
        this._processing = false;
      }
    }, RETRY_INTERVAL_MS);
  }

  stopWorker() {
    if (this._workerTimer) {
      clearInterval(this._workerTimer);
      this._workerTimer = null;
    }
  }
}

module.exports = new PaymentQueueService();
