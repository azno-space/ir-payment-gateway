const axios = require('axios');

const EVENT_WEBHOOK_URL = process.env.EVENT_WEBHOOK_URL || '';
const ANALAS_API_KEY = process.env.ANALAS_API_KEY || '';
const ANALAS_URL = 'https://analas.ir/api/capture';

function logPaymentEvent(eventName, eventData) {
  setImmediate(() => {
    if (EVENT_WEBHOOK_URL) {
      axios
        .post(
          EVENT_WEBHOOK_URL,
          { event_name: eventName, event_properties: eventData },
          { headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
        )
        .catch((err) => {
          console.log('[eventLogger] Failed to send event to webhook:', err.message);
        });
    }

    if (ANALAS_API_KEY) {
      axios
        .post(
          ANALAS_URL,
          [{ event: eventName, properties: eventData }],
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ANALAS_API_KEY}`,
            },
            timeout: 5000,
          },
        )
        .catch((err) => {
          console.log('[eventLogger] Failed to send event to Analas:', err.message);
        });
    }
  });
}

module.exports = { logPaymentEvent };
