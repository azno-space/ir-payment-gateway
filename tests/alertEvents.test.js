'use strict';
const alerts = require('../src/alerts');

test('an event reaches the registered handler; a throwing or missing handler never breaks the caller', async () => {
  const seen = [];
  alerts.onAlertEvent((n, d) => { seen.push([n, d]); });
  alerts.emitAlertEvent('x', { a: 1 });
  expect(seen).toEqual([['x', { a: 1 }]]);
  alerts.onAlertEvent(() => { throw new Error('boom'); });
  expect(() => alerts.emitAlertEvent('x')).not.toThrow();
  alerts.onAlertEvent(async () => { throw new Error('boom'); });
  expect(() => alerts.emitAlertEvent('x')).not.toThrow();
  alerts.onAlertEvent(null);
  expect(() => alerts.emitAlertEvent('x')).not.toThrow();
});

test('an alert with no text is a failure, not a send', async () => {
  const post = jest.fn();
  await expect(alerts.postMessage('bale', { chatId: 'c', url: 'u' }, '', {}, () => ({ post }))).rejects.toMatchObject({ code: 'EMPTY_ALERT' });
  expect(post).not.toHaveBeenCalled();
  expect(alerts.isRetryable(Object.assign(new Error('x'), { code: 'EMPTY_ALERT' }))).toBe(false);
});
