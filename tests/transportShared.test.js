// The two shared transport helpers: the "request never reached it" rule and the atomic queue write.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { neverReached } = require('../src/utils/reach');
const { writeJsonAtomic, assertRoom } = require('../src/utils/queueFile');

test('neverReached: connection-level codes and a proxy 502/503 only', () => {
  for (const code of ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']) expect(neverReached({ code })).toBe(true);
  expect(neverReached({ code: 'ECONNABORTED' })).toBe(false); // a timeout: it may have been received
  expect(neverReached({ code: 'ECONNRESET' })).toBe(false);
  expect(neverReached({ response: { status: 502 } })).toBe(true);
  expect(neverReached({ response: { status: 503 } })).toBe(true);
  expect(neverReached({ response: { status: 500 } })).toBe(false);
  expect(neverReached(undefined)).toBe(false);
});

test('writeJsonAtomic: creates the folder, renames over the old file, and a failed write leaves it untouched', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qf-')), 'a', 'q.json');
  writeJsonAtomic(file, [{ id: 1 }]);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([{ id: 1 }]);
  const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); });
  expect(() => writeJsonAtomic(file, [{ id: 2 }])).toThrow('ENOSPC');
  spy.mockRestore();
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([{ id: 1 }]);
  expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test('assertRoom: throws only when the count is over the cap', () => {
  expect(() => assertRoom(5, 5)).not.toThrow();
  expect(() => assertRoom(6, 5)).toThrow(/queue full/);
});
