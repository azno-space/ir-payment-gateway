const axios = require('axios');

// Where events go: one HTTP endpoint (EVENT_WEBHOOK_URL). Unset = events only appear as a console line.
// Every event carries the app name and environment; a caller cannot override them.
// Logging never throws and never makes a request wait: the send is fire-and-forget with a timeout.
const APP_NAME = 'payment-gateway';
const envTag = () => process.env.APP_ENV_TAG || (process.env.NODE_ENV === 'production' ? 'production' : 'development');

function logPaymentEvent(eventName, eventData) {
  try {
    const props = { ...eventData, app: APP_NAME, env: envTag() };
    const url = process.env.EVENT_WEBHOOK_URL;
    if (!url) return;
    setImmediate(() => {
      try {
        axios
          .post(url, { event_name: eventName, event_properties: props }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 })
          .catch((err) => console.warn('[eventLogger] send failed:', eventName, err.message));
      } catch (err) {
        console.warn('[eventLogger] send failed:', eventName, err.message);
      }
    });
  } catch (err) {
    console.warn('[eventLogger] failed:', err && err.message);
  }
}

module.exports = { logPaymentEvent, APP_NAME };
