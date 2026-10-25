'use strict';
// Only a real SEP SOAP answer counts. A proxy's HTML 502 page also starts with '<'; read as SEP XML it has
// no ErrorCode and no rows, and a caller would treat "SEP is down" as an ordinary SEP answer (a refund that
// "does not exist", classified for a human to pay by hand what SEP may already have registered). One check
// for every caller of the refund service.
const isEnvelope = (data) => /<(\w+:)?Envelope[\s/>]/.test(data) || /<a:(ErrorCode|ReferenceId)>/.test(data);

// The answer's body as a string ('' when there is none).
const bodyOf = (res) => (typeof (res && res.data) === 'string' ? res.data : String((res && res.data) ?? ''));

// `res` is { status, data } as the SEP functions return it.
function isSepAnswer(res) {
  const status = res && res.status;
  return status >= 200 && status < 300 && isEnvelope(bodyOf(res));
}

module.exports = { isSepAnswer, bodyOf };
