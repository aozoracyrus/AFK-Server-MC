const TAG_COLORS = {
  init: '🔵',
  origin: '📡',
  verify: '🎯',
  auth: '🔐',
  main: '🤖',
  watchdog: '⏱️',
  reconnect: '🔄',
  kick: '❌',
  error: '⚠️',
  end: '🔌',
  spawn: '🌍',
  chat: '💬',
  notify: '📢',
};

function log(tag, msg, emoji = '') {
  const time = new Date().toISOString();
  const color = TAG_COLORS[tag] || '📝';
  const prefix = emoji || color;
  console.log(`${time} [${tag}] ${prefix} ${msg}`);
}

module.exports = { log };
