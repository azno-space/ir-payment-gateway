'use strict';
// The size allow-list: files over 200 lines that were reviewed and kept. It may only
// shrink, so every entry must still be a real file over the line, with a reason. max-lines itself is a lint
// warning, never a build break; this test only keeps the list honest.
const fs = require('fs');
const path = require('path');
const list = require('../size-allowlist.json');
const { atMergeBase, grown } = require('./helpers/shrinkOnly');

const lines = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').length - 1;

test.each(Object.entries(list))('%s is still over 200 lines and says why', (file, reason) => {
  expect(lines(file)).toBeGreaterThan(200); // under it now: delete the entry
  expect(reason.trim().length).toBeGreaterThan(15);
});

test('the list did not grow since the merge-base with dev', () => {
  const base = atMergeBase('size-allowlist.json');
  if (!base) return console.warn('size-allowlist.json: no merge-base version to compare with (new file or no dev ref): skipped');
  expect(grown(base, list)).toEqual([]);
});
