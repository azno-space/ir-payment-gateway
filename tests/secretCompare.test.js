'use strict';
const crypto = require('crypto');
const { secretEquals, matchesAnySecret } = require('../src/utils/secretCompare');

test('equal only for the exact same text, whatever the length', () => {
  expect(secretEquals('abc', 'abc')).toBe(true);
  expect(secretEquals('abc', 'abd')).toBe(false);
  expect(secretEquals('abc', 'abcd')).toBe(false);
  expect(secretEquals('', 'a')).toBe(false);
  expect(secretEquals(12, '12')).toBe(true);
});

test('every candidate is compared, a match anywhere wins', () => {
  const spy = jest.spyOn(crypto, 'timingSafeEqual');
  expect(matchesAnySecret('b', ['a', 'b', 'c'])).toBe(true);
  expect(spy).toHaveBeenCalledTimes(3);
  spy.mockRestore();
  expect(matchesAnySecret('z', ['a', 'b'])).toBe(false);
  expect(matchesAnySecret('z', [])).toBe(false);
});
