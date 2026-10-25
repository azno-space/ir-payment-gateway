'use strict';
// The right to send ONE refresh for a refund request at a time. A second refresh while the first one's
// outcome is unknown can pay the customer twice (SEP refund doc §5.13), so whoever refreshes (the admin route,
// or a background job of the receiver) first takes the claim:
//   - one claim per refund at once, taken before anything is awaited, so two parallel requests cannot both pass;
//   - not inside the cooldown since the last refresh (src/sep/refreshDecision: the same constant the job uses).
// "When was the last refresh" is remembered in memory, or in a store the receiver plugs in (useStampStore)
// so the stamp survives a restart and is shared with whatever else refreshes.
const { inCooldown, REFRESH_COOLDOWN_MS } = require('./refreshDecision');

// The claim is in-process: it is safe only while ONE container runs the gateway (the deploy template,
// a deploy, starts exactly one). With replicas, two of them could each pass it; it would
// then have to become a conditional update on the stamp in the database (set the stamp only where it is older
// than the cooldown, and refresh only if one row changed).
const inFlight = new Set();

// { last(refundId) -> Promise<ms|0>, record(refundId, ms) -> Promise, hold?(refundId) -> Promise<string|null> }.
// `hold` lets the receiver say that something else owns the refund now (a person pays it by hand, it is
// already paid back): the answer is a code, and no refresh may be sent. The default remembers in memory.
function memoryStore() {
  const at = new Map();
  return { last: async (id) => at.get(id) || 0, record: async (id, ms) => { at.set(id, ms); } };
}
let store = memoryStore();

// Replaces where the stamps live (a store that survives restarts and is shared with the job); no argument
// goes back to memory.
function useStampStore(next) {
  store = next || memoryStore();
}

// Why this refund may not be refreshed right now, or null.
async function refusalFor(id, now) {
  const hold = store.hold ? await store.hold(id) : null;
  if (hold) return { hold };
  const last = Number(await store.last(id)) || 0;
  if (inCooldown(last, now)) return { retryAfterSeconds: Math.ceil((REFRESH_COOLDOWN_MS - (now - last)) / 1000) };
  return null;
}

// Resolves { ok: true, stamp(), release() } or { ok: false, hold } (the store's code) or { ok: false, retryAfterSeconds }.
// `stamp()` records "a refresh is being sent now" and must be awaited BEFORE the request goes out: if it
// fails, nothing is sent. `release()` ends the claim (always, in a finally).
async function claimRefresh(refundId, now = Date.now()) {
  const id = String(refundId);
  if (inFlight.has(id)) return { ok: false, retryAfterSeconds: Math.ceil(REFRESH_COOLDOWN_MS / 1000) };
  inFlight.add(id); // no await between the check and this add
  const release = () => inFlight.delete(id);
  try {
    const refusal = await refusalFor(id, now);
    if (refusal) {
      release();
      return { ok: false, ...refusal };
    }
  } catch (err) {
    release();
    throw err;
  }
  return {
    ok: true,
    release,
    stamp: () => store.record(id, Date.now()),
  };
}

module.exports = { claimRefresh, useStampStore };
