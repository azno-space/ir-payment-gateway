# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-06-28

### Added
- **Three gateways**: Zibal, Zarinpal, SEP (Saman/Shaparak)
- **Webhook delivery**: POST to configurable success/failure URLs after payment verification
- **Retry queue**: failed webhooks saved to `data/payment-queue.json` and retried with exponential back-off
- **Automatic fail-over**: SEP → Zarinpal on timeout (configurable via `PAYMENT_FAILOVER_ENABLED`)
- **SEP Refund API**: full SOAP passthrough — `Refund_Reg`, `Refund_Exec`, `GetDailyRefundList`, `GetRefundStatus`
- **Admin endpoints**: manual verify-only and trigger-webhook for recovery scenarios
- **Notifications**: Bale Messenger and Telegram alerts (optional)
- **Forced gateway**: override routing via `FORCED_PAYMENT_GATEWAY`
- **File-based logging**: structured JSON logs with retention
- **Docker support**: production-ready Dockerfile with data volume mounting
- **Webhook secret**: `X-Webhook-Secret` header on every outgoing webhook
- **Payment session state**: in-memory session tracking — no database required
- **DNS caching**: custom axios agent to reduce latency on gateway requests

### Architecture
- Initial open-source release — extracted and generalized from a private deployment
- Removed all application-specific dependencies (database, internal APIs, JWT)
- `telegram.service.js` merged into `notification.service.js` (Bale + Telegram unified)
- Controller refactored from ~4000 lines to ~700 lines by extracting `webhook.service.js` and `payment-session.service.js`
