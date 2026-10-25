# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Yes     |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **sadra.bigdeli1350@gmail.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

You will receive a response within **72 hours**.

## Responsible Disclosure

- We will acknowledge your report promptly
- We will work on a fix and coordinate a release date with you
- We will credit you in the release notes (unless you prefer anonymity)

## Security Considerations for Users

- Set a strong `WEBHOOK_SECRET` and validate it in your backend on every received webhook
- Set a strong `ADMIN_KEY` — admin endpoints can trigger webhooks and verify transactions
- Never expose admin endpoints (`/api/payments/admin/*`) publicly without authentication
- Use HTTPS for `CALLBACK_BASE_URL` and all webhook URLs
- Rotate credentials (`SEP_PASSWORD`, `ZARINPAL_MERCHANT`, etc.) if you suspect compromise
- Never commit `.env` files — only `.env.example` belongs in version control
