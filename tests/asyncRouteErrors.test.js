'use strict';
const { wrap } = require('../src/routes/payment.routes');

test('a rejected async handler is passed to next, not left unhandled', async () => {
  const next = jest.fn();
  await wrap(async () => { throw new Error('SEP timeout'); })({}, {}, next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'SEP timeout' }));
});
