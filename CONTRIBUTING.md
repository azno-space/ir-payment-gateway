# Contributing to ir-payment-gateway

## Getting Started

```bash
git clone https://github.com/azno-space/ir-payment-gateway.git
cd ir-payment-gateway
npm install
cp .env.example .env
npm run dev
```

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS
- Relevant logs

## Proposing Features

Open an issue describing:
- The problem you're solving
- Your proposed solution
- Alternatives you considered

## Submitting a Pull Request

1. Fork the repository and create a branch from `main`
2. Make your changes — keep PRs focused on a single concern
3. Test your changes manually against a real or sandbox gateway
4. Submit the PR with a clear description of what changed and why

## Code Style

- No formatter is enforced yet — match the style of the surrounding code
- Keep functions small and focused
- Don't add `console.log` debug statements

## Commit Messages

Follow the pattern:

```
feat: add support for X
fix: handle Y correctly
docs: update Z section
refactor: simplify payment queue logic
```

## Security Issues

Do **not** open a public issue for security vulnerabilities.
See [SECURITY.md](./SECURITY.md) for the responsible disclosure process.
