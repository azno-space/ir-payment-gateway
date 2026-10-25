'use strict';
// Generic alert plumbing: render a message, post it to Telegram or Bale, retry, queue on disk,
// throttle repeats. What the messages say and who gets them is the caller's business.
module.exports = {
  ...require('./render'),
  ...require('./senders'),
  ...require('./store'),
  ...require('./events'),
};
