'use strict';

const { createLogger } = require('./logger');
const log = createLogger('notify');

/** Discord webhook — chỉ gửi ra, không nhận lệnh. Không có URL -> bỏ qua. */
function createNotifier(url) {
  if (!url) return { send: () => Promise.resolve() };
  let queue = Promise.resolve();

  async function post(content) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 1900) }),
        signal: ac.signal,
      });
      if (!res.ok) log.warn('webhook failed', { status: res.status });
    } catch (err) {
      log.warn('webhook error', { msg: err.message });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    send(content) {
      queue = queue.then(() => post(content)).catch(() => {});
      return queue;
    },
  };
}

module.exports = { createNotifier };
