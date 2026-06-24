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
    throw new Error(`Zibal verify network error: ${err.message}`);
  }
};

const zarinpalRequestPayment = async ({ amount, orderId, mobile, timeout, retries }) => {
  if (!ZARINPAL_MERCHANT) return { errors: ['ZARINPAL_MERCHANT not configured'] };
  try {
    return await retry(
      async () =>
        (await paymentAxios.post(
          'https://payment.zarinpal.com/pg/v4/payment/request.json',
          {
            merchant_id: ZARINPAL_MERCHANT,
            amount,
            callback_url: getCbUrl(orderId),
            description: 'Payment',
            mobile,
            order_id: orderId,
            metadata: { mobile, email: '', order_id: orderId },
          },
          { timeout: timeout || REQUEST_TIMEOUT_MS },
        )).data,
      retries || REQUEST_RETRIES,
    );
  } catch (err) {
    return { errors: [err.message] };
  }
};

const zarinpalVerifyPayment = async (authority, amount) => {
  try {
    return await retry(async () =>
      (await paymentAxios.post(
        'https://payment.zarinpal.com/pg/v4/payment/verify.json',
        { merchant_id: ZARINPAL_MERCHANT, authority, amount },
        { timeout: 15000 },
      )).data,
    );
  } catch (err) {
    throw new Error(`Zarinpal verify network error: ${err.message}`);
  }
};

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

module.exports = {
  zibalRequestPayment,
  zibalVerifyPayment,
  zarinpalRequestPayment,
  zarinpalVerifyPayment,
  sepRequestPayment,
  sepVerifyPayment,
  sepRefundReg,
  sepRefundExec,
  sepGetDailyRefundList,
  sepGetRefundStatus,
};
