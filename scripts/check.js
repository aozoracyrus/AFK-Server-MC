const mineflayer = require('mineflayer');
const config = require('../src/config');

console.log(`Kiểm tra server: ${config.endpoint} qua ${config.hub.host}`);

const bot = mineflayer.createBot({
  host: config.hub.host,
  port: config.hub.port,
  username: 'CheckBot_' + Date.now(),
  version: config.version,
  auth: 'offline',
});

bot.once('login', () => {
  setTimeout(() => {
    bot.chat(`/browser join ${config.endpoint}`);
  }, 2000);
});

bot.on('chat', (username, message) => {
  const msg = message.toLowerCase();
  if (msg.includes('register') || msg.includes('password') || msg.includes('/login')) {
    console.log('✅ SERVER GỐC ĐANG HOẠT ĐỘNG (phát hiện PAL)');
    bot.quit();
    process.exit(0);
  }
  if (msg.includes('not found') || msg.includes('does not exist')) {
    console.log('❌ Endpoint không tồn tại');
    bot.quit();
    process.exit(1);
  }
});

bot.on('end', () => {
  console.log('⚠️ Không thể xác nhận trạng thái server');
  process.exit(1);
});

bot.on('error', (err) => {
  console.log('⚠️ Lỗi:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('⏱️ Timeout - server có thể đang tắt');
  bot.quit();
  process.exit(1);
}, 25000);
