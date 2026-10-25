'use strict';
// The one admin checker. Two scopes: 'read' (lists and look-ups) and 'money' (anything that moves
// money or changes state); a money key also passes 'read'. The key travels in a header,
// "Authorization: Bearer <key>" or "x-admin-key: <key>", and is compared in constant time.
// A key in the URL (`?token=`) is not accepted: URLs end up in logs.
//
// Keys are read on every call (a list, or a function returning one), so a changed env needs no
// restart logic. Defaults: ADMIN_KEY = money, ADMIN_READ_KEY = read.
const { sendError } = require('./apiError');
const { matchesAnySecret } = require('./secretCompare');

const keysOf = (k) => (typeof k === 'function' ? k() : k || []).filter((x) => typeof x === 'string' && x.trim());

function presentedKey(req) {
  const auth = String(req.headers?.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const header = req.headers?.['x-admin-key'];
  if (typeof header === 'string' && header) return header;
  return '';
}

function createAdminAuth({
  moneyKeys = () => [process.env.ADMIN_KEY],
  readKeys = () => [process.env.ADMIN_READ_KEY],
  // How a refusal is sent: (res, status, code, message). The default is this API's v1 shape.
  onError = sendError,
} = {}) {
  // → 'ok' | 'unconfigured' | 'unauthorized' | 'forbidden'
  function check(req, scope = 'money') {
    const money = keysOf(moneyKeys);
    const read = keysOf(readKeys);
    if (!money.length && !read.length) return 'unconfigured';
    const given = presentedKey(req);
    if (!given) return 'unauthorized';
    if (matchesAnySecret(given, money)) return 'ok';
    if (matchesAnySecret(given, read)) return scope === 'read' ? 'ok' : 'forbidden';
    return 'unauthorized';
  }

  function requireScope(scope) {
    if (scope !== 'read' && scope !== 'money') throw new Error(`adminAuth: unknown scope ${scope}`);
    const mw = (req, res, next) => {
      const outcome = check(req, scope);
      if (outcome === 'ok') return next();
      if (outcome === 'unconfigured') return onError(res, 503, 'admin_auth_not_configured');
      if (outcome === 'forbidden') return onError(res, 403, 'forbidden', 'this key may only read');
      return onError(res, 401, 'unauthorized');
    };
    mw.adminScope = scope; // lets a test prove every admin route names its scope
    return mw;
  }

  return { check, requireScope, read: requireScope('read'), money: requireScope('money') };
}

module.exports = { createAdminAuth };
