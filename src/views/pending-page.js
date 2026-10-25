const FRONT_BASE_URL = process.env.FRONT_BASE_URL || '';
const frontUrl = (p) => `${FRONT_BASE_URL}${p}`;

function renderPendingPage({ code, gateway, retryCallbackUrl, message } = {}) {
  const shortCode = code ? String(code).slice(0, 50) : null;
  const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '';
  const SUPPORT_URL = process.env.SUPPORT_URL || '';

  const supportHtml = SUPPORT_PHONE
    ? `<a href="tel:${SUPPORT_PHONE}" class="support-link">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
        </svg>
        ${SUPPORT_PHONE}
       </a>`
    : (SUPPORT_URL ? `<a href="${SUPPORT_URL}" target="_blank" class="support-link">تماس با پشتیبانی</a>` : '');

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>پرداخت در حال پردازش</title>
  <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4278DF; --primary-dark: #2159C4; --black: #2B456E;
      --dark-gray: #667A99; --gray: #A3AFC2; --light-1: #E5E9F0; --light-3: #F5F7FA;
      --yellow: #F59E0B; --yellow-dark: #B45309; --yellow-light: #FFFBEB;
      --green-light: #E4F7F7; --green-dark: #1AA7A8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Vazirmatn', sans-serif; }
    body {
      background-color: var(--light-3);
      background-image: radial-gradient(var(--light-1) 1px, transparent 1px);
      background-size: 20px 20px;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 20px; color: var(--black);
      opacity: 0; animation: fadeIn 0.8s forwards;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .card {
      background: #fff; max-width: 480px; width: 100%; border-radius: 28px; padding: 40px 32px;
      text-align: center; box-shadow: 0 20px 40px rgba(43,69,110,0.08); border: 1px solid var(--light-1);
      opacity: 0; transform: translateY(30px) scale(0.95);
      animation: cardEntrance 0.6s cubic-bezier(0.34,1.56,0.64,1) 0.3s forwards;
    }
    @keyframes cardEntrance {
      0% { opacity:0; transform:translateY(30px) scale(0.95); }
      100% { opacity:1; transform:translateY(0) scale(1); }
    }
    .icon-wrapper {
      width: 88px; height: 88px; background: var(--yellow-light); color: var(--yellow);
      border-radius: 24px; display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
      animation: pulseRing 2s ease-in-out 1.5s infinite;
    }
    @keyframes pulseRing {
      0%,100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.25); }
      50% { box-shadow: 0 0 0 14px rgba(245,158,11,0); }
    }
    h1 { font-size: 21px; font-weight: 700; color: var(--black); margin-bottom: 18px; line-height: 1.5; }
    .warn-box {
      border-right: 4px solid var(--yellow); background: var(--yellow-light);
      padding: 16px; border-radius: 12px; margin-bottom: 18px; text-align: right;
    }
    .warn-box p { color: var(--yellow-dark); font-size: 14px; line-height: 1.75; }
    .success-box {
      background: var(--green-light); padding: 14px; border-radius: 12px;
      margin-bottom: 24px; display: flex; align-items: flex-start; gap: 10px; text-align: right;
    }
    .success-box span { color: var(--green-dark); font-size: 13px; line-height: 1.6; }
    .code-box {
      background: var(--light-3); border: 1px solid var(--light-1);
      border-radius: 12px; padding: 12px 16px; margin-bottom: 24px;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .code-label { font-size: 12px; color: var(--gray); white-space: nowrap; }
    .code-value { font-size: 12px; color: var(--dark-gray); font-weight: 600; word-break: break-all; text-align: left; direction: ltr; }
    .btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 16px; border-radius: 14px; text-decoration: none;
      font-weight: 700; font-size: 16px; background: var(--primary); color: #fff;
      box-shadow: 0 8px 20px rgba(66,120,223,0.25); transition: all 0.3s ease; margin-bottom: 12px;
    }
    .btn:hover { background: var(--primary-dark); transform: translateY(-2px); }
    .footer { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--light-1); }
    .footer p { font-size: 12px; color: var(--gray); margin-bottom: 6px; line-height: 1.6; }
    .support-link {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--primary); font-weight: 700; text-decoration: none;
      font-size: 14px; margin-top: 4px; padding: 6px 10px; border-radius: 8px;
      transition: background 0.2s ease;
    }
    .support-link:hover { background: rgba(66,120,223,0.08); }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-wrapper">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
    </div>
    <h1>پرداخت در حال پردازش</h1>
    <div class="warn-box">
      <p>${message || 'پرداخت شما توسط بانک تأیید شده، اما به دلیل <strong>اختلال موقت</strong>، ثبت آن چند دقیقه‌ای به تأخیر افتاده است.'}</p>
    </div>
    <div class="success-box">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--green-dark)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <span>سیستم به‌صورت <strong>خودکار</strong> وضعیت پرداخت را پردازش می‌کند. لطفاً چند دقیقه صبر کنید.</span>
    </div>
    ${shortCode
      ? `<div class="code-box">
          <span class="code-label">کد پیگیری:</span>
          <span class="code-value">${shortCode}</span>
        </div>`
      : ''}
    ${retryCallbackUrl
      ? `<a href="${retryCallbackUrl}" class="btn">تلاش مجدد</a>`
      : (FRONT_BASE_URL ? `<a href="${frontUrl('/')}" class="btn">بازگشت به پنل کاربری</a>` : '')}
    ${supportHtml
      ? `<div class="footer">
          <p>اگر پس از ۱۵ دقیقه وضعیت به‌روزرسانی نشد، با پشتیبانی تماس بگیرید:</p>
          ${supportHtml}
        </div>`
      : ''}
  </div>
</body>
</html>`;
}

module.exports = { renderPendingPage };
