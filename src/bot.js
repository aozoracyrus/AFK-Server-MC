const mineflayer = require('mineflayer');
const config = require('./config');
const { log } = require('./logger');
const { sendDiscord } = require('./notify');

let inRealServer = false;
let registered = false;
let watchdogTimer = null;
let botFullyLoaded = false;  // Flag mới: bot đã fully loaded chưa

function createBot(onDisconnect) {
  log('init', `Kết nối vào HUB: ${config.hub.host}:${config.hub.port}`);

  const bot = mineflayer.createBot({
    host: config.hub.host,
    port: config.hub.port,
    username: config.username,
    version: config.version,
    auth: 'offline',
  });

  // LOGIN vào HUB
  bot.once('login', () => {
    log('origin', `Đã login vào HUB. Username: ${bot.username}`);

    setTimeout(() => {
      log('origin', `Gửi lệnh: /browser join ${config.endpoint}`);
      bot.chat(`/browser join ${config.endpoint}`);
      startWatchdog(bot, onDisconnect);
    }, 2000);
  });

  // SPAWN - bot đã vào world (chưa fully loaded)
  bot.on('spawn', () => {
    log('spawn', 'Bot đã spawn trong world', '🌍');
  });

  // PHYSICS TICK - bot đã fully loaded (world + entities + packets)
  bot.once('physicTick', () => {
    botFullyLoaded = true;
    log('verify', '✅ Bot đã fully loaded (ready để gửi lệnh)', '🎯');
  });

  // CHAT - dùng để verify PAL
  bot.on('chat', (username, message) => {
    const msg = message.toLowerCase();

    // Dấu hiệu PAL - chỉ server gốc mới gửi
    if (msg.includes('register') || msg.includes('password') || msg.includes('/login')) {
      if (!inRealServer) {
        inRealServer = true;
        clearTimeout(watchdogTimer);
        log('verify', '✅ Đã vào SERVER GỐC (phát hiện PAL)', '🎯');
        log('verify', `Message trigger: "${message}"`);

        // CHỜ bot fully loaded rồi mới gửi lệnh (delay 3 giây)
        const sendRegister = () => {
          if (botFullyLoaded) {
            const cmd = `/register ${config.password} ${config.password}`;
            log('origin', `Gửi: ${cmd}`);
            bot.chat(cmd);
          } else {
            log('verify', '⏳ Chờ bot fully loaded...', '⏱️');
            setTimeout(sendRegister, 1000);
          }
        };

        setTimeout(sendRegister, 3000);  // Delay 3 giây sau khi thấy PAL
      }
    }

    // Đăng ký thành công
    if (msg.includes('registered') && !msg.includes('already')) {
      registered = true;
      log('auth', '✅ Đăng ký thành công', '🔐');
      log('main', '🟢 BOT THẬT SỰ ONLINE VÀ AFK TẠI SERVER GỐC', '✅');
      sendDiscord(`✅ Bot đã vào server gốc và đăng ký thành công. Endpoint: ${config.endpoint}`);
    }

    // Đã đăng ký từ trước
    if (msg.includes('already registered')) {
      registered = true;
      log('auth', '⚠️ Đã đăng ký từ trước. Gửi /login...', '🔐');
      setTimeout(() => {
        if (botFullyLoaded) {
          bot.chat(`/login ${config.password}`);
        } else {
          setTimeout(() => bot.chat(`/login ${config.password}`), 2000);
        }
      }, 1000);
    }

    // Login thành công
    if (msg.includes('login successful') || msg.includes('successfully logged in')) {
      log('auth', '✅ Login thành công', '🔓');
      log('main', '🟢 BOT THẬT SỰ ONLINE VÀ AFK TẠI SERVER GỐC', '✅');
      sendDiscord(`✅ Bot đã login thành công. Endpoint: ${config.endpoint}`);
    }

    log('chat', `<${username}> ${message}`);
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
    botFullyLoaded = false;
    clearTimeout(watchdogTimer);
  }

  return bot;
}

function startWatchdog(bot, onDisconnect) {
  log('watchdog', `Bắt đầu countdown ${config.watchdog.verifyTimeout / 1000}s để verify server gốc`);

  watchdogTimer = setTimeout(() => {
    if (!inRealServer) {
      log('watchdog', '⚠️ HẾT THỜI GIAN - Không thấy PAL → Server gốc ĐANG TẮT', '🔴');
      log('watchdog', `Disconnect khỏi hub, thử lại sau ${config.watchdog.retryDelay / 1000}s`, '⏳');
      sendDiscord(`🔴 Server gốc (${config.endpoint}) đang TẮT. Bot sẽ thử lại sau ${config.watchdog.retryDelay / 1000}s.`);
      cleanup();
      try { bot.quit('server offline'); } catch {}
      onDisconnect();
    }
  }, config.watchdog.verifyTimeout);
}

module.exports = { createBot };
