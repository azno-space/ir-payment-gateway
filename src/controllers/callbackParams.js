'use strict';
// Reading what a bank sends back to the callback: which gateway, which reference, which order, and the
// wording of a SEP cancellation. Pure functions; nothing here talks to a bank or sends an alert.

// Banks spell the same field in several cases; the first spelling that has a value wins.
const pick = (query, ...names) => names.map((name) => query[name]).find(Boolean);

// SEP signals itself by a reference, an order number or a status (a cancel carries only the last two).
function parseSep(query) {
  const refNum = pick(query, 'RefNum', 'refNum', 'refnum');
  const resNum = pick(query, 'ResNum', 'resNum', 'resnum');
  const status = pick(query, 'Status', 'status');
  if (!(refNum || resNum || status)) return null;
  return { gateway: 'sep', code: refNum || resNum || '', orderId: resNum || '' };
}

function parseGatewayParams(query) {
  const trackId = pick(query, 'trackId', 'trackID', 'trackid');
  if (trackId) return { gateway: 'zibal', code: trackId, orderId: pick(query, 'orderId', 'orderID', 'orderid') || '' };

  const authority = pick(query, 'Authority', 'authority');
  if (authority) return { gateway: 'zarinpal', code: authority, orderId: query.orderId || '' };

  return parseSep(query) || { gateway: '', code: '', orderId: '' };
}

function getParam(params, names) {
  for (const name of names) {
    if (params[name] !== undefined && params[name] !== null && params[name] !== '') return params[name];
  }
  return undefined;
}

function isSepCallbackConfirmed(params) {
  const state = getParam(params, ['State', 'state']);
  const status = getParam(params, ['Status', 'status']);
  return String(state).toUpperCase() === 'OK' || String(status) === '2';
}

function extractSepGatewayErrorDesc(params) {
  return getParam(params, ['ErrorDesc', 'errorDesc', 'error', 'ResultDescription', 'resultDescription', 'Message', 'message', 'ErrorMessage', 'errorMessage']);
}

function buildSepCallbackCancelReason(params) {
  const sepState = getParam(params, ['State', 'state']);
  const sepStatus = getParam(params, ['Status', 'status']);
  const gatewayErrorDesc = extractSepGatewayErrorDesc(params);
  let category;
  if (!sepState && !sepStatus) category = 'درگاه پاسخ صحیحی ارسال نکرد';
  else if (sepState === 'CANCEL' || sepStatus === '1') category = 'توسط کاربر انصراف داده شد';
  else if (sepState === 'NOK' || sepStatus === '0') category = 'توسط درگاه یا بانک رد شد';
  else category = `State=${sepState}, Status=${sepStatus}`;
  return gatewayErrorDesc ? `${category} — ${gatewayErrorDesc}` : category;
}

function buildSepVerifyDetails(params, verifyResult, extraData = {}) {
  return {
    metadata: {
      gateway: 'sep',
      data: {
        RefNum: getParam(params, ['RefNum', 'refNum', 'refnum']),
        ResNum: getParam(params, ['ResNum', 'resNum', 'resnum']),
        State: getParam(params, ['State', 'state']),
        Status: getParam(params, ['Status', 'status']),
        TraceNo: getParam(params, ['TraceNo', 'traceNo', 'traceno']),
        Amount: getParam(params, ['Amount', 'amount']),
        Rrn: getParam(params, ['Rrn', 'RRN', 'rrn']),
        SecurePan: getParam(params, ['SecurePan', 'securePan', 'securepan']),
        Token: getParam(params, ['Token', 'token']),
        ErrorDesc: extractSepGatewayErrorDesc(params),
        VerifyResult: verifyResult?.ResultDescription,
        CancelReason: verifyResult?.cancelReason,
        ...extraData,
      },
    },
  };
}

module.exports = {
  pick,
  parseGatewayParams,
  getParam,
  isSepCallbackConfirmed,
  extractSepGatewayErrorDesc,
  buildSepCallbackCancelReason,
  buildSepVerifyDetails,
};
