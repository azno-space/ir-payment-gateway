const FRONT_BASE_URL = process.env.FRONT_BASE_URL || '';
const frontUrl = (p) => `${FRONT_BASE_URL}${p}`;
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '';
const SUPPORT_URL = process.env.SUPPORT_URL || '';

function renderErrorPage({
  title,
  message,
  retryCallbackUrl,
  showSupport = false,
  showRefundInfo = true,
}) {
  const supportHtml = showSupport && (SUPPORT_PHONE || SUPPORT_URL)
    ? `<div class="footer-support">
        <p style="font-size: 13px; color: var(--dark-gray);">نیاز به پشتیبانی دارید؟</p>
        ${SUPPORT_PHONE
          ? `<a href="tel:${SUPPORT_PHONE}" class="support-link">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              ${SUPPORT_PHONE}
             </a>`
          : ''}
        ${SUPPORT_URL
          ? `<a href="${SUPPORT_URL}" target="_blank" class="support-link">تماس با پشتیبانی</a>`
          : ''}
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || 'خطا در پرداخت'}</title>
  <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4278DF;
      --primary-dark: #2159C4;
      --blue-medium: #A1BCEF;
      --black: #2B456E;
      --dark-gray: #667A99;
      --gray: #A3AFC2;
      --light-1: #E5E9F0;
      --light-3: #F5F7FA;
      --red: #F86F8C;
      --red-dark: #F52E58;
      --red-light: #FEEDF1;
      --green-light: #E4F7F7;
      --green-dark: #1AA7A8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Vazirmatn', sans-serif; }
    body {
      background-color: var(--light-3);
      background-image: radial-gradient(var(--light-1) 1px, transparent 1px);
      background-size: 20px 20px;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 20px; color: var(--black);
      opacity: 0; animation: fadeIn 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .error-card {
      background: #fff; max-width: 480px; width: 100%;
      border-radius: 28px; padding: 40px 32px; text-align: center;
      box-shadow: 0 20px 40px rgba(43, 69, 110, 0.08); border: 1px solid var(--light-1);
      opacity: 0; transform: translateY(30px) scale(0.95);
      animation: cardEntrance 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.3s forwards;
    }
    @keyframes cardEntrance {
      0% { opacity: 0; transform: translateY(30px) scale(0.95); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    .icon-wrapper {
      width: 88px; height: 88px; background: var(--red-light); color: var(--red-dark);
      border-radius: 24px; display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
    }
    h1 { font-size: 24px; font-weight: 700; color: var(--black); margin-bottom: 16px; }
    .error-box {
      border-right: 4px solid var(--red); background: var(--light-3);
      padding: 16px; border-radius: 12px; margin-bottom: 24px; text-align: right;
    }
    .error-box p { color: var(--red-dark); font-weight: 500; font-size: 15px; }
    .info-box {
      background: var(--green-light); padding: 14px; border-radius: 12px;
      margin-bottom: 32px; display: flex; align-items: flex-start; gap: 10px; text-align: right;
    }
    .info-box span { color: var(--green-dark); font-size: 13px; line-height: 1.6; }
    .actions { display: flex; flex-direction: column; gap: 12px; justify-content: center; }
    @media (min-width: 640px) { .actions { flex-direction: row; } .btn { flex: 1; } }
    .btn {
      padding: 16px; border-radius: 14px; text-decoration: none;
      font-weight: 700; font-size: 16px; transition: all 0.3s ease;
      display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
    }
    .btn-main { background: var(--primary); color: #fff; box-shadow: 0 8px 20px rgba(66, 120, 223, 0.25); }
    .btn-main:hover { background: var(--primary-dark); transform: translateY(-3px); }
    .btn-secondary { background: #fff; color: var(--dark-gray); border: 2px solid var(--light-1); }
    .btn-secondary:hover { border-color: var(--blue-medium); color: var(--primary); transform: translateY(-2px); }
    .footer-support {
      margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--light-1);
    }
    .support-link {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--primary); font-weight: 700; text-decoration: none;
      margin-top: 8px; padding: 4px 8px; border-radius: 8px; transition: all 0.2s ease;
    }
    .support-link:hover { background: rgba(66, 120, 223, 0.08); }
  </style>
</head>
<body>
  <div class="error-card">
    <div class="icon-wrapper">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
    </div>
    <h1>${title || 'خطا در عملیات پرداخت'}</h1>
    <div class="error-box">
      <p>${message || 'تراکنش توسط کاربر یا بانک متوقف شد.'}</p>
    </div>
    ${showRefundInfo
      ? `<div class="info-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--green-dark)" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <span>اگر مبلغی از حساب شما کسر شده، نهایتاً تا ۷۲ ساعت آینده به صورت خودکار بازگردانده می‌شود.</span>
        </div>`
      : ''}
    <div class="actions">
      <a href="${retryCallbackUrl || frontUrl('/') || '/'}" class="btn btn-main">
        ${retryCallbackUrl ? 'تلاش مجدد برای تأیید پرداخت' : 'بازگشت به صفحه اصلی'}
      </a>
      ${retryCallbackUrl
        ? `<a href="${frontUrl('/') || '/'}" class="btn btn-secondary">بازگشت به پنل کاربری</a>`
        : ''}
    </div>
    ${supportHtml}
  </div>
</body>
</html>`;
}

module.exports = { renderErrorPage };
