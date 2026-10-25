'use strict';
const { DECISION, decideRefresh, isRepeatBankRejection } = require('../src/sep/refreshDecision');

const NOW = 1_000_000_000;
const base = { attempts: 0, callFailures: 0, lastRefreshAt: 0, now: NOW };

test.each([
  ['first refresh', {}, false, DECISION.REFRESH],
  ['report may predate the last refresh', { lastRefreshAt: NOW - 60_000 }, false, DECISION.WAIT],
  ['cooldown over', { lastRefreshAt: NOW - 31 * 60_000 }, false, DECISION.REFRESH],
  ['same bank error twice (checked after cooldown)', { attempts: 1, lastRefreshAt: NOW - 3_600_000 }, true, DECISION.REPEAT_REJECTION],
  ['cooldown beats repeat rejection', { attempts: 1, lastRefreshAt: NOW - 60_000 }, true, DECISION.WAIT],
  ['three refreshes done', { attempts: 3 }, false, DECISION.GAVE_UP_FINAL],
  ['five unanswered calls', { callFailures: 5 }, false, DECISION.GAVE_UP_UNKNOWN],
  ['both exhausted: unknown state wins', { attempts: 3, callFailures: 5 }, false, DECISION.GAVE_UP_UNKNOWN],
])('%s', (_n, state, repeat, expected) => {
  expect(decideRefresh({ ...base, ...state }, repeat)).toBe(expected);
});

test('repeat rejection needs a previous refresh and a bank code that matches', () => {
  expect(isRepeatBankRejection({ refreshCount: 1, lastBankCode: '78' }, { attemptTrackingCode: '78' })).toBe(true);
  expect(isRepeatBankRejection({ refreshCount: 0, lastBankCode: '78' }, { attemptTrackingCode: '78' })).toBe(false);
  expect(isRepeatBankRejection({ refreshCount: 1, lastBankCode: '12' }, { attemptTrackingCode: '78' })).toBe(false);
  expect(isRepeatBankRejection({ refreshCount: 1, lastBankCode: '78' }, { attemptTrackingCode: '' })).toBe(false);
});

// The refund job refreshes what isRefreshable says and the error table routes with ACTION.REFRESH: they
// must name the same code, or the job would treat as refreshable what the admin route refuses.
test('only exec code 114 is a REFRESH action, and only an overall Fail with 114 is refreshable', () => {
  const { classifyExecFailure, ACTION } = require('../src/sep/refundErrors');
  const { isRefreshable } = require('../src/sep/refreshGuard');
  const refreshCodes = Array.from({ length: 300 }, (_, i) => String(i)).filter((c) => classifyExecFailure(c).action === ACTION.REFRESH);
  expect(refreshCodes).toEqual(['114']);
  expect(isRefreshable({ refundStatusCode: '4', attemptStatusCode: '114' })).toBe(true);
  for (const [status, code] of [['3', '114'], ['1', '114'], ['2', '114'], ['5', '114'], ['0', '114'], ['4', '115'], ['4', '']]) {
    expect(isRefreshable({ refundStatusCode: status, attemptStatusCode: code })).toBe(false);
  }
});
