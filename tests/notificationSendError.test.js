const { describeSendError } = require('../src/services/notification.service');

test('describeSendError adds the platform reason and code, never the token-bearing URL', () => {
  const err = Object.assign(new Error('Request failed with status code 403'), {
    code: 'ERR_BAD_REQUEST',
    config: { url: 'https://tapi.bale.ai/bot123:SECRET/sendMessage' },
    response: { status: 403, data: { ok: false, description: 'Forbidden: bot was kicked from the group chat' } },
  });
  const text = describeSendError(err);
  expect(text).toBe('Request failed with status code 403 | ERR_BAD_REQUEST | Forbidden: bot was kicked from the group chat');
  expect(text).not.toContain('SECRET');
  expect(describeSendError(Object.assign(new Error(''), { code: 'ECONNABORTED' }))).toBe('ECONNABORTED');
});
