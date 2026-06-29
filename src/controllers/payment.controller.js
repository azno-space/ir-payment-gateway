const {
  zibalVerifyPayment,
  zarinpalVerifyPayment,
  sepVerifyPayment,
  zibalRequestPayment,
  zarinpalRequestPayment,
  sepRequestPayment,
  sepRefundReg,
  sepRefundExec,
  sepGetDailyRefundList,
  sepGetRefundStatus,
} = require('../services/payment-gateway.service');
const { callWebhook, pingWebhook } = require('../services/webhook.service');
const paymentSession = require('../services/payment-session.service');
const paymentQueue = require('../services/payment-queue.service');
const { renderErrorPage } = require('../views/error-page');
const { renderPendingPage } = require('../views/pending-page');
const { logPaymentEvent } = require('../utils/eventLogger');
const {
  sendErrorNotificationToBale,
  sendFailedPaymentNotificationToBale,
  sendPaymentSuccessNotificationToBale,
  sendWarningNotificationToBale,
  sendBaleRecoveryMessage,
} = require('../services/notification.service');

const FRONT_BASE_URL = process.env.FRONT_BASE_URL || '';
const FRONT_SUCCESS_URL = process.env.FRONT_SUCCESS_URL || (FRONT_BASE_URL ? `${FRONT_BASE_URL}/payment/success` : '');
const frontUrl = (p) => `${FRONT_BASE_URL}${p}`;

const PAYMENT_SUCCESS_WEBHOOK_URL = process.env.PAYMENT_SUCCESS_WEBHOOK_URL || '';
const PAYMENT_FAILURE_WEBHOOK_URL = process.env.PAYMENT_FAILURE_WEBHOOK_URL || '';

const VALID_GATEWAYS = ['zibal', 'zarinpal', 'sep'];
const FORCED_GATEWAY = (process.env.FORCED_PAYMENT_GATEWAY || '').toLowerCase().trim();

const PAYMENT_FAILOVER_ENABLED =
  (process.env.PAYMENT_FAILOVER_ENABLED || 'true').toLowerCase().trim() !== 'false';

const FAILOVER_CHAINS = {
  sep: ['sep', 'zarinpal'],
  zarinpal: ['zarinpal'],
  zibal: ['zibal'],
};

const GATEWAY_LAST_TIMEOUT_MS = Number(process.env.GATEWAY_LAST_TIMEOUT_MS) || 15000;
const GATEWAY_LAST_RETRIES = Number(process.env.GATEWAY_LAST_RETRIES) || 2;

function resolveGateway(requestedGateway) {
  if (FORCED_GATEWAY) {
    if (!VALID_GATEWAYS.includes(FORCED_GATEWAY)) {
      console.warn(`Invalid FORCED_PAYMENT_GATEWAY="${FORCED_GATEWAY}"`);
    } else {
      return FORCED_GATEWAY;
    }
  }
  return VALID_GATEWAYS.includes(requestedGateway) ? requestedGateway : 'zarinpal';
}

function buildGatewayChain(primary) {
  if (!PAYMENT_FAILOVER_ENABLED) return [primary];
  return FAILOVER_CHAINS[primary] || [primary];
}

async function attemptGatewayRequest(gateway, { amount, orderId, mobile, timeout, retries }) {
  if (gateway === 'zibal') {
    const raw = await zibalRequestPayment({ amount, orderId, mobile, timeout, retries });
    if (raw.result === 100 && raw.trackId) {
      return {
        ok: true, gateway,
        targetUrl: `https://gateway.zibal.ir/start/${raw.trackId}`,
        identifier: raw.trackId, raw,
      };
    }
    return { ok: false, gateway, reason: raw.message || 'Zibal returned non-100 result', raw };
  }

  if (gateway === 'zarinpal') {
    const raw = await zarinpalRequestPayment({ amount, orderId, mobile, timeout, retries });
    if (raw.data && raw.data.code === 100 && raw.data.authority) {
      return {
        ok: true, gateway,
        targetUrl: `https://payment.zarinpal.com/pg/StartPay/${raw.data.authority}`,
        identifier: raw.data.authority, raw,
      };
    }
    const reason = raw.data?.message || (raw.errors ? JSON.stringify(raw.errors) : 'Zarinpal returned non-100 code');
    return { ok: false, gateway, reason, raw };
  }

  if (gateway === 'sep') {
    const raw = await sepRequestPayment({ amount, orderId, mobile, timeout, retries });
    const status = Number(raw.Status ?? raw.status ?? raw.result);
    const token = raw.Token || raw.token;
    const refNum = raw.RefNum || raw.refNum || raw.refnum;
    if (status === 1 && token) {
      return {
        ok: true, gateway,
        targetUrl: `https://sep.shaparak.ir/OnlinePG/SendToken?token=${token}`,
        identifier: refNum || token, raw,
      };
    }
    return { ok: false, gateway, reason: raw.ErrorDesc || raw.errorDesc || 'SEP returned non-1 status', raw };
  }

  return { ok: false, gateway, reason: `Invalid gateway: ${gateway}` };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkAdminAuth(req) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return false;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.substring(7) === adminKey;
  if (req.query.token) return req.query.token === adminKey;
  return false;
}

