const fs   = require('fs');
const path = require('path');

const MAX_ENTRIES = 500;

// One bounded JSON error log per file. Two logs that must never mix entries (the gateway's own and an
// extension's) are two calls with two different files.
function createErrorLog(logFile) {
  function appendErrorLog(entry) {
    try {
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let logs = [];
      if (fs.existsSync(logFile)) {
        try { logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (err) { console.warn('[errorLogger] unreadable log file, starting a new one:', err.name); }
        if (!Array.isArray(logs)) logs = [];
      }

      logs.push({ ...entry, createdAt: new Date().toISOString() });
      if (logs.length > MAX_ENTRIES) logs = logs.slice(-MAX_ENTRIES);

      fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf8');
    } catch (err) {
      console.error('[errorLogger] Failed to write log:', err.message);
    }
  }

  function readErrorLog() {
    try {
      if (!fs.existsSync(logFile)) return [];
      const raw = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  return { appendErrorLog, readErrorLog };
}

const LOG_FILE = process.env.PAYMENT_ERROR_LOG_FILE || path.join(__dirname, '../../data/payment-error-log.json');

module.exports = { createErrorLog, ...createErrorLog(LOG_FILE) };
