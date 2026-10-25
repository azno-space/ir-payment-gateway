require('dns').setDefaultResultOrder('ipv4first');
const axios = require('axios');
const http = require('http');
const https = require('https');
const dns = require('dns');

const dnsCache = {};
const CACHE_TTL = 300000;

function customDnsLookup(hostname, options, callback) {
  const now = Date.now();
  if (dnsCache[hostname] && dnsCache[hostname].expireTime > now) {
    return callback(null, dnsCache[hostname].address, dnsCache[hostname].family);
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (!err && address)
      dnsCache[hostname] = { address, family, expireTime: now + CACHE_TTL };
    callback(err, address, family);
  });
}

const agentOpts = { keepAlive: true, lookup: customDnsLookup };
const paymentAxios = axios.create({
  httpAgent: new http.Agent(agentOpts),
  httpsAgent: new https.Agent(agentOpts),
});

const ZIBAL_MERCHANT = process.env.ZIBAL_MERCHANT || '';
const ZARINPAL_MERCHANT = process.env.ZARINPAL_MERCHANT || '';
const ZARINPAL_SANDBOX = (process.env.ZARINPAL_SANDBOX || 'false').toLowerCase().trim() === 'true';
const SEP_TERMINAL_ID = process.env.SEP_TERMINAL_ID || '';
const SEP_USERNAME = process.env.SEP_USERNAME || '';
const SEP_PASSWORD = process.env.SEP_PASSWORD || '';
const SEP_REFUND_URL = 'https://srtm.sep.ir/RefundService/srvRefundV2.svc';

// Fail-fast defaults for the payment request phase
const REQUEST_TIMEOUT_MS = Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS) || 8000;
const REQUEST_RETRIES = Number(process.env.GATEWAY_REQUEST_RETRIES) || 1;

// Callback URL is built from CALLBACK_BASE_URL env var
const CALLBACK_BASE_URL = (process.env.CALLBACK_BASE_URL || '').replace(/\/$/, '');

function getCbUrl(orderId) {
  const base = `${CALLBACK_BASE_URL}/api/payments/callback`;
  if (!orderId) return base;
  return `${base}?orderId=${encodeURIComponent(String(orderId))}`;
}

async function retry(fn, retries = 3, delay = 500) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isNetworkErr =
        ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED'].includes(err.code) ||
        err.message?.match(/timeout|network|fetch|getaddrinfo/i);
      if (!isNetworkErr || i === retries) throw err;
      await new Promise((r) => setTimeout(r, delay * Math.pow(2, i - 1)));
    }
  }
}

const zibalRequestPayment = async ({ amount, orderId, mobile, timeout, retries }) => {
  if (!ZIBAL_MERCHANT) return { result: -1, message: 'ZIBAL_MERCHANT not configured' };
  try {
    return await retry(
      async () =>
        (await paymentAxios.post(
          'https://gateway.zibal.ir/v1/request',
          { merchant: ZIBAL_MERCHANT, amount, callbackUrl: getCbUrl(orderId), orderId, mobile },
          { timeout: timeout || REQUEST_TIMEOUT_MS },
        )).data,
      retries || REQUEST_RETRIES,
    );
  } catch (err) {
    return { result: -1, message: err.message };
  }
};

const zibalVerifyPayment = async (trackId) => {
  try {
    return await retry(async () =>
      (await paymentAxios.post(
        'https://gateway.zibal.ir/v1/verify',
        { merchant: ZIBAL_MERCHANT, trackId: Number(trackId) },
        { timeout: 15000 },
      )).data,
    );
  } catch (err) {
    throw new Error(`Zibal verify network error: ${err.message}`, { cause: err });
  }
};

const ZARINPAL_API_BASE = ZARINPAL_SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/v4/payment/'
  : 'https://payment.zarinpal.com/pg/v4/payment/';

const ZARINPAL_PAY_BASE = ZARINPAL_SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/StartPay/'
  : 'https://payment.zarinpal.com/pg/StartPay/';

