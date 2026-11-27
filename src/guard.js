const { createBot } = require('./bot');
const config = require('./config');
const { log } = require('./logger');
const { sendDiscord } = require('./notify');

let reconnectTimer = null;
let isRunning = false;

function startGuard() {
  if (isRunning) {
    log('main', 'Guard đã chạy, không tạo thêm instance');
    return;
  }
  isRunning = true;
  log('main', '🚀 Khởi động Minecraft AFK Bot', '🤖');
  log('main', `Endpoint: ${config.endpoint}`);
  log('main', `Username: ${config.username}`);
  sendDiscord(`🚀 Bot khởi động. Endpoint: ${config.endpoint}`);
  connect();
}

function connect() {
  createBot(() => {
    // onDisconnect callback
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  log('reconnect', `Lên lịch kết nối lại sau ${config.watchdog.retryDelay / 1000}s`, '🔄');
  reconnectTimer = setTimeout(() => {
    log('reconnect', 'Bắt đầu kết nối lại...', '🚀');
    connect();
  }, config.watchdog.retryDelay);
}

function stopGuard() {
  isRunning = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  log('main', 'Đã tắt guard', '👋');
}

module.exports = { startGuard, stopGuard };
