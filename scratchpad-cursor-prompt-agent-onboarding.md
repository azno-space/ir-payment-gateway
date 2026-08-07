Context: this repo (`ir-payment-gateway`, real GitLab path
`azno/payment-gateway` on `git.rgbgroup.ir`) is the last of four projects
being onboarded to the Self-Healing Agent — a separate project at
`/Users/sy313/projects/shahriyari/self-healing-agent` (don't need to open
it, this prompt is self-contained; it has already registered this repo as
`failing_service: "payment-gateway"` with `toolchain: null` — meaning
code-fix automation stays off until this repo has real tests and that's
flipped on deliberately, not by default).

Unlike the three prior onboardings (`allset-node`, `azno-booking`,
`payment-v2`), **this repo has zero test framework and zero lint config** —
there's real foundational work here, not just wiring. Do this in order,
verify each part for real before moving to the next.

`AGENT_SENSOR_URL`/`AGENT_SENSOR_HMAC_SECRET` are already set in `.env` and
`.env.development` (both gitignored here, unlike some of the sibling repos —
confirmed via this repo's own `.gitignore`) — don't generate a new secret,
just use `process.env.AGENT_SENSOR_URL`/`process.env.AGENT_SENSOR_HMAC_SECRET`.

---

## Part 1: minimal real test framework (Jest)

This is a plain CommonJS Express service (matches `allset-node`'s shape,
which also uses Jest) — use Jest, not something requiring a bundler.

1. `npm install --save-dev jest`, add `"test": "jest"` to `package.json`
   scripts (replacing the current stub that just exits 1).
2. Write **real, meaningful tests** — not placeholders written just to make
   a number go up. Good starting targets, all pure functions with no I/O
   (read them first to confirm current behavior before writing assertions,
   don't guess):
   - `escapeXml` in `src/services/payment-gateway.service.js` — used to
     build SEP's SOAP XML; a real escaping bug here would corrupt real
     refund requests, worth locking down.
   - `getCbUrl` (same file) — callback URL construction.
   - `_buildZarinpalRequest`/`_buildZarinpalVerify` (same file) — pure
     request-shape builders; check if they're exported already or need a
     `module.exports` addition to be testable (don't restructure the file
     beyond what's needed for testability).
   - `appendErrorLog`/`readErrorLog` in `src/utils/errorLogger.js` — these
     do real file I/O; test against a temp file path (override
     `PAYMENT_ERROR_LOG_FILE` for the test, don't touch the real log file),
     covering at least: writes are readable back, and the 500-entry cap
     actually trims.
   - Skim `src/services/webhook.service.js` and
     `src/services/payment-session.service.js` for any other pure logic
     worth covering — don't force tests onto things that are mostly I/O
     orchestration with little independent logic to verify.
3. This doesn't need to be exhaustive coverage — it needs to be **real**
   enough that a passing test suite actually means something, since this is
   what will eventually gate any future automated code-fix on this repo.

## Part 2: minimal ESLint config

1. `npm install --save-dev eslint`, add `"lint": "eslint src"` to
   `package.json` scripts.
2. A standard recommended Node/CommonJS config is fine — don't invent
   elaborate custom rules, just get a real, working baseline. Fix whatever
   it reports on the actual codebase (should be small/mechanical for a
   ~2400-line service) — if anything looks like a real bug rather than a
   style nit, flag it in your report rather than silently "fixing" it by
   guessing intent.

## Part 3: error-forwarding sensor hook

### What already exists

`src/controllers/payment.controller.js`'s `notifyBaleFailure(errorDetails)`
(~line 201) is the **single** existing failure-notification funnel in this
repo (confirmed — only one call site) — it already calls
`sendFailedPaymentNotificationToBale` and `appendErrorLog`. Add the new call
alongside those, don't restructure.

### What to build

1. New module (e.g. `src/services/agentSensor.service.js`, matching this
   repo's `*.service.js` convention) exporting `forwardErrorToAgent(errorDetails)`.
2. Payload contract (must match exactly):
   ```js
   {
     errorType: string,       // e.g. "payment-gateway.<category>"
     errorCode: "NETWORK_ERROR" | "NETWORK_EXHAUSTED" | "HTTP_ERROR" | "VALIDATION_ERROR" | "UNKNOWN",
     httpStatus: number | undefined,
     failing_service: "payment-gateway",   // fixed — must match exactly
     errorMessage: string,
     context: { /* safe non-PII fields only: orderId, gateway, code, stage — never card/account data */ },
     observedAt: string,      // new Date().toISOString()
   }
   ```
   Wrapped as `{ source: "payment-gateway", payload: <above> }`,
   `JSON.stringify`'d once and reused verbatim for both the HMAC signature
   and the request body — same reasoning as every prior onboarding: nothing
   may re-serialize it, or the signature won't match what the agent verifies.
3. Sign with `crypto.createHmac("sha256", process.env.AGENT_SENSOR_HMAC_SECRET).update(body).digest("hex")`,
   headers `X-Agent-Sensor-Service: payment-gateway` +
   `X-Agent-Sensor-Signature`, POST to `process.env.AGENT_SENSOR_URL`.
4. Must never throw, must no-op safely if the two env vars are unset, must
   be fire-and-forget (match `notifyBaleFailure`'s existing
   `setImmediate`/non-blocking style). Add a simple time-windowed dedupe
   (~30s) so a failure loop can't flood the sensor — same pattern used in
   the `allset-node`/`azno-booking`/`payment-v2` equivalents, feel free to
   look at the general shape but don't copy-paste blindly since this repo's
   `errorDetails` shape may differ — check what fields `notifyBaleFailure`
   actually receives before assuming.
5. Wire the call into `notifyBaleFailure`.

### Verify for real

1. Start the self-healing-agent's sensor server:
   `cd /Users/sy313/projects/shahriyari/self-healing-agent && env -u ANTHROPIC_BASE_URL AGENT_GITLAB_CLIENT_MODE=mock AGENT_QUALITY_GATE_MODE=mock AGENT_BALE_APPROVAL_MODE=auto_approve npm run dev`
2. Trigger `forwardErrorToAgent` for real (standalone script calling it
   directly with a realistic `errorDetails` shape is fine).
3. Confirm in the agent's log: not 401/400, routed to a real policy
   decision, and — since `toolchain: null` for this service right now — no
   code-fix path is attempted (should land on alert_only or
   ticket_and_alert). If it somehow reaches a code-fix attempt, that means
   something's misconfigured on the agent side — report it, don't try to
   fix the agent's routing yourself.
4. Stop the test server.

## Standing rules

- Nothing committed by you — report back, the user reviews and commits.
- Don't flip anything in the *agent's* own repo (toolchain, SERVICE_ROUTES)
  — that's the user's call once this repo's test suite is real and trusted,
  not something to enable from this side.
- If `notifyBaleFailure` turns out not to be the only failure path once you
  read the whole controller (it's smaller than `payment-v2`'s but still
  worth double-checking, same lesson from that onboarding), report what
  else you find rather than assuming single coverage.

## When done

Report: what test framework/tests were added and why each one was chosen
(not just "added tests"), lint setup and what it found/fixed, where the
sensor hook lives and is wired, and the real verification evidence from
Part 3 (server log excerpts, not just "the code looks right"). Include
final `npm test`/`npm run lint` output.