const ZARINPAL_SANDBOX_API_BASE = 'https://sandbox.zarinpal.com/pg/v4/payment/';
const ZARINPAL_SANDBOX_PAY_BASE = 'https://sandbox.zarinpal.com/pg/StartPay/';

// A failed Zarinpal request → { errors: [...] } with the most specific message the bank gave.
const ZARINPAL_AUTH_HELP = 'Zarinpal authentication failed (HTTP 401). Possible causes: invalid ZARINPAL_MERCHANT, callback URL domain not registered in Zarinpal panel, or IP not whitelisted. Use gateway=zarinpal_sandbox for local testing.';
const asList = (errors) => (Array.isArray(errors) ? errors : [JSON.stringify(errors)]);
const validationMessage = (body) => body?.errors?.message;

function zarinpalRequestError(err) {
  const { status, data: body } = err.response || {};
  if (status === 401) return { errors: [ZARINPAL_AUTH_HELP] };
  if (status === 422 && validationMessage(body)) return { errors: [`Zarinpal validation error: ${validationMessage(body)}`] };
  if (body?.errors) return { errors: asList(body.errors) };
  return { errors: [err.message] };
}

function _buildZarinpalRequest({ apiBase, payBase, merchantId, amount, orderId, mobile, timeout, retries }) {
  if (!merchantId) return Promise.resolve({ errors: ['ZARINPAL_MERCHANT not configured'] });
  return retry(
    async () =>
      (await paymentAxios.post(
        `${apiBase}request.json`,
        {
          merchant_id: merchantId,
          amount,
          callback_url: getCbUrl(orderId),
          description: 'Payment',
          ...(mobile ? { mobile } : {}),
          order_id: orderId,
          metadata: { ...(mobile ? { mobile } : {}), email: '', order_id: orderId },
        },
        { timeout: timeout || REQUEST_TIMEOUT_MS },
      )).data,
    retries || REQUEST_RETRIES,
  ).catch(zarinpalRequestError);
}

function _buildZarinpalVerify({ apiBase, merchantId, authority, amount }) {
  return retry(async () =>
    (await paymentAxios.post(
      `${apiBase}verify.json`,
      { merchant_id: merchantId, authority, amount },
      { timeout: 15000 },
    )).data,
  ).catch((err) => { throw new Error(`Zarinpal verify network error: ${err.message}`); });
}

const zarinpalRequestPayment = ({ amount, orderId, mobile, timeout, retries }) =>
  _buildZarinpalRequest({ apiBase: ZARINPAL_API_BASE, payBase: ZARINPAL_PAY_BASE, merchantId: ZARINPAL_MERCHANT, amount, orderId, mobile, timeout, retries });

const zarinpalVerifyPayment = (authority, amount) =>
  _buildZarinpalVerify({ apiBase: ZARINPAL_API_BASE, merchantId: ZARINPAL_MERCHANT, authority, amount });

const zarinpalSandboxRequestPayment = ({ amount, orderId, mobile, timeout, retries }) =>
  _buildZarinpalRequest({ apiBase: ZARINPAL_SANDBOX_API_BASE, payBase: ZARINPAL_SANDBOX_PAY_BASE, merchantId: ZARINPAL_MERCHANT, amount, orderId, mobile, timeout, retries });

const zarinpalSandboxVerifyPayment = (authority, amount) =>
  _buildZarinpalVerify({ apiBase: ZARINPAL_SANDBOX_API_BASE, merchantId: ZARINPAL_MERCHANT, authority, amount });

const sepRequestPayment = async ({ amount, orderId, mobile, timeout, retries }) => {
  if (!SEP_TERMINAL_ID) return { Status: -1, ErrorDesc: 'SEP_TERMINAL_ID not configured' };
  try {
    const body = new URLSearchParams({
      action: 'token',
      TerminalId: SEP_TERMINAL_ID,
      Amount: amount.toString(),
      ResNum: orderId,
      RedirectUrl: getCbUrl(orderId),
      CellNumber: mobile || '',
      GetMethod: 'true',
    }).toString();
    return await retry(
      async () =>
        (await paymentAxios.post(
          'https://sep.shaparak.ir/OnlinePG/OnlinePG',
          body,
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: timeout || REQUEST_TIMEOUT_MS,
          },
        )).data,
      retries || REQUEST_RETRIES,
    );
  } catch (err) {
    return { Status: -1, ErrorDesc: err.message };
  }
};

