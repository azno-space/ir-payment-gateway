'use strict';
const { readPage, pageOf, DEFAULT_LIMIT, MAX_LIMIT } = require('../src/v2/pagination');

test('defaults when nothing is asked', () => {
  expect(readPage({})).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
});

test('a limit above the cap is clamped', () => {
  expect(readPage({ limit: '100000' })).toEqual({ limit: MAX_LIMIT, offset: 0 });
});

test.each([['abc'], ['-1'], ['1.5'], ['0'], ['1e3']])('limit %s is refused', (limit) => {
  expect(readPage({ limit })).toEqual({ invalid: 'limit' });
});

test.each([['abc'], ['-5'], ['2.5']])('offset %s is refused', (offset) => {
  expect(readPage({ offset })).toEqual({ invalid: 'offset' });
});

test('pageOf returns the window and the total behind it', () => {
  const all = [1, 2, 3, 4, 5];
  expect(pageOf(all, { limit: 2, offset: 1 })).toEqual({ items: [2, 3], total: 5, limit: 2, offset: 1 });
  expect(pageOf(all, { limit: 2, offset: 9 })).toEqual({ items: [], total: 5, limit: 2, offset: 9 });
});
