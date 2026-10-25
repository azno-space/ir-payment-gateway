// Classification of SEP's two separate refund error vocabularies, from the refund
// service doc v3.14 (ErrorCode table page 38, RefundStatusDetail table pages 36-37).
//
// They are genuinely different layers and conflating them is how a refund goes silent:
//   - ErrorCode comes back from Refund_Reg itself — the request was or was not accepted.
//   - RefundStatusDetail appears later, in the reports, and describes what happened when
//     SEP tried to actually move the money. A refund can be accepted and still fail here.
//
// Every entry answers three questions, because an alert that only names the error still
// leaves someone to work out what to do at 2am:
//   action — what the job does automatically
//   owner  — who has to act, if anyone
//   remedy — the actual next step, in words the person on call can follow
//
// When a new SEP code shows up in production, add it here with its remedy rather than
// leaving it to the unknown-code fallback. That is the one place this file grows.

const ACTION = {
  RETRY: 'retry',                     // transient — next tick, no alert, no human
  WAIT_FOR_SEP: 'wait_for_sep',       // SEP itself is still working on it; never re-register
  DONE: 'done',                       // already refunded — close the record
  MANUAL: 'manual',                   // this customer's money must go back by hand
  MERCHANT_FUNDS: 'merchant_funds',   // OUR refund card/wallet is empty or capped
  SYSTEM: 'system',                   // our credentials/params/IP — blocks every refund
  NEEDS_BREAKABLE: 'needs_breakable', // amount over SEP's single-transaction cap
  REFRESH: 'refresh',                 // SEP failed it, but the request can be reset to Start
};

// Who is expected to act. Drives whether the alert carries the customer's contact
// details or the operational ones.
const OWNER = {
  NOBODY: 'nobody',
  OPS: 'ops',                 // the merchant's finance/ops — top up, wait, retry tomorrow
  DEV: 'dev',                 // a bug or misconfiguration on our side
  SEP_SUPPORT: 'sep_support', // needs a ticket/call to Saman
  CUSTOMER: 'customer',       // call the customer for new card details
};

