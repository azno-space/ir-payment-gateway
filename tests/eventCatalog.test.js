'use strict';
// The funnel and the dashboards count these event names. A rename or a removal here is a decision, not a
// side effect of a refactor: it has to be a deliberate edit of this list in the same change.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../src');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.c?js$/.test(e.name) ? [p] : [];
  });
}

test('the events the gateway emits are exactly these', () => {
  const names = new Set();
  for (const f of sources(SRC)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\blogPaymentEvent\(\s*['"]([a-z_]+)['"]/g)) names.add(m[1]);
  }
  expect([...names].sort()).toEqual([
    'payment_error',
    'payment_failover',
    'payment_initiated',
    'payment_replay',
    'payment_success',
    'payment_warning',
  ]);
});
