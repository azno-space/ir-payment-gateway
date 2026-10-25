'use strict';
// Allow-lists (complexity counts, files kept over 200 lines) may only shrink. These helpers compare a list
// with its version at the merge-base with dev, so a change that adds an entry or raises a count is caught.
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '../..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// The parsed JSON file (path from the repo root) as it was at the merge-base, or null when it cannot be read
// (no dev ref in a shallow clone, or the file did not exist yet: the change that introduces a list).
function atMergeBase(file) {
  for (const ref of ['origin/dev', 'dev']) {
    try {
      return JSON.parse(git('show', `${git('merge-base', 'HEAD', ref)}:${file}`));
    } catch (_) { /* try the next ref */ }
  }
  return null;
}

// Entries that are new, or whose number is higher than before.
const grown = (base, current) => Object.keys(current)
  .filter((k) => !(k in base) || (typeof current[k] === 'number' && current[k] > base[k]));

module.exports = { atMergeBase, grown };
