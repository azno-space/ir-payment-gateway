'use strict';
// The one constant-time secret compare: both sides are hashed to one length first, so neither the content nor
// the length of a secret shows in the time taken.
const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

const secretEquals = (given, expected) => crypto.timingSafeEqual(digest(expected), digest(given));

// Every candidate is compared, so the time taken does not tell which one (or whether any) matched.
function matchesAnySecret(given, secrets) {
  let hit = false;
  for (const s of secrets) hit = secretEquals(given, s) || hit;
  return hit;
}

module.exports = { secretEquals, matchesAnySecret };
