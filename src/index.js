const { startGuard, stopGuard } = require('./guard');

startGuard();

process.on('SIGINT', () => {
  log('main', 'Đang tắt bot...', '👋');
  stopGuard();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('main', 'Received SIGTERM, shutting down...', '👋');
  stopGuard();
  process.exit(0);
});

const { log } = require('./logger');
