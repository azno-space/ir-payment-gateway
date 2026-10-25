<p align="center">
  <img src="./docs/banner.svg" alt="ir-payment-gateway" width="100%"/>
</p>

# ir-payment-gateway

A standalone, database-free Iranian payment gateway service supporting **Zibal**, **Zarinpal**, and **SEP (Saman/Shaparak)**. Instead of writing to a database, it calls configurable webhook URLs when a payment succeeds or fails — your application owns the data layer.

## Documentation

**Full developer guide (فارسی / English):** [https://azno-space.github.io/ir-payment-gateway/](https://azno-space.github.io/ir-payment-gateway/)

Includes getting started, configuration, API reference, gateway setup (Zibal / Zarinpal / SEP), webhook payloads, admin endpoints, and Docker deployment.

---

- **Four gateways**: Zibal, Zarinpal, Zarinpal Sandbox, SEP — switchable per request or forced globally
- **Automatic fail-over**: SEP → Zarinpal on timeout (configurable)
- **Webhook-driven**: on success/failure, POST to your callback URL with a signed payload
- **Retry queue**: failed webhook calls are retried with exponential back-off, persisted to disk
- **SEP refund API**: full SOAP passthrough (Refund_Reg, Refund_Exec, GetDailyRefundList, GetRefundStatus, GetRefundDetail, GetRefundStatusByRequestId, RefreshRefundRequestByPartialRefundInfoId)
- **Optional notifications**: Bale Messenger and Telegram alerts (bring your own bot token)
- **No database required**: only Node.js + the file system
- **Docker-ready**

---

## Quick Start

```bash
git clone https://github.com/azno-space/ir-payment-gateway.git
cd ir-payment-gateway
cp .env.example .env
# Edit .env with your credentials
npm install
npm start
```

---

## Configuration

Copy `.env.example` to `.env` and fill in the values.

### Required

| Variable | Description |
|---|---|
| `CALLBACK_BASE_URL` | Public URL of this service, e.g. `https://pay.example.com` |
| `PAYMENT_SUCCESS_WEBHOOK_URL` | Your app's endpoint — called on verified payment |
| `PAYMENT_FAILURE_WEBHOOK_URL` | Your app's endpoint — called on failed/cancelled payment |

### Gateway Credentials

| Variable | Description |
|---|---|
| `ZIBAL_MERCHANT` | Zibal merchant ID |
| `ZARINPAL_MERCHANT` | Zarinpal 36-char merchant ID (also used for `zarinpal_sandbox`) |
| `ZARINPAL_SANDBOX` | Set to `true` to use sandbox URLs for the `zarinpal` gateway globally |
| `SEP_TERMINAL_ID` | SEP terminal ID |
| `SEP_USERNAME` | SEP refund username |
| `SEP_PASSWORD` | SEP refund password |

### Routing

| Variable | Default | Description |
|---|---|---|
| `FORCED_PAYMENT_GATEWAY` | _(none)_ | Force all payments through one gateway (`zibal`, `zarinpal`, `zarinpal_sandbox`, `sep`) |
| `PAYMENT_FAILOVER_ENABLED` | `true` | Enable automatic fail-over chains |
| `GATEWAY_REQUEST_TIMEOUT_MS` | `8000` | Per-gateway request timeout (ms) |
| `GATEWAY_REQUEST_RETRIES` | `1` | Retries on network error |
| `GATEWAY_LAST_TIMEOUT_MS` | `15000` | Timeout for the last gateway in a fail-over chain |
| `GATEWAY_LAST_RETRIES` | `2` | Retries for the last gateway in a fail-over chain |

### Webhook Security

| Variable | Description |
|---|---|
| `WEBHOOK_SECRET` | If set, every webhook POST includes `X-Webhook-Secret: <value>` |
| `ADMIN_KEY` | Admin key, **money** scope: every admin endpoint |
| `ADMIN_READ_KEY` | Optional admin key, **read** scope: only the read-only admin endpoints (403 elsewhere) |

### UI / Frontend

| Variable | Description |
|---|---|
| `FRONT_BASE_URL` | Your frontend root URL; `FRONT_SUCCESS_URL` defaults to `<FRONT_BASE_URL>/payment/success` |
| `FRONT_SUCCESS_URL` | Redirect destination after successful payment |
| `FRONT_FAILURE_URL` | Redirect destination after a failed or cancelled payment, with `?kind=error&reason=<code>&gateway=&ref=`. Codes: `cancelled`, `incomplete_params`, `verify_failed`, `verify_retry_failed`. Unset = the callback answers JSON `{ success:false, error:{ code } }` (the gateway renders no pages) |

### Notifications (optional)

| Variable | Description |
|---|---|
| `BALE_BOT_TOKEN` | Bale bot token for success notifications |
| `BALE_CHAT_ID` | Not used: success notifications are off; alerts go to `BALE_FAILED_CHAT_ID` |
| `BALE_FAILED_BOT_TOKEN` | Bale bot token for failure notifications |
| `BALE_FAILED_CHAT_ID` | Bale chat ID for failure notifications |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID |
| `TELEGRAM_BASE_URL` | Telegram API base URL (default: `https://api.telegram.org`) |

### API v2 and replay guard (optional, both off by default)

| Variable | Description |
|---|---|
| `API_V2_ENABLED` | `true` serves API v2 under `/api/v2` next to v1 (see [API v2](#api-v2)); v1 is unchanged either way |
| `IDEMPOTENCY_FILE` / `IDEMPOTENCY_TTL_MS` | Where v2 keeps `Idempotency-Key` answers, and for how long (default one day) |
| `CALLBACK_REPLAY_GUARD` | `true`: a bank callback that arrives twice for one payment is verified and handed to your webhook once; the guest is sent where the first callback sent them. A callback with `retry=true` may take over a payment whose hand-over was only queued |
| `VERIFIED_LEDGER_FILE` / `VERIFIED_LEDGER_TTL_MS` | Where the guard remembers verified payments, and for how long (default 30 days) |

### Analytics (optional)

| Variable | Description |
|---|---|
| `EVENT_WEBHOOK_URL` | Webhook URL for payment event logging |

---

## API Reference

### `POST /api/payments`

Initiate a payment.

**Request body:**

```json
{
  "orderId": "order-123",
  "amount": 150000,
  "mobile": "09123456789",
  "gateway": "sep"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `orderId` | string | Yes | Your order identifier (passed to gateway as ResNum/orderId) |
| `amount` | number | Yes | Amount in Rials |
| `mobile` | string | No | Customer mobile (some gateways prefill the form) |
| `gateway` | string | No | `zibal`, `zarinpal`, `zarinpal_sandbox`, or `sep`. Falls back to `zarinpal` if omitted |

**Response `200`:**

```json
{
  "targetUrl": "https://sep.shaparak.ir/OnlinePG/SendToken?token=...",
  "gateway": "sep",
  "orderId": "order-123"
}
```

Redirect the user to `targetUrl`.

---

### `GET /api/payments/callback` · `POST /api/payments/callback`

Gateway callback — called by the payment gateway after the user completes (or cancels) the flow. **Not called directly by your application.**

On success, this endpoint verifies the transaction with the gateway and POSTs to `PAYMENT_SUCCESS_WEBHOOK_URL`:

```json
{
  "orderId": "order-123",
  "gateway": "sep",
  "code": "<refNum>",
  "status": "success",
  "verifyDetails": { ... },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

On failure, it POSTs to `PAYMENT_FAILURE_WEBHOOK_URL`:

```json
{
  "orderId": "order-123",
  "gateway": "sep",
  "code": "",
  "status": "failed",
  "reason": "توسط کاربر انصراف داده شد",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

### API v2

Off unless `API_V2_ENABLED=true`. The contract is [`src/v2/openapi.json`](src/v2/openapi.json) (a test fails when it and the routes disagree). v2 answers every error as `{ "error": "<message>", "code": "<stable_code>" }`, paginates every list (`limit` default 50, at most 200; `offset`; the page is `{ items, total, limit, offset }`), and uses the same admin keys as v1.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v2/payments` | Start a payment (JSON body `orderId`, `amount` in Rial, optional `mobile`, `gateway`). `201` with `{ targetUrl, gateway, orderId }`. Send an `Idempotency-Key` header (8–128 letters, digits, `-`, `_`) and a repeat returns the first answer with `Idempotency-Replayed: true`; a different body under the same key is `409 idempotency_key_reused`; a call still running is `409 request_in_progress`. Gated by `PAYMENT_CREATE_SECRET` like v1 |
| `GET` | `/api/v2/payments/queue-items` | read — the webhook retry queue (`?status=pending\|dead`) |
| `DELETE` | `/api/v2/payments/queue-items/{id}` | money — drop one item (`204`, or `404`) |
| `GET` | `/api/v2/payments/error-log-entries` | read — the local error log, newest first |
| `GET` | `/api/v2/payments/unverified-payments` | read — Zarinpal payments paid but never verified |
| `POST` | `/api/v2/payments/verifications` | money — ask a bank whether a payment went through (body `gateway`, `code`; `amount` for Zarinpal). `200` with `verified: true\|false` |

---

### Admin endpoints

Every admin endpoint needs an admin key in a header: `Authorization: Bearer <key>` or `x-admin-key: <key>` (compared in constant time). A key in the URL (`?token=`) is refused. Two scopes: **read** endpoints accept `ADMIN_READ_KEY` or `ADMIN_KEY`; **money** endpoints (anything that moves money or changes state) accept only `ADMIN_KEY` and answer 403 to a read key.

Every error has one shape: `{ "success": false, "error": { "code": "...", "message": "..." } }` (`message` optional; never a stack trace).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/payments/admin/verify-only` | money — Verify a transaction with the gateway (a verify settles the payment at the bank) without calling your webhook |
| `GET` | `/api/payments/admin/queue` | read — the webhook retry queue |
| `DELETE` | `/api/payments/admin/queue/:id` | money — drop one webhook retry item |
| `GET` | `/api/payments/admin/error-log` | read — the local error log |
| `GET` | `/api/payments/admin/zarinpal-unverified` | read — Zarinpal payments paid but never verified |
| `POST` | `/api/payments/admin/sep/refund/reg` | money — SEP Refund_Reg |
| `POST` | `/api/payments/admin/sep/refund/exec` | money — SEP Refund_Exec |
| `POST` | `/api/payments/admin/sep/refund/list` | read — SEP GetDailyRefundList |
| `POST` | `/api/payments/admin/sep/refund/status` | read — SEP GetRefundStatus |
| `POST` | `/api/payments/admin/sep/refund/detail` | read — SEP GetRefundDetail — body `{ refundId }` |
| `POST` | `/api/payments/admin/sep/refund/status-by-request-id` | read — SEP GetRefundStatusByRequestId — body `{ requestId }` (the id you sent to Refund_Reg; finds refunds from earlier days) |
| `POST` | `/api/payments/admin/sep/refund/refresh` | money — SEP RefreshRefundRequestByPartialRefundInfoId — body `{ refundId, description }`; only for a refund SEP marked Fail (a refresh of an unknown outcome can pay twice) |
| `POST` | `/api/payments/admin/sep/report` | read — SEP report service (report.sep.ir): every transaction for `{ fromDate, toDate }` (Persian `YYYY/MM/DD`) — finds a charge whose callback never reached you. Needs `SEP_REPORT_USERNAME`, `SEP_REPORT_PASSWORD`, `SEP_REPORT_WEBSERVICE_KEY` (+ `SEP_REPORT_CUSTOMER_KEY`, `SEP_REPORT_RELATION_KEY`); 503 when unset |

#### `GET /api/payments/admin/verify-only`

Query params: `gateway`, `code` (and optionally `amount` for Zarinpal).

---

## Zarinpal Sandbox

For testing without real money, use the Zarinpal sandbox environment.

**Option A — per-request (recommended for testing):**

```json
{ "orderId": "test-001", "amount": 10000, "gateway": "zarinpal_sandbox" }
```

Pass `gateway: "zarinpal_sandbox"` in your payment request. The same `ZARINPAL_MERCHANT` is used; no extra credentials needed.

**Option B — global switch:**

```env
ZARINPAL_SANDBOX=true
```

This redirects all `zarinpal` gateway calls to sandbox URLs. The gateway name stays `zarinpal` in requests.

| | Sandbox | Production |
|---|---|---|
| API base | `sandbox.zarinpal.com/pg/v4/payment/` | `payment.zarinpal.com/pg/v4/payment/` |
| Payment page | `sandbox.zarinpal.com/pg/StartPay/` | `payment.zarinpal.com/pg/StartPay/` |
| Merchant ID | Same `ZARINPAL_MERCHANT` | Same `ZARINPAL_MERCHANT` |
| Webhook fired | Yes — identical payload | Yes |

> The sandbox does not charge real money. Use it to verify your webhook handler before going live.

---

## Fail-over Chains

When `PAYMENT_FAILOVER_ENABLED=true` (default), failing gateways fall over automatically:

| Primary | Chain |
|---|---|
| `sep` | SEP → Zarinpal |
| `zarinpal` | Zarinpal only |
| `zarinpal_sandbox` | Zarinpal Sandbox only |
| `zibal` | Zibal only |

The last gateway in the chain gets longer timeouts (`GATEWAY_LAST_TIMEOUT_MS`) and more retries.

---

## Webhook Retry Queue

If `PAYMENT_SUCCESS_WEBHOOK_URL` returns a non-200 response or times out, the payload is saved to `data/payment-queue.json` and retried automatically with exponential back-off. You can inspect the queue at `GET /api/payments/admin/queue`, or at `GET /api/test/queue` when `ENABLE_TEST_ROUTES=true`.

---

## Docker

```bash
docker build -t ir-payment-gateway .
docker run -p 3000:3000 --env-file .env ir-payment-gateway
```

---

## Development

```bash
npm run dev   # nodemon hot-reload
npm start     # production
```

Test endpoints are available at `/api/test/*` only when `ENABLE_TEST_ROUTES=true` (a laptop; never on a reachable host).

---

## License

MIT — see [LICENSE](./LICENSE).
