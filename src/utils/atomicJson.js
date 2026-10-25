'use strict';
// A small JSON file kept safe against a crash mid-write: the new content is written beside the file and
// renamed over it, so the file is always either the old content or the new, never a truncated one.
const fs = require('fs');
const path = require('path');

// → the parsed object (without a prototype, so a key such as "constructor" is an ordinary key); {} when
// the file is missing or unreadable.
function readJson(file, label) {
  try {
    const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return Object.assign(Object.create(null), parsed && typeof parsed === 'object' ? parsed : {});
  } catch (err) {
    console.warn(`[${label}] unreadable file, starting empty:`, err.name);
    return Object.create(null);
  }
}

// → true when stored, false (and logged) when not.
function writeJson(file, data, label) {
  const tmp = `${file}.${process.pid}.tmp`; // one writer per process; processes sharing a file would still race on the rename
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[${label}] write failed:`, err.message);
    return false;
  }
}

module.exports = { readJson, writeJson };