// Refund_Reg / Refund_Exec response ErrorCode (doc page 38).
const REG_ERRORS = {
  Success: {
    action: ACTION.DONE, owner: OWNER.NOBODY,
    message: 'درخواست با موفقیت ثبت شد',
    remedy: 'کاری لازم نیست.',
  },
  Unknown: {
    action: ACTION.RETRY, owner: OWNER.NOBODY,
    message: 'خطای ناشناخته سپ',
    remedy: 'خودکار در تیک بعدی دوباره تلاش می‌شود. اگر تکرار شد، از سپ پیگیری کنید.',
  },
  ObjectNotFound: {
    action: ACTION.RETRY, owner: OWNER.NOBODY,
    // Measured 2026-08-16: SEP does not know the transaction for roughly its first hour.
    message: 'تراکنش هنوز نزد سپ قابل استرداد نیست',
    remedy: 'کاری لازم نیست — سپ حدود یک ساعت اول بعد از پرداخت استرداد را نمی‌پذیرد. جاب خودش بعداً دوباره تلاش می‌کند.',
  },
  TxnIsProcessing: {
    action: ACTION.RETRY, owner: OWNER.NOBODY,
    message: 'درخواست دیگری با همین مشخصات در حال ثبت است',
    remedy: 'کاری لازم نیست — تیک بعدی دوباره تلاش می‌کند.',
  },

  DuplicateRequest: {
    action: ACTION.WAIT_FOR_SEP, owner: OWNER.NOBODY,
    message: 'این درخواست قبلاً ثبت شده است',
    remedy: 'کاری لازم نیست — دوباره ثبت نمی‌کنیم (ریسک استرداد مضاعف). جاب تطبیق، رکورد را از گزارش سپ می‌بندد.',
  },
  TransactionStateisFinal: {
    action: ACTION.WAIT_FOR_SEP, owner: OWNER.NOBODY,
    message: 'درخواست استرداد نهایی شده و قابل تغییر نیست',
    remedy: 'کاری لازم نیست — جاب تطبیق وضعیت نهایی را از گزارش سپ می‌خواند.',
  },

  InvalidParameter: {
    action: ACTION.SYSTEM, owner: OWNER.DEV,
    message: 'پارامترهای ارسالی به سپ نامعتبر است',
    remedy: 'باگ سمت ماست. لاگ سرویس پرداخت را ببینید: refNum/resNum/amount/requestId چه چیزی فرستاده شده. تا رفع نشود هیچ استردادی انجام نمی‌شود.',
  },
  AuthenticateUserFail: {
    action: ACTION.SYSTEM, owner: OWNER.DEV,
    message: 'نام کاربری یا رمز سپ اشتباه است',
    remedy: 'مقادیر SEP_USERNAME و SEP_PASSWORD را در env سرویس ir-payment-gateway بررسی کنید. اگر درست بودند، احتمالاً رمز از سمت سپ عوض شده — با پشتیبانی سپ تماس بگیرید.',
  },
  PermissionDenied: {
    action: ACTION.SYSTEM, owner: OWNER.SEP_SUPPORT,
    message: 'اجازه اجرای درخواست وجود ندارد',
    // The doc itself prescribes this one.
    remedy: 'طبق مستند سپ باید با ادمین سیستم سپ تماس بگیرید و دسترسی سرویس استرداد این ترمینال را فعال کنید.',
  },
  ClientIPIsNotValid: {
    action: ACTION.SYSTEM, owner: OWNER.SEP_SUPPORT,
    message: 'آی‌پی سرور نزد سپ مجاز نیست',
    remedy: 'آی‌پی خروجی سرور ir-payment-gateway در لیست سفید سپ نیست. آی‌پی فعلی را برای سپ بفرستید (تیکت/ایمیل) تا در whitelist ترمینال استرداد ثبت شود. معمولاً بعد از تغییر سرور یا آی‌پی پیش می‌آید.',
  },

  OriginalAmountIncorrect: {
    action: ACTION.MANUAL, owner: OWNER.OPS,
    message: 'جمع مبالغ استرداد از مبلغ تراکنش اصلی بیشتر است',
    remedy: 'یعنی قبلاً بخشی از این تراکنش برگشت خورده. در پنل سپ استردادهای قبلی همین تراکنش را ببینید و فقط باقیمانده را دستی برگردانید.',
  },
  NonDepositableDestinationPanCard: {
    action: ACTION.MANUAL, owner: OWNER.CUSTOMER,
    message: 'کارت مقصد قابل واریز نیست (مثلاً گیفت‌کارت)',
    remedy: 'با مشتری تماس بگیرید و یک شماره کارت یا شبای دیگر (غیر گیفت‌کارت) بگیرید، سپس مبلغ را دستی واریز کنید.',
  },
};

