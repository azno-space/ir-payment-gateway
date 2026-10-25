'use strict';
const morgan = require('morgan');

// One access-log line per request: method, ROUTE TEMPLATE (/api/payments/admin/queue/:id), status, time.
// Never the real URL: query strings and ids carry orderId, bank codes and references (the old
// morgan('dev') line printed them). A request no route matched prints "-".
// The line shape (`GET /path 200 12.3 ms`) is the one tools/api-map/traffic.py counts.
const segments = (p) => String(p).split('/').filter(Boolean);

// The mount prefix is taken from the URL that was asked for (its first segments, before the part the route
// template covers), because req.baseUrl is reset once an error or next() leaves a sub-router. Only mount
// segments come from the real path, and mounts are static; a template that is not a plain string prints "-".
function routeTemplate(req) {
  if (!req.route || typeof req.route.path !== 'string') return '-';
  const asked = segments(String(req.originalUrl || '').split('?')[0]);
  const tail = segments(req.route.path);
  const prefix = asked.slice(0, Math.max(0, asked.length - tail.length));
  return `/${[...prefix, ...tail].join('/')}`;
}

morgan.token('route', routeTemplate);

const requestLog = (stream = process.stdout) => morgan(':method :route :status :response-time ms', { stream });

module.exports = requestLog;
module.exports.routeTemplate = routeTemplate;
