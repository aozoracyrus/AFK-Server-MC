const fetch = require('node-fetch');
const config = require('./config');
const { log } = require('./logger');

async function sendDiscord(message) {
  if (!config.discord.webhook) {
    log('notify', `No Discord webhook. Console only: ${message}`);
    return;
  }

  try {
    await fetch(config.discord.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: message,
        username: 'MC Bot',
      }),
    });
    log('notify', `Đã gửi Discord: ${message}`);
  } catch (err) {
    log('notify', `Lỗi gửi Discord: ${err.message}`, '⚠️');
  }
}

module.exports = { sendDiscord };
