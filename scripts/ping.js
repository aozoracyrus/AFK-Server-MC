const { Client } = require('minecraft-protocol');
const config = require('../src/config');

console.log(`Ping ${config.hub.host}:${config.hub.port}...`);

const client = new Client();
client.connect(config.hub.host, config.hub.port);

client.on('connect', () => {
  console.log('✅ Đã kết nối TCP');
  client.end();
});

client.on('error', (err) => {
  console.log('❌ Lỗi:', err.message);
});

setTimeout(() => {
  console.log('⏱️ Timeout');
  process.exit(1);
}, 10000);
