'use strict';
// One rule for "the request provably never reached the other side" — the only case where trying the
// next address is safe. A timeout or any other answer may mean it was received, and sending again
// could do the thing twice. NOTE: this also moves webhook.service to the next address on a 502/503
// answer (a proxy with no upstream). A proxy answering 502/503 had no upstream: it counts as never reached.
const NEVER_REACHED_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

function neverReached(err) {
  if (err?.response) return err.response.status === 502 || err.response.status === 503;
  return NEVER_REACHED_CODES.has(err?.code);
}

module.exports = { neverReached, NEVER_REACHED_CODES };
