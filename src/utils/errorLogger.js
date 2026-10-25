const fs   = require('fs');
const path = require('path');

const LOG_FILE    = process.env.PAYMENT_ERROR_LOG_FILE || path.join(__dirname, '../../data/payment-error-log.json');
const MAX_ENTRIES = 500;

function appendErrorLog(entry) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
      if (!Array.isArray(logs)) logs = [];
    }

    logs.push({ ...entry, createdAt: new Date().toISOString() });
    if (logs.length > MAX_ENTRIES) logs = logs.slice(-MAX_ENTRIES);

    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('[errorLogger] Failed to write log:', err.message);
  }
}

function readErrorLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

module.exports = { appendErrorLog, readErrorLog };
