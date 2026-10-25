'use strict';
// A named event the host application may turn into an alert. The core code reports "this happened"
// (name + ids); whoever mounts it decides whether, where and in which words. Never throws.

let handler = null;

function onAlertEvent(fn) { handler = fn; }

function emitAlertEvent(name, data = {}) {
  try {
    if (handler) Promise.resolve(handler(name, data)).catch(() => {});
  } catch { /* an alert hook must never break a payment */ }
}

module.exports = { onAlertEvent, emitAlertEvent };
