'use strict';
const { grown } = require('./helpers/shrinkOnly');

test('a new entry or a higher count is growth; a lower count or a removal is not', () => {
  expect(grown({ a: 3, b: 2 }, { a: 3, b: 2 })).toEqual([]);
  expect(grown({ a: 3, b: 2 }, { a: 2 })).toEqual([]);
  expect(grown({ a: 3 }, { a: 4 })).toEqual(['a']);
  expect(grown({ a: 3 }, { a: 3, c: 1 })).toEqual(['c']);
  expect(grown({ a: 'why' }, { a: 'a different why' })).toEqual([]); // reasons are text: only new keys count
  expect(grown({ a: 'why' }, { a: 'why', n: 'new' })).toEqual(['n']);
});
