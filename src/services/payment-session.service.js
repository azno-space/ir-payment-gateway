'use strict';
const fs = require('fs');
const path = require('path');

const SESSION_FILE = process.env.PAYMENT_SESSION_FILE ||
  path.join(__dirname, '../../data/payment-sessions.json');
const SESSION_TTL_MS = parseInt(process.env.PAYMENT_SESSION_TTL_MS || '7200000', 10); // 2 hours

class PaymentSessionService {
  _read() {
    try {
      if (!fs.existsSync(SESSION_FILE)) return {};
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  _write(data) {
    try {
      const dir = path.dirname(SESSION_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[PaymentSession] Write failed:', e.message);
    }
  }

  save(orderId, { amount, gateway, mobile }) {
    const sessions = this._read();
    this._purgeExpired(sessions);
    sessions[String(orderId)] = {
      amount,
      gateway,
      mobile,
      createdAt: new Date().toISOString(),
    };
    this._write(sessions);
  }

  get(orderId) {
    const sessions = this._read();
    const entry = sessions[String(orderId)];
    if (!entry) return null;
    const age = Date.now() - new Date(entry.createdAt).getTime();
    if (age > SESSION_TTL_MS) return null;
    return entry;
  }

  remove(orderId) {
    const sessions = this._read();
    delete sessions[String(orderId)];
    this._write(sessions);
  }

  _purgeExpired(sessions) {
    const now = Date.now();
    for (const key of Object.keys(sessions)) {
      const age = now - new Date(sessions[key].createdAt).getTime();
      if (age > SESSION_TTL_MS) delete sessions[key];
    }
  }
}

module.exports = new PaymentSessionService();
