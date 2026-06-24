const FRONT_SUCCESS_URL = process.env.FRONT_SUCCESS_URL || '';
const FRONT_BASE_URL = process.env.FRONT_BASE_URL || '';

function renderSuccessPage({ orderId, gateway, code } = {}) {
  const redirectUrl = FRONT_SUCCESS_URL || (FRONT_BASE_URL ? `${FRONT_BASE_URL}/payment/success` : null);

  if (redirectUrl) {
    const url = new URL(redirectUrl);
    if (orderId) url.searchParams.set('orderId', String(orderId));
    if (gateway) url.searchParams.set('gateway', String(gateway));
    if (code) url.searchParams.set('code', String(code));
    return { redirect: url.toString() };
  }

  return { html: buildSuccessHtml({ orderId }) };
}

function buildSuccessHtml({ orderId } = {}) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>پرداخت موفق</title>
  <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4278DF; --primary-dark: #2159C4; --black: #2B456E;
      --dark-gray: #667A99; --light-1: #E5E9F0; --light-3: #F5F7FA;
      --green: #10B981; --green-dark: #059669; --green-light: #D1FAE5;
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
      background: #fff; max-width: 400px; width: 100%; border-radius: 28px; padding: 48px 32px;
      text-align: center; box-shadow: 0 20px 40px rgba(43,69,110,0.08); border: 1px solid var(--light-1);
      opacity: 0; transform: translateY(30px);
      animation: cardIn 0.6s cubic-bezier(0.34,1.56,0.64,1) 0.3s forwards;
    }
    @keyframes cardIn {
      0% { opacity:0; transform:translateY(30px); }
      100% { opacity:1; transform:translateY(0); }
    }
    .check-circle {
      width: 88px; height: 88px; background: var(--green-light); border-radius: 50%;
      display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;
      animation: scaleIn 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.8s both;
    }
    @keyframes scaleIn { from { transform: scale(0); } to { transform: scale(1); } }
    h1 { font-size: 24px; font-weight: 700; color: var(--black); margin-bottom: 12px; }
    p { color: var(--dark-gray); font-size: 15px; line-height: 1.6; margin-bottom: 8px; }
    .order-id { font-size: 13px; color: var(--dark-gray); margin-top: 16px; margin-bottom: 32px; }
    .order-id code { background: var(--light-3); padding: 2px 8px; border-radius: 6px; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check-circle">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="var(--green-dark)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
    </div>
    <h1>پرداخت موفق بود!</h1>
    <p>تراکنش شما با موفقیت انجام شد.</p>
    ${orderId ? `<p class="order-id">کد پیگیری: <code>${String(orderId).slice(0, 60)}</code></p>` : ''}
  </div>
</body>
</html>`;
}

module.exports = { renderSuccessPage };
