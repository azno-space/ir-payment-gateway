'use strict';
const axios = require('axios');

// SEP's merchant report web service (report.sep.ir, guide v1.1): every transaction on your
// terminal for a date range, as SEP itself recorded it. It is the only way to find a charge whose
// callback never reached you. Credentials come from the SEP report panel (the Password there is
// already the SHA1 the panel's ReadMe describes). Optional: unset → the route answers 503.
const SEP_REPORT_URL = process.env.SEP_REPORT_URL || 'https://report.sep.ir/Service/ajaxCustomersSRV';

const column = (filterTitle, filterType, columnKey, columnName, extra = {}) => ({
  filterTitle, filterType, conditionType: 0, conditionValue: '', columnKey, columnName,
  isMandatory: false, FixedValue: '', ...extra,
});

function isConfigured(env = process.env) {
  return Boolean(env.SEP_REPORT_USERNAME && env.SEP_REPORT_PASSWORD && env.SEP_REPORT_WEBSERVICE_KEY);
}

// fromDate / toDate: Persian calendar dates 'YYYY/MM/DD'. The "<=" bound compares at midnight,
// so [day, nextDay] covers one day.
function buildReportRequest(fromDate, toDate, env = process.env) {
  return {
    IBANs: null, customerNumber: null, merchantNumber: null, terminalNumber: null,
    ExportTo: 0, IsTerminalQR: false,
    serviceColumns: [
      column('تاریخ تراکنش سوئیچ', 60, 'stracedt', 'STraceDt', { conditionType: 32, conditionValue: fromDate, isMandatory: true, FixedValue: null }),
      column('تاریخ تراکنش سوئیچ', 60, 'stracedt', 'STraceDt', { conditionType: 22, conditionValue: toDate, isMandatory: true, FixedValue: null }),
      column('وضعیت تراکنش', 202, 'trstatusdesc', 'TrStatusDesc', { conditionType: 200, FixedValue: 'PosCondition = 59' }),
      column('شماره کارت *', 106, 'pan', 'Pan'),
      column('شماره مرجع', 50, 'rrn', 'RRN'),
      column('شناسه خرید', 0, 'resnum', 'ResNum'),
      column('مبلغ تراکنش', 55, 'affectiveamount', 'AffectiveAmount'),
      column('کد رهگیری', 50, 'straceno', 'STraceNo'),
      column('رسید دیجیتالی', 0, 'refrencenumber', 'RefrenceNumber'),
    ],
    UserName: env.SEP_REPORT_USERNAME,
    Password: env.SEP_REPORT_PASSWORD,
    RepWebserviceKey: env.SEP_REPORT_WEBSERVICE_KEY,
    CustomerKey: env.SEP_REPORT_CUSTOMER_KEY,
    RepRelationKey: env.SEP_REPORT_RELATION_KEY,
    CanSplitFun: false, OfsetCount: -1, FetchCount: -1,
  };
}

const PERSIAN_DATE = /^\d{4}\/\d{2}\/\d{2}$/;

const fail = (message, status) => Object.assign(new Error(message), { status });

// SEP's answer → its rows, or an error that says why the report cannot be trusted.
function rowsOf(data) {
  if (!data || data.success !== true) throw fail(`SEP report refused: ${data?.message || 'no body'}`, 502);
  const rows = typeof data.data === 'string' ? JSON.parse(data.data || '[]') : data.data || [];
  // A partial answer would hide exactly the charges this report exists to find.
  if (Number(data.count) !== rows.length) throw fail(`SEP report count ${data.count} but ${rows.length} rows`, 502);
  return rows;
}

async function sepGetTransactionReport({ fromDate, toDate }) {
  if (!PERSIAN_DATE.test(String(fromDate)) || !PERSIAN_DATE.test(String(toDate))) {
    throw fail('fromDate and toDate must be Persian dates YYYY/MM/DD', 400);
  }
  const res = await axios.post(SEP_REPORT_URL, buildReportRequest(fromDate, toDate), { timeout: 120000 });
  return rowsOf(res.data);
}

module.exports = { isConfigured, buildReportRequest, sepGetTransactionReport };