function parseGatewayParams(query) {
  const zb = {
    trackId: query.trackId || query.trackID || query.trackid,
    orderId: query.orderId || query.orderID || query.orderid,
  };
  const zp = { authority: query.Authority || query.authority, status: query.Status || query.status };
  const sep = {
    refNum: query.RefNum || query.refNum || query.refnum,
    resNum: query.ResNum || query.resNum || query.resnum,
    status: query.Status || query.status,
  };

  if (zb.trackId) return { gateway: 'zibal', code: zb.trackId, orderId: zb.orderId || '' };
  if (zp.authority) return { gateway: 'zarinpal', code: zp.authority, orderId: query.orderId || '' };
  if (sep.refNum || sep.resNum || sep.status) {
    return { gateway: 'sep', code: sep.refNum || sep.resNum || '', orderId: sep.resNum || '' };
  }
  return { gateway: '', code: '', orderId: '' };
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

function notifyBaleFailure(errorDetails) {
  setImmediate(() => {
    sendFailedPaymentNotificationToBale(errorDetails).catch((err) =>
      console.error('Failed to send Bale failure notification:', err.message),
    );
  });
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

async function dispatchSuccessWebhook({ orderId, gateway, code, verifyDetails }) {
  const payload = {
    orderId,
    gateway,
    code,
    status: 'success',
    verifyDetails,
    timestamp: new Date().toISOString(),
  };

  const result = await callWebhook(PAYMENT_SUCCESS_WEBHOOK_URL, payload);

  if (!result.ok && !result.skipped) {
    paymentQueue.addToQueue({ orderId, gateway, code, verifyDetails, payload });
    console.warn(`[Webhook] Success webhook failed — queued for retry. orderId=${orderId}`);
  }

  return result;
}

async function dispatchFailureWebhook({ orderId, gateway, code, reason }) {
  if (!PAYMENT_FAILURE_WEBHOOK_URL) return;
  const payload = {
    orderId,
    gateway,
    code,
    status: 'failed',
    reason,
    timestamp: new Date().toISOString(),
  };
  callWebhook(PAYMENT_FAILURE_WEBHOOK_URL, payload, { retries: 1 }).catch(() => {});
}

// Queue worker: retries failed success webhooks
async function processQueuedWebhook(item) {
  const { id, orderId, gateway, code, verifyDetails, retryCount } = item;
  console.log(`[Queue] Retrying webhook id=${id} orderId=${orderId} retry=${retryCount}`);

  paymentQueue.updateItem(id, { lastAttemptAt: new Date().toISOString(), retryCount: retryCount + 1 });

  const result = await callWebhook(PAYMENT_SUCCESS_WEBHOOK_URL, item.payload || {
    orderId, gateway, code, status: 'success', verifyDetails, timestamp: new Date().toISOString(),
  }, { retries: 1 });

  if (result.ok) {
    paymentQueue.updateItem(id, { status: 'completed', completedAt: new Date().toISOString(), lastError: null });
    console.log(`[Queue] Webhook delivered — id=${id} orderId=${orderId}`);
    setImmediate(() => {
      sendPaymentSuccessNotificationToBale({ gateway, code, orderId }).catch(() => {});
    });
  } else {
    paymentQueue.updateItem(id, { lastError: result.error });
  }
}

// ─── POST /api/payments ───────────────────────────────────────────────────────

async function createPaymentRequest(req, res) {
  try {
    const body = req.body || {};
    const query = req.query || {};

    const orderId = body.orderId || query.orderId;
    const amount = body.amount !== undefined ? body.amount : query.amount;
    const mobile = body.mobile || query.mobile || '';
    const requestedGateway = body.gateway || query.gateway;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }
    if (amount === undefined || amount === null || amount === '') {
      return res.status(400).json({ error: 'amount is required' });
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({ error: 'Invalid amount value' });
    }

    const primaryGateway = resolveGateway(requestedGateway);
    const chain = buildGatewayChain(primaryGateway);

    console.log(`Creating payment: orderId=${orderId}, amount=${numericAmount}, gateway=${primaryGateway}, chain=[${chain.join(' → ')}]`);

    let attempt = null;
    for (let i = 0; i < chain.length; i++) {
      const gw = chain[i];
      const isLast = i === chain.length - 1;
      const tuning = isLast ? { timeout: GATEWAY_LAST_TIMEOUT_MS, retries: GATEWAY_LAST_RETRIES } : {};
      attempt = await attemptGatewayRequest(gw, { amount: numericAmount, orderId, mobile, ...tuning });
      console.log(`Gateway ${gw} (attempt ${i + 1}/${chain.length}): ok=${attempt.ok}`);
      if (attempt.ok) break;

      logPaymentEvent('payment_failover', {
        gateway: gw, orderId, reason: attempt.reason, next_gateway: chain[i + 1] || null,
      });
    }

    if (!attempt || !attempt.ok) {
      logPaymentEvent('payment_error', {
        error_source: 'gateway', gateway: attempt?.gateway || primaryGateway, orderId,
        reason: attempt?.reason || 'All payment gateways failed',
      });
      return res.status(400).json({
        error: 'Payment gateway error',
        message: attempt?.reason || 'All payment gateways failed',
      });
    }

    // Store session for amount lookup on callback (needed for Zarinpal verify)
    paymentSession.save(orderId, { amount: numericAmount, gateway: attempt.gateway, mobile });

    logPaymentEvent('payment_initiated', { gateway: attempt.gateway, orderId, amount: numericAmount });

    return res.status(200).json({
      targetUrl: attempt.targetUrl,
      gateway: attempt.gateway,
      orderId,
    });

  } catch (err) {
    console.error('createPaymentRequest error:', err);
    logPaymentEvent('payment_error', { error_source: 'server', reason: err.message });
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

// ─── GET|POST /api/payments/callback ─────────────────────────────────────────

async function handlePaymentCallback(req, res) {
  const params = { ...(req.body || {}), ...(req.query || {}) };
  const isRetryAttempt = params.retry === 'true' || params.retry === true;

  let { gateway, code, orderId: orderIdFromQuery } = parseGatewayParams(params);

  const sepStatus = params.Status || params.status;
  const sepState = params.State || params.state;
  const sepResNum = params.ResNum || params.resNum || params.resnum;
  const sepRefNum = params.RefNum || params.refNum || params.refnum;
  const isSepSignal = Boolean(sepStatus || sepState || sepResNum || sepRefNum);

  if ((!gateway || !code) && isSepSignal) {
    gateway = 'sep';
    if (!orderIdFromQuery && sepResNum) orderIdFromQuery = sepResNum;
    if (!code && sepRefNum) code = sepRefNum;
  }

  const buildRetryUrl = () => {
    const qs = new URLSearchParams(req.query).toString();
    return `${req.protocol}://${req.get('host')}/api/payments/callback${qs ? '?' + qs : ''}`;
  };

  if (!gateway || !code) {
    const isSepCancel = isSepSignal && !sepRefNum;
    const title = isSepCancel ? 'پرداخت لغو شد' : 'اطلاعات پرداخت ناقص است';
    const message = isSepCancel
      ? 'تراکنش توسط بانک لغو شد یا پرداخت توسط شما انصراف داده شد.'
      : 'اطلاعات لازم برای بررسی پرداخت در درخواست موجود نیست.';

    notifyBaleFailure({ title, message, error: `Missing gateway or code\nParams: ${JSON.stringify(params)}` });
    dispatchFailureWebhook({ orderId: orderIdFromQuery, gateway: gateway || 'unknown', code: code || '', reason: title });

    return res.status(400).send(renderErrorPage({
      title,
      message,
      retryCallbackUrl: null,
      showSupport: !isSepCancel,
      showRefundInfo: !isSepCancel,
    }));
  }

  // ── Zarinpal user cancel check ───────────────────────────────────────────
  if (gateway === 'zarinpal' && (params.Status === 'NOK' || params.status === 'NOK')) {
    logPaymentEvent('payment_warning', { gateway, orderId: orderIdFromQuery, reason: 'User cancelled' });
    dispatchFailureWebhook({ orderId: orderIdFromQuery, gateway, code, reason: 'User cancelled Zarinpal payment' });
    return res.status(400).send(renderErrorPage({
      title: 'تراکنش لغو شد',
      message: 'تراکنش توسط کاربر یا بانک متوقف شد.',
      retryCallbackUrl: null,
      showSupport: false,
    }));
  }

  // ── Webhook health check before verify ──────────────────────────────────
  if (PAYMENT_SUCCESS_WEBHOOK_URL) {
    const ping = await pingWebhook(PAYMENT_SUCCESS_WEBHOOK_URL);
    if (!ping.ok) {
      console.warn(`[Callback] Webhook health check failed — aborting verify. orderId=${orderIdFromQuery}`);
      logPaymentEvent('payment_warning', {
        gateway,
        orderId: orderIdFromQuery,
        reason: 'Webhook health check failed before verify',
      });
      setImmediate(() => {
        sendErrorNotificationToBale({
          title: 'وب‌هوک در دسترس نیست',
          message: 'پیش از verify درگاه، health check وب‌هوک شکست خورد.',
          gateway,
          code,
          orderId: orderIdFromQuery,
        }).catch(() => {});
      });
      return res.status(503).send(renderErrorPage({
        title: 'خطا در به‌روزرسانی اطلاعات',
        message: 'پرداخت شما در سیستم ثبت نشد. لطفاً با پشتیبانی تماس بگیرید تا وضعیت سفارش شما بررسی شود.',
        showSupport: true,
        showRefundInfo: false,
      }));
    }
  }

  // ── Verify with gateway ──────────────────────────────────────────────────
  let verifyOk = false;
  let verifyResult = null;
  let verifyDetails = {};

  const isZibal = gateway === 'zibal';
  const isZarinpal = gateway === 'zarinpal';
  const isSep = gateway === 'sep';

  if (isZibal) {
    verifyResult = await zibalVerifyPayment(code);
    verifyOk = verifyResult && (verifyResult.result === 100 || verifyResult.result === 201);
    if (verifyOk) {
      verifyDetails = {
        paid_at: verifyResult.paidAt,
        card_number: verifyResult.cardNumber,
        ref_number: verifyResult.refNumber,
        description: verifyResult.description,
        zibal_result: verifyResult.result,
        zibal_message: verifyResult.message,
        zibal_status: verifyResult.status,
        zibal_order_id: verifyResult.orderId,
        zibal_amount: verifyResult.amount,
      };
    }

  } else if (isZarinpal) {
    const session = paymentSession.get(orderIdFromQuery);
    const amount = session?.amount;
    if (!amount) {
      console.warn(`[Callback] No session found for orderId=${orderIdFromQuery} — cannot verify Zarinpal`);
      const errorDetails = {
        title: 'خطا در تأیید پرداخت',
        message: 'نشست پرداخت منقضی شده یا یافت نشد. لطفاً با پشتیبانی تماس بگیرید.',
        gateway, code, orderId: orderIdFromQuery,
      };
      notifyBaleFailure(errorDetails);
      return res.status(400).send(renderErrorPage({
        title: errorDetails.title,
        message: errorDetails.message,
        showSupport: true,
      }));
    }
    verifyResult = await zarinpalVerifyPayment(code, amount);
    verifyOk = verifyResult?.data && (verifyResult.data.code === 100 || verifyResult.data.code === 101);
    if (verifyOk) {
      verifyDetails = {
        card_number: verifyResult.data?.card_pan,
        ref_number: verifyResult.data?.ref_id,
        zarinpal_code: verifyResult.data?.code,
        zarinpal_message: verifyResult.data?.message,
        zarinpal_fee: verifyResult.data?.fee,
        zarinpal_fee_type: verifyResult.data?.fee_type,
      };
    }

  } else if (isSep) {
    const sepCallbackOk = isSepCallbackConfirmed(params);
    if (!sepCallbackOk) {
      verifyOk = false;
      const gatewayErrorDesc = extractSepGatewayErrorDesc(params);
      const cancelReason = buildSepCallbackCancelReason(params);
      verifyResult = {
        Success: false, sepCallbackRejected: true,
        ResultDescription: gatewayErrorDesc || cancelReason,
        cancelReason, gatewayErrorDesc,
        sepState: params.State || params.state,
        sepStatus: params.Status || params.status,
      };
    } else {
      const refNumToVerify = params.RefNum || params.refNum || params.refnum || code;
      try {
        verifyResult = await sepVerifyPayment(refNumToVerify);
        verifyOk = verifyResult?.Success === true;
      } catch (err) {
        verifyOk = false;
        verifyResult = { Success: false, ResultDescription: `Verify exception: ${err.message}` };
      }
    }
    if (verifyOk) {
      verifyDetails = buildSepVerifyDetails(params, verifyResult);
    }
  }

  const orderId = orderIdFromQuery || '';

  // ── Payment failed ───────────────────────────────────────────────────────
  if (!verifyOk) {
    let gatewayErrorMsg = null;
    if (isZarinpal && verifyResult?.data) {
      gatewayErrorMsg = verifyResult.data.message || null;
    } else if (isSep) {
      gatewayErrorMsg = verifyResult?.gatewayErrorDesc || verifyResult?.cancelReason || verifyResult?.ResultDescription || null;
    }

    const isSepCancel = isSep && verifyResult?.sepCallbackRejected;

    if (isSepCancel) {
      const cancelReason = verifyResult?.cancelReason || 'نامشخص';
      await sendWarningNotificationToBale({
        title: 'انصراف یا رد پرداخت SEP',
        gateway, code, orderId, cancelReason,
        sepState: verifyResult?.sepState,
        sepStatus: verifyResult?.sepStatus,
        gatewayErrorDesc: verifyResult?.gatewayErrorDesc,
      });
      logPaymentEvent('payment_warning', {
        error_source: 'gateway', gateway, orderId,
        reason: gatewayErrorMsg || cancelReason,
        cancel_reason: cancelReason,
      });
    } else {
      notifyBaleFailure({
        title: 'تأیید پرداخت ناموفق بود',
        message: gatewayErrorMsg || 'Gateway verification failed',
        gateway, code, orderId, verifyResult,
      });
      logPaymentEvent('payment_error', {
        error_source: 'gateway', gateway, orderId,
        reason: gatewayErrorMsg || 'Verification failed',
      });
    }

    dispatchFailureWebhook({ orderId, gateway, code, reason: gatewayErrorMsg || 'Verification failed' });

    let errorMessage;
    if (isSep && verifyResult?.sepCallbackRejected) {
      const reasonText = verifyResult?.gatewayErrorDesc || verifyResult?.cancelReason || 'نامشخص';
      errorMessage = `پرداخت تأیید نشد — دلیل: ${reasonText}. در صورت کسر مبلغ ظرف ۷۲ ساعت برگشت می‌خورد.`;
    } else if (isRetryAttempt) {
      errorMessage = 'متأسفانه سرویس درگاه پرداخت موقتاً در دسترس نیست. برای پیگیری با پشتیبانی تماس بگیرید.';
    } else {
      errorMessage = gatewayErrorMsg || 'در تایید پرداخت از سمت درگاه خطا رخ داد. در صورت کسر مبلغ ظرف ۷۲ ساعت برگشت می‌خورد.';
    }

    return res.status(400).send(renderErrorPage({
      title: 'تأیید پرداخت ناموفق بود',
      message: errorMessage,
      showSupport: isRetryAttempt,
      showRefundInfo: !String(errorMessage).includes('۷۲ ساعت'),
    }));
  }

  // ── Payment successful ───────────────────────────────────────────────────
  logPaymentEvent('payment_success', { gateway, orderId, code });

  // Clean up session
  if (orderId) paymentSession.remove(orderId);

  // Dispatch success webhook (async, with retry queue)
  await dispatchSuccessWebhook({ orderId, gateway, code, verifyDetails });

  // Non-blocking success notification
  setImmediate(() => {
    sendPaymentSuccessNotificationToBale({ gateway, code, orderId }).catch(() => {});
  });

  // Redirect to success URL
  const successUrl = FRONT_SUCCESS_URL || frontUrl('/payment/success') || '/';
  return res.redirect(302, successUrl);
}

// ─── GET /api/payments/sep-callback-debug ────────────────────────────────────

async function handleSepCallbackDebug(req, res) {
  const allData = {
    method: req.method, query: req.query, body: req.body,
    headers: { 'content-type': req.headers['content-type'], referer: req.headers['referer'] },
    timestamp: new Date().toISOString(),
  };
  console.log('[SEP Callback Debug]', JSON.stringify(allData, null, 2));

  const refNum = req.query.RefNum || req.query.refnum || req.body?.RefNum || req.body?.refnum;
  const resNum = req.query.ResNum || req.query.resnum || req.body?.ResNum || req.body?.resnum;

  if (!refNum) {
    return res.status(400).json({ error: 'RefNum not found', received: allData });
  }

  req.query.RefNum = refNum;
  if (resNum) req.query.ResNum = resNum;
  req.query.Status = req.query.Status || req.body?.Status || '1';
  return handlePaymentCallback(req, res);
}

// ─── GET /api/payments/admin/verify-only ─────────────────────────────────────

async function adminVerifyOnly(req, res) {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { gateway, code, refNum, RefNum } = req.query;
  if (!gateway || !code) {
    return res.status(400).json({ error: 'gateway and code are required' });
  }

  let verifyResult;
  try {
    if (gateway === 'zibal') {
      verifyResult = await zibalVerifyPayment(Number(code));
      const verified = verifyResult && (verifyResult.result === 100 || verifyResult.result === 201);
      if (!verified) return res.status(400).json({ success: false, verified: false, gateway, code, verifyResult });
    } else if (gateway === 'zarinpal') {
      const amount = Number(req.query.amount || 1);
      verifyResult = await zarinpalVerifyPayment(String(code), amount);
      const verified = verifyResult?.data && (verifyResult.data.code === 100 || verifyResult.data.code === 101);
      if (!verified) return res.status(400).json({ success: false, verified: false, gateway, code, verifyResult });
    } else if (gateway === 'sep') {
      const sepRefNum = RefNum || refNum || code;
      verifyResult = await sepVerifyPayment(String(sepRefNum));
      const verified = verifyResult?.Success === true;
      if (!verified) return res.status(400).json({ success: false, verified: false, gateway, code, verifyResult });
    } else {
      return res.status(400).json({ error: 'Unsupported gateway', validGateways: VALID_GATEWAYS });
    }
  } catch (err) {
    return res.status(502).json({ error: 'Gateway verification failed', message: err.message });
  }

  return res.json({ success: true, verified: true, gateway, code, verifyResult });
}

// ─── POST /api/payments/admin/trigger-webhook ────────────────────────────────

async function adminTriggerWebhook(req, res) {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { orderId, gateway, code, verifyDetails } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });

  const payload = {
    orderId,
    gateway: gateway || 'manual',
    code: code || '',
    status: 'success',
    verifyDetails: verifyDetails || {},
    timestamp: new Date().toISOString(),
    source: 'admin-trigger',
  };

  const result = await callWebhook(PAYMENT_SUCCESS_WEBHOOK_URL, payload);
  if (result.ok) {
    return res.json({ success: true, orderId, webhookStatus: result.status });
  }
  return res.status(502).json({ success: false, error: result.error || 'Webhook failed', orderId });
}

// ─── SEP Refund APIs ──────────────────────────────────────────────────────────

async function adminSepRefundReg(req, res) {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { refNum, resNum, amount, requestId, exeTime, email, cellNumber, documentDescription, dicData } = req.body || {};
  if (!refNum || !resNum || !amount || !requestId) {
    return res.status(400).json({ error: 'Missing required fields: refNum, resNum, amount, requestId' });
  }
  const result = await sepRefundReg({ refNum, resNum, amount, requestId, exeTime, email, cellNumber, documentDescription, dicData });
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundExec(req, res) {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { partialRefundId, typRefundAction } = req.body || {};
  if (!partialRefundId || !typRefundAction) {
    return res.status(400).json({ error: 'Missing required fields: partialRefundId, typRefundAction' });
  }
  const result = await sepRefundExec({ partialRefundId, typRefundAction });
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundList(req, res) {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const result = await sepGetDailyRefundList();
  res.status(result.status).type('application/xml').send(result.data);
}

async function adminSepRefundStatus(req, res) {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { refundId } = req.body || {};
  if (!refundId) return res.status(400).json({ error: 'Missing required field: refundId' });
  const result = await sepGetRefundStatus({ refundId });
  res.status(result.status).type('application/xml').send(result.data);
}

module.exports = {
  createPaymentRequest,
  handlePaymentCallback,
  handleSepCallbackDebug,
  adminVerifyOnly,
  adminTriggerWebhook,
  adminSepRefundReg,
  adminSepRefundExec,
  adminSepRefundList,
  adminSepRefundStatus,
  processQueuedWebhook,
};
