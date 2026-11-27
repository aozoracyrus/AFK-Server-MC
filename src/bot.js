const mineflayer = require('mineflayer');
const config = require('./config');
const { log } = require('./logger');
const { sendDiscord } = require('./notify');

let inRealServer = false;
let registered = false;
let watchdogTimer = null;

function createBot(onDisconnect) {
  log('init', `Kết nối vào HUB: ${config.hub.host}:${config.hub.port}`);

  const bot = mineflayer.createBot({
    host: config.hub.host,
    port: config.hub.port,
    username: config.username,
    version: config.version,
    auth: 'offline',
  });

  // ============================================================
  // PATCH TICK_END — FIX BUG 26.3 "Invalid move player packet received"
  // 26.3 chỉ cho 1 packet vị trí mỗi client tick và chỉ reset bộ đếm
  // khi nhận client_tick_end. mineflayer release không gửi -> bot bị kick.
  // Gửi tick_end sau mỗi packet di chuyển là hết kick.
  // ============================================================
  const origWrite = bot._client.write.bind(bot._client);
  bot._client.write = (name, packet) => {
    const result = origWrite(name, packet);
    if (
      name === 'position' ||
      name === 'position_look' ||
      name === 'look' ||
      name === 'flying'
    ) {
      try {
        origWrite('tick_end', {});
      } catch (err) {
        // version < 1.21.2 không có packet tick_end -> bỏ qua
      }
    }
    return result;
  };
  log('init', '✅ Đã patch tick_end (chống kick 26.3)');

  // LOGIN vào HUB
  bot.once('login', () => {
    log('origin', `Đã login vào HUB. Username: ${bot.username}`);

    setTimeout(() => {
      log('origin', `Gửi lệnh: /browser join ${config.endpoint}`);
      bot.chat(`/browser join ${config.endpoint}`);
      startWatchdog(bot, onDisconnect);
    }, 2000);
  });

  // CHAT — verify PAL (chỉ server gốc mới gửi chuỗi này)
  bot.on('chat', (username, message) => {
    const msg = message.toLowerCase();

    if (msg.includes('register') || msg.includes('password') || msg.includes('/login')) {
      if (!inRealServer) {
        inRealServer = true;
        clearTimeout(watchdogTimer);
        log('verify', '✅ Đã vào SERVER GỐC (phát hiện PAL)', '🎯');
        log('verify', `Message trigger: "${message}"`);

        setTimeout(() => {
          const cmd = `/register ${config.password} ${config.password}`;
          log('origin', `Gửi: ${cmd}`);
          bot.chat(cmd);
        }, 1500);
      }
    }

    if (msg.includes('registered') && !msg.includes('already')) {
      registered = true;
      log('auth', '✅ Đăng ký thành công', '🔐');
      log('main', '🟢 BOT THẬT SỰ ONLINE VÀ AFK TẠI SERVER GỐC', '✅');
      sendDiscord(`✅ Bot vào server gốc + đăng ký OK. Endpoint: ${config.endpoint}`);
    }

    if (msg.includes('already registered')) {
      registered = true;
      log('auth', '⚠️ Đã đăng ký từ trước. Gửi /login...', '🔐');
      setTimeout(() => bot.chat(`/login ${config.password}`), 1000);
    }

    if (msg.includes('login successful') || msg.includes('successfully logged in')) {
      log('auth', '✅ Login thành công', '🔓');
      log('main', '🟢 BOT THẬT SỰ ONLINE VÀ AFK TẠI SERVER GỐC', '✅');
    }

    log('chat', `<${username}> ${message}`);
  });

  bot.on('spawn', () => {
    log('spawn', 'Bot đã spawn trong world', '🌍');
  });

  bot.on('kicked', (reason) => {
    log('kick', `Bị kick: ${reason}`, '❌');
    sendDiscord(`❌ Bot bị kick: ${reason}`);
    cleanup();
    onDisconnect();
  });

  bot.on('error', (err) => {
    log('error', `Lỗi: ${err.message}`, '⚠️');
  });

  bot.on('end', (reason) => {
    log('end', `Ngắt kết nối: ${reason}`, '🔌');
    cleanup();
    onDisconnect();
  });

  function cleanup() {
    inRealServer = false;
    registered = false;
    clearTimeout(watchdogTimer);
  }

  return bot;
}

function startWatchdog(bot, onDisconnect) {
  log('watchdog', `Countdown ${config.watchdog.verifyTimeout / 1000}s để verify server gốc`);

  watchdogTimer = setTimeout(() => {
    if (!inRealServer) {
      log('watchdog', '⚠️ Không thấy PAL → Server gốc ĐANG TẮT', '🔴');
      log('watchdog', `Thử lại sau ${config.watchdog.retryDelay / 1000}s`, '⏳');
      sendDiscord(`🔴 Server gốc (${config.endpoint}) đang TẮT. Thử lại sau ${config.watchdog.retryDelay / 1000}s.`);
      cleanup();
      try { bot.quit('server offline'); } catch {}
      onDisconnect();
    }
  }, config.watchdog.verifyTimeout);
}

module.exports = { createBot };
