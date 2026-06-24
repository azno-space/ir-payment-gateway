const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
const RETENTION_DAYS = 3;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `app-${date}.log`);
}

function formatLine(level, args) {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  return JSON.stringify({ ts, level, msg }) + '\n';
}

function writeLog(level, args) {
  try {
    ensureLogDir();
    const line = formatLine(level, args);
    fs.appendFileSync(getLogFilePath(), line, 'utf8');
  } catch (_) {}
}

function deleteOldLogs() {
  try {
    ensureLogDir();
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!file.startsWith('app-') || !file.endsWith('.log')) continue;
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

function patchConsole() {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => { orig.log(...args); writeLog('INFO', args); };
  console.warn = (...args) => { orig.warn(...args); writeLog('WARN', args); };
  console.error = (...args) => { orig.error(...args); writeLog('ERROR', args); };

  deleteOldLogs();
  setInterval(deleteOldLogs, 24 * 60 * 60 * 1000);
}

module.exports = { patchConsole };
