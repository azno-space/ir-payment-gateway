'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('errorLogger', () => {
  let logFile;
  let appendErrorLog;
  let readErrorLog;

  beforeEach(() => {
    logFile = path.join(os.tmpdir(), `payment-error-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.PAYMENT_ERROR_LOG_FILE = logFile;
    jest.resetModules();
    ({ appendErrorLog, readErrorLog } = require('../src/utils/errorLogger'));
  });

  afterEach(() => {
    delete process.env.PAYMENT_ERROR_LOG_FILE;
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  });

  test('readErrorLog returns an empty array when no log file exists yet', () => {
    expect(readErrorLog()).toEqual([]);
  });

  test('appendErrorLog writes an entry that readErrorLog can read back, with a createdAt stamp added', () => {
    appendErrorLog({ type: 'payment_failure', gateway: 'zarinpal', orderId: 'o1' });

    const logs = readErrorLog();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'payment_failure', gateway: 'zarinpal', orderId: 'o1' });
    expect(typeof logs[0].createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(logs[0].createdAt))).toBe(false);
  });

  test('appends accumulate in order across multiple calls', () => {
    appendErrorLog({ orderId: 'first' });
    appendErrorLog({ orderId: 'second' });
    appendErrorLog({ orderId: 'third' });

    const logs = readErrorLog();
    expect(logs.map((l) => l.orderId)).toEqual(['first', 'second', 'third']);
  });

  test('caps the log at 500 entries by trimming the oldest first', () => {
    for (let i = 0; i < 505; i++) {
      appendErrorLog({ orderId: `order-${i}` });
    }

    const logs = readErrorLog();
    expect(logs).toHaveLength(500);
    // The first 5 entries (order-0..order-4) should have been trimmed off.
    expect(logs[0].orderId).toBe('order-5');
    expect(logs[logs.length - 1].orderId).toBe('order-504');
  });

  test('readErrorLog returns an empty array (not a throw) if the log file contains invalid JSON', () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, 'not valid json{{{', 'utf8');
    expect(readErrorLog()).toEqual([]);
  });
});
