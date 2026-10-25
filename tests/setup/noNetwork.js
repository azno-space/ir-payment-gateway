'use strict';
// Every test that runs bank or payment code runs with the network closed: a mock on the wrong axios instance
// once reached the real SEP host. Any socket to a host other than this machine is refused with an error that
// names the host. Loopback stays open for supertest and the tests' own servers. Loaded by jest `setupFiles`
// (and any extension's tests).
const net = require('net');

const FLAG = Symbol.for('gateway.noNetwork');
const LOCAL = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0|::ffff:127\.0\.0\.1)$/i;

if (!net.Socket.prototype[FLAG]) {
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype[FLAG] = true;

  // connect(options) | connect(port[, host]) | connect(path); net.connect() hands over a normalized [options, cb].
  const target = (args) => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') return first.path ? null : first.host;
    if (typeof first === 'number' || /^\d+$/.test(String(first))) return typeof args[1] === 'string' ? args[1] : 'localhost';
    return null; // a unix socket path
  };

  net.Socket.prototype.connect = function connect(...args) {
    const host = target(args);
    if (host == null || host === '' || LOCAL.test(String(host))) return realConnect.apply(this, args);
    const err = new Error(`real network call blocked in tests: ${host}`);
    err.code = 'ENETBLOCKED';
    throw err; // synchronous: the http(s) agents turn a throw from createConnection into the request's error
  };
}
