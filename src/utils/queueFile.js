'use strict';
// Shared by both retry queues (the gateway's and the extension's): the atomic write and the size cap.
const fs = require('fs');
const path = require('path');

// Write a temp file, then rename: a full disk fails the temp write and leaves the queue as it was.
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
    throw err;
  }
}

// A queue that grows without a limit fills the disk (2026-10-20). Over the cap the write fails on
// purpose, so the caller's existing "hold in memory + alert" path takes the item: it is never dropped.
function assertRoom(count, max) {
  if (count > max) throw new Error(`queue full (${max} items) — clear dead items`);
}

const cutError = (message) => String(message ?? 'unknown error').slice(0, 500);

module.exports = { writeJsonAtomic, assertRoom, cutError };
