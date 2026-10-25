'use strict';
// When a failed SEP refund may be refreshed, and when to stop. Pure: the caller passes what it
// remembers about earlier refreshes and acts on the answer. SEP's own warning (refund service doc
// §5.13): refreshing a request whose previous state is unknown can create a duplicate, so every
// uncertain case waits or goes to a human instead of refreshing.

// SEP itself stops accepting attempts eventually (code 116); stop well before that.
const MAX_REFRESH_ATTEMPTS = 3;
// SEP executes refunds in cycles of up to 20 minutes (doc §5.3), so a report read sooner than this
// can still describe the state before our last refresh.
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;
// A refresh call that never got an answer leaves the request in an unknown state. Retry it a few
// times, then stop and ask a human to look at SEP's panel before paying by hand.
const MAX_REFRESH_CALL_FAILURES = 5;

const DECISION = {
  WAIT: 'wait', // the report may predate our last refresh
  REPEAT_REJECTION: 'repeat_rejection', // the bank said the same thing after a full retry
  REFRESH: 'refresh',
  GAVE_UP_UNKNOWN: 'gave_up_unknown', // calls never answered: the real state is unknown
  GAVE_UP_FINAL: 'gave_up_final', // refreshed enough times, each came back Fail
};

// The signal is the repetition, not the code: whatever the bank said last time, saying it again
// after a full retry means retrying is not the remedy.
function isRepeatBankRejection({ refreshCount, lastBankCode }, sep) {
  return Number(refreshCount || 0) >= 1 && !!sep.attemptTrackingCode && lastBankCode === sep.attemptTrackingCode;
}

// A refresh sent less than the cooldown ago may not have taken effect yet: the report still shows the old state.
const inCooldown = (lastRefreshAt, now) => Boolean(lastRefreshAt) && now - lastRefreshAt < REFRESH_COOLDOWN_MS;

function decideRefresh({ attempts, callFailures, lastRefreshAt, now }, repeatRejection) {
  if (inCooldown(lastRefreshAt, now)) return DECISION.WAIT;
  if (repeatRejection) return DECISION.REPEAT_REJECTION;
  if (attempts < MAX_REFRESH_ATTEMPTS && callFailures < MAX_REFRESH_CALL_FAILURES) return DECISION.REFRESH;
  return callFailures >= MAX_REFRESH_CALL_FAILURES ? DECISION.GAVE_UP_UNKNOWN : DECISION.GAVE_UP_FINAL;
}

module.exports = { DECISION, MAX_REFRESH_ATTEMPTS, MAX_REFRESH_CALL_FAILURES, REFRESH_COOLDOWN_MS, decideRefresh, inCooldown, isRepeatBankRejection };