// RefundStatusDetail from the reports (doc pages 36-37) — why an accepted refund did
// not complete. Only consulted for requests whose overall status is Fail/Cancel/None.
const EXEC_FAILURES = {
  '101': {
    action: ACTION.DONE, owner: OWNER.NOBODY,
    message: 'عملیات استرداد با موفقیت انجام شد',
    remedy: 'کاری لازم نیست.',
  },
  '118': {
    action: ACTION.DONE, owner: OWNER.NOBODY,
    message: 'استرداد قبلاً انجام شده است',
    remedy: 'کاری لازم نیست — رکورد بسته شد. پول قبلاً برگشته.',
  },

  // Ours, not the customer's. These block every refund until fixed, and SEP resumes on
  // its own afterwards — so the fix is operational, not technical.
  '102': {
    action: ACTION.MERCHANT_FUNDS, owner: OWNER.OPS,
    message: 'موجودی کارت استرداد کافی نیست',
    remedy: 'کارت استردادِ ثبت‌شده نزد سپ را شارژ کنید. بعد از شارژ، سپ خودش در سیکل بعدی دوباره تلاش می‌کند و نیازی به ثبت مجدد نیست.',
  },
  '105': {
    action: ACTION.MERCHANT_FUNDS, owner: OWNER.OPS,
    message: 'سقف برداشت روزانه کارت استرداد رعایت نشده',
    remedy: 'سقف روزانه کارت پر شده. یا تا فردا صبر کنید (سپ خودش دوباره تلاش می‌کند)، یا کارت دیگری به ترمینال استرداد اضافه کنید، یا از بانک افزایش سقف بگیرید.',
  },
  '119': {
    action: ACTION.MERCHANT_FUNDS, owner: OWNER.OPS,
    message: 'همه کارت‌ها در روز مالی جاری پر شده‌اند',
    remedy: 'ظرفیت همه کارت‌های استرداد برای امروز تمام شده. کارت جدید اضافه کنید یا تا روز مالی بعد صبر کنید — سپ خودش ادامه می‌دهد.',
  },
  '121': {
    action: ACTION.MERCHANT_FUNDS, owner: OWNER.OPS,
    message: 'موجودی ولت کافی نیست',
    remedy: 'ولت استرداد را شارژ کنید. بعد از شارژ سپ خودش دوباره تلاش می‌کند.',
  },
  '117': {
    action: ACTION.MERCHANT_FUNDS, owner: OWNER.SEP_SUPPORT,
    message: 'کارت فعالی برای استرداد یافت نشد',
    remedy: 'هیچ کارت فعالی روی ترمینال استرداد ثبت نیست. با سپ تماس بگیرید و کارت استرداد را ثبت/فعال کنید.',
  },

  '106': {
    action: ACTION.MANUAL, owner: OWNER.CUSTOMER,
    message: 'کارت مقصد برای واریز معتبر نیست',
    remedy: 'کارت مشتری برای واریز مناسب نیست (منقضی، مسدود، یا غیرقابل واریز). با مشتری تماس بگیرید، شماره کارت یا شبای دیگری بگیرید و دستی واریز کنید.',
  },
  '113': {
    action: ACTION.MANUAL, owner: OWNER.OPS,
    message: 'کارت مبدأ معتبر نیست',
    remedy: 'کارت مبدأ (کارت استرداد خودمان) نامعتبر است. وضعیت کارت ثبت‌شده نزد سپ را بررسی کنید؛ اگر منقضی شده باید تعویض شود.',
  },
  '116': {
    action: ACTION.MANUAL, owner: OWNER.SEP_SUPPORT,
    message: 'تعداد تلاش‌های استرداد از حد مجاز گذشته است',
    remedy: 'سپ اجازه تلاش مجدد روی این درخواست را نمی‌دهد. با پشتیبانی سپ تماس بگیرید و شناسه استرداد را بدهید؛ در این فاصله مبلغ را دستی برگردانید.',
  },

  '120': {
    action: ACTION.NEEDS_BREAKABLE, owner: OWNER.DEV,
    message: 'مبلغ از سقف یک تراکنش استرداد بیشتر است',
    remedy: 'این مبلغ باید خرد شود. یا از متد Refund_Reg_Breakable استفاده شود (که خودکار به تراکنش‌های زیر سقف می‌شکند)، یا فعلاً دستی در چند نوبت واریز شود.',
  },

  // Originally classified WAIT_FOR_SEP on the assumption that SEP retries these on its
  // own. DISPROVEN 2026-08-17: a real refund hit code 114 on
  // 2026-08-05 (overall RefundStatus=Fail) and sat completely untouched for 12 days —
  // zero further attempts. An overall status of Fail means SEP has already given up on
  // that attempt, whatever the detail code claims; only Start/InProgress means it is
  // still working on it, and that check already happens one level up (on
  // refundStatusCode, before classifyExecFailure is even called). So none of these are
  // safe to leave silent. Route to a human — never re-register (double-refund risk).
  '112': {
    action: ACTION.MANUAL, owner: OWNER.SEP_SUPPORT,
    message: 'خطای قطع ارتباط هنگام اجرای استرداد',
    remedy: 'در پنل سپ با همین شناسه استرداد وضعیت را ببینید. اگر واقعاً متوقف مانده، از پشتیبانی سپ پیگیری کنید یا مبلغ را دستی واریز کنید.',
  },
  // The one exec failure with a proven automatic remedy. Measured 2026-09-22 against
  // production: refreshing a same-day 114 moved it from Fail back to Start ("درخواست با
  // موفقیت انجام شد"), while a three-day-old one came back RefundRequestIsClosed — SEP
  // closes a failed request after a while, so the refresh is worth trying but is not
  // guaranteed, and the job falls back to a human when it is refused or keeps failing.
  // Only 114 gets this: SEP warns a refresh can double-pay when the previous attempt's
  // real outcome is unknown, which is exactly what 112/115/122 describe.
  '114': {
    action: ACTION.REFRESH, owner: OWNER.SEP_SUPPORT,
    message: 'خطای ناشناخته سپ هنگام اجرای استرداد',
    remedy: 'جاب خودش درخواست را نزد سپ رفرش می‌کند تا دوباره در صف اجرا قرار بگیرد. اگر سپ رفرش را نپذیرد یا بعد از چند بار باز هم شکست بخورد، همین‌جا به شما اطلاع داده می‌شود تا دستی واریز کنید.',
  },
  '115': {
    action: ACTION.MANUAL, owner: OWNER.SEP_SUPPORT,
    message: 'خطای سوییچ بانکی هنگام اجرای استرداد',
    remedy: 'در پنل سپ با همین شناسه استرداد وضعیت را ببینید. اگر متوقف مانده، از پشتیبانی سپ پیگیری کنید یا مبلغ را دستی واریز کنید.',
  },
  '122': {
    action: ACTION.MANUAL, owner: OWNER.SEP_SUPPORT,
    message: 'درخواست به بانک ارسال شده ولی نتیجه نامعلوم است',
    remedy: 'در پنل سپ با همین شناسه استرداد وضعیت را ببینید. اگر واقعاً متوقف مانده، از پشتیبانی سپ پیگیری کنید یا مبلغ را دستی واریز کنید.',
  },
};