const sepVerifyPayment = async (refNum) => {
  try {
    const body = new URLSearchParams({
      RefNum: refNum,
      TerminalNumber: SEP_TERMINAL_ID,
    }).toString();
    return await retry(async () =>
      (await paymentAxios.post(
        'https://sep.shaparak.ir/verifyTxnRandomSessionkey/ipg/VerifyTransaction',
        body,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000,
        },
      )).data,
    );
  } catch (err) {
    return { Success: false, ResultDescription: err.message };
  }
};

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function soapPost(soapAction, body) {
  const response = await paymentAxios.post(SEP_REFUND_URL, body, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: soapAction,
      host: 'srtm.sep.ir',
    },
    timeout: 30000,
    validateStatus: () => true,
    responseType: 'text',
  });
  return { status: response.status, data: response.data };
}

const sepRefundReg = async ({ refNum, resNum, amount, requestId, exeTime = 0, email = '', cellNumber = '', documentDescription = '', dicData = [] }) => {
  const kvPairs = dicData.length
    ? dicData.map(({ key = '', value = '' }) =>
        `<arr:KeyValueOfstringstring><arr:Key>${escapeXml(key)}</arr:Key><arr:Value>${escapeXml(value)}</arr:Value></arr:KeyValueOfstringstring>`,
      ).join('')
    : '<arr:KeyValueOfstringstring><arr:Key></arr:Key><arr:Value></arr:Value></arr:KeyValueOfstringstring>';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/" xmlns:arr="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:Refund_Reg>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:refNum>${escapeXml(refNum)}</tem:refNum>
      <tem:resNum>${escapeXml(resNum)}</tem:resNum>
      <tem:transactionTermId>${escapeXml(SEP_TERMINAL_ID)}</tem:transactionTermId>
      <tem:refundTermId>${escapeXml(SEP_TERMINAL_ID)}</tem:refundTermId>
      <tem:amount>${Number(amount)}</tem:amount>
      <tem:requestId>${escapeXml(requestId)}</tem:requestId>
      <tem:exeTime>${Number(exeTime)}</tem:exeTime>
      <tem:email>${escapeXml(email)}</tem:email>
      <tem:cellNumber>${escapeXml(cellNumber)}</tem:cellNumber>
      <tem:documentDescription>${escapeXml(documentDescription)}</tem:documentDescription>
      <tem:dicData>${kvPairs}</tem:dicData>
    </tem:Refund_Reg>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/Refund_Reg', xml);
};

const sepRefundExec = async ({ partialRefundId, typRefundAction }) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:Refund_Exec>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:partialRefundId>${escapeXml(partialRefundId)}</tem:partialRefundId>
      <tem:typRefundAction>${escapeXml(typRefundAction)}</tem:typRefundAction>
      <tem:termId>${escapeXml(SEP_TERMINAL_ID)}</tem:termId>
    </tem:Refund_Exec>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/Refund_Exec', xml);
};

const sepGetDailyRefundList = async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetDailyRefundList>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:termId>${escapeXml(SEP_TERMINAL_ID)}</tem:termId>
    </tem:GetDailyRefundList>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/GetDailyRefundList', xml);
};

const sepGetRefundStatus = async ({ refundId }) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetRefundStatus>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:refundId>${escapeXml(refundId)}</tem:refundId>
      <tem:termId>${escapeXml(SEP_TERMINAL_ID)}</tem:termId>
    </tem:GetRefundStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/GetRefundStatus', xml);
};

const sepGetRefundDetail = async ({ refundId }) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetRefundDetail>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:refundId>${escapeXml(refundId)}</tem:refundId>
      <tem:termId>${escapeXml(SEP_TERMINAL_ID)}</tem:termId>
    </tem:GetRefundDetail>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/GetRefundDetail', xml);
};