// An unmapped code must never be silently swallowed: default to telling a human, since
// the alternative is a customer whose money quietly never arrives.
function classifyRegError(errorCode) {
  return (
    REG_ERRORS[errorCode] || {
      action: ACTION.MANUAL,
      owner: OWNER.DEV,
      message: `کد خطای ثبت که هنوز در سیستم تعریف نشده: ${errorCode}`,
      remedy:
        `این کد در جدول خطاهای ما نیست. در مستند سرویس استرداد سپ (جدول ErrorCode) معنی‌اش را پیدا کنید، ` +
        `مبلغ را فعلاً دستی برگردانید، و کد را با راه‌حلش به src/sep/refundErrors.js اضافه کنید.`,
    }
  );
}

function classifyExecFailure(statusDetailCode) {
  return (
    EXEC_FAILURES[String(statusDetailCode)] || {
      action: ACTION.MANUAL,
      owner: OWNER.DEV,
      message: `کد خطای اجرا که هنوز در سیستم تعریف نشده: ${statusDetailCode}`,
      remedy:
        `این کد در جدول RefundStatusDetail ما نیست. در مستند سپ معنی‌اش را پیدا کنید، ` +
        `مبلغ را فعلاً دستی برگردانید، و کد را با راه‌حلش به src/sep/refundErrors.js اضافه کنید.`,
    }
  );
}

module.exports = { ACTION, OWNER, REG_ERRORS, EXEC_FAILURES, classifyRegError, classifyExecFailure };