// Status of a refund you registered but whose refundId you never got (e.g. Refund_Reg answered
// DuplicateRequest): looked up by the requestId you sent to Refund_Reg. GetDailyRefundList only
// covers today, so this is the only way to find an older one.
const sepGetRefundStatusByRequestId = async ({ requestId }) => {
  if (!(Number(requestId) > 0)) throw new Error(`sepGetRefundStatusByRequestId: invalid requestId ${requestId}`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:GetRefundStatusByRequestId>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:requestId>${Number(requestId)}</tem:requestId>
      <tem:termId>${escapeXml(SEP_TERMINAL_ID)}</tem:termId>
    </tem:GetRefundStatusByRequestId>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/GetRefundStatusByRequestId', xml);
};

// Resets a failed refund back to Start so SEP processes it again. SEP's own warning: if the
// previous attempt's real outcome is unknown, a refresh can transfer the money twice — call it
// only for a refund SEP has definitively failed (RefundStatus=Fail).
const sepRefreshRefundRequest = async ({ partialRefundInfoId, description = '' }) => {
  if (!(Number(partialRefundInfoId) > 0)) {
    throw new Error(`sepRefreshRefundRequest: invalid partialRefundInfoId ${partialRefundInfoId}`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:RefreshRefundRequestByPartialRefundInfoId>
      <tem:userName>${escapeXml(SEP_USERNAME)}</tem:userName>
      <tem:password>${escapeXml(SEP_PASSWORD)}</tem:password>
      <tem:description>${escapeXml(description)}</tem:description>
      <tem:partialRefundInfoId>${Number(partialRefundInfoId)}</tem:partialRefundInfoId>
      <tem:refundTerminalNumber>${Number(SEP_TERMINAL_ID)}</tem:refundTerminalNumber>
    </tem:RefreshRefundRequestByPartialRefundInfoId>
  </soapenv:Body>
</soapenv:Envelope>`;

  return soapPost('http://tempuri.org/IsrvRefundV2/RefreshRefundRequestByPartialRefundInfoId', xml);
};

// Returns a list of unverified Zarinpal payments (paid but verify not called yet).
// Useful for recovering payments where the callback was missed.
const ZARINPAL_UNVERIFIED_URL = ZARINPAL_SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/v4/payment/unVerified.json'
  : 'https://payment.zarinpal.com/pg/v4/payment/unVerified.json';

const getZarinpalUnverified = async () => {
  if (!ZARINPAL_MERCHANT) return { ok: false, code: 'not_configured', error: 'ZARINPAL_MERCHANT not configured', authorities: [] };
  try {
    const res = await paymentAxios.post(
      ZARINPAL_UNVERIFIED_URL,
      { merchant_id: ZARINPAL_MERCHANT },
      {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true,
      },
    );
    if (res.data?.data?.authorities) {
      return { ok: true, count: res.data.data.authorities.length, authorities: res.data.data.authorities };
    }
    return { ok: false, error: 'Unexpected Zarinpal response', raw: res.data, authorities: [] };
  } catch (err) {
    return { ok: false, error: err.message, authorities: [] };
  }
};

module.exports = {
  ZARINPAL_PAY_BASE,
  ZARINPAL_SANDBOX_PAY_BASE,
  zibalRequestPayment,
  zibalVerifyPayment,
  zarinpalRequestPayment,
  zarinpalVerifyPayment,
  zarinpalSandboxRequestPayment,
  zarinpalSandboxVerifyPayment,
  sepRequestPayment,
  sepVerifyPayment,
  sepRefundReg,
  sepRefundExec,
  sepGetDailyRefundList,
  sepGetRefundStatus,
  sepGetRefundDetail,
  sepGetRefundStatusByRequestId,
  sepRefreshRefundRequest,
  getZarinpalUnverified,
  escapeXml,
  getCbUrl,
  _buildZarinpalRequest,
  _buildZarinpalVerify,
};
