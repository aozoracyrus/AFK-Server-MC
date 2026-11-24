'use strict';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const str = (v, d) => (v === undefined || v === '' ? d : String(v).trim());

/** So sánh version "26.3" / "1.21.11" -> -1 | 0 | 1 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const serverVersion = str(process.env.MC_SERVER_VERSION, '26.3');
const needsGuard = cmpVersion(serverVersion, '26.3') >= 0;
const rawMode = str(process.env.AFK_MODE, 'auto').toLowerCase();

const config = {
  mc: {
    host: str(process.env.MC_HOST, ''),
    port: num(process.env.MC_PORT, 25565),
    username: str(process.env.MC_USERNAME, 'AFK_Bot'),
    version: str(process.env.MC_VERSION, '26.1'),
    serverVersion,
    auth: str(process.env.MC_AUTH, 'offline').toLowerCase(),
    profilesFolder: str(process.env.MC_PROFILES_FOLDER, './.mc-profiles'),
    viewDistance: str(process.env.MC_VIEW_DISTANCE, 'tiny'),
    spawnTimeoutMs: num(process.env.MC_SPAWN_TIMEOUT_MS, 60000),
    checkTimeoutMs: num(process.env.MC_CHECK_TIMEOUT_MS, 60000),
    tickEnd: bool(process.env.MC_TICK_END, true),

    // Đăng nhập: bạn tự register acc trước, bot chỉ gửi lệnh này.
    password: process.env.MC_PASSWORD || '',
    loginCommand: str(process.env.MC_LOGIN_COMMAND, '/login {password}'),
    loginDelayMs: num(process.env.MC_LOGIN_DELAY_MS, 5000),
    loginSettleMs: num(process.env.MC_LOGIN_SETTLE_MS, 3000),
    loginOnEverySpawn: bool(process.env.MC_LOGIN_ON_EVERY_SPAWN, false),

    joinCommands: str(process.env.MC_JOIN_COMMANDS, '').split(';;').map((s) => s.trim()).filter(Boolean),
    joinCommandDelayMs: num(process.env.MC_JOIN_COMMAND_DELAY_MS, 2000),
  },

  afk: {
    enabled: bool(process.env.AFK_ENABLED, true),
    mode: rawMode === 'auto' ? (needsGuard ? 'freeze' : 'native') : rawMode,
    minIntervalMs: num(process.env.AFK_MIN_INTERVAL_MS, 25000),
    maxIntervalMs: num(process.env.AFK_MAX_INTERVAL_MS, 60000),
    autoEat: bool(process.env.AFK_AUTO_EAT, true),
    chatMessage: str(process.env.AFK_CHAT_MESSAGE, ''),
    chatIntervalMs: num(process.env.AFK_CHAT_INTERVAL_MS, 600000),
  },

  reconnect: {
    minDelayMs: num(process.env.RECONNECT_MIN_DELAY_MS, 15000),
    maxDelayMs: num(process.env.RECONNECT_MAX_DELAY_MS, 300000),
    resetAfterMs: num(process.env.RECONNECT_RESET_AFTER_MS, 60000),
  },

  http: { port: num(process.env.PORT, 8080) },
  notify: {
    webhookUrl: str(process.env.DISCORD_WEBHOOK_URL, ''),
    downAfterMs: num(process.env.NOTIFY_DOWN_AFTER_MS, 300000),
  },
  statsIntervalMs: num(process.env.STATS_INTERVAL_MS, 300000),
  needsGuard,
};

function validate() {
  const e = [];
  if (!config.mc.host) e.push('MC_HOST is required');
  if (!config.mc.username) e.push('MC_USERNAME is required');
  if (config.mc.username.length > 16) e.push('MC_USERNAME must be <= 16 characters');
  if (!['offline', 'microsoft'].includes(config.mc.auth)) e.push('MC_AUTH must be offline|microsoft');
  if (!['native', 'freeze', 'tick'].includes(config.afk.mode)) e.push('AFK_MODE must be auto|native|freeze|tick');
  if (config.afk.minIntervalMs > config.afk.maxIntervalMs) e.push('AFK_MIN_INTERVAL_MS must be <= AFK_MAX_INTERVAL_MS');
  if (config.mc.password && !config.mc.loginCommand.includes('{password}')) {
    e.push('MC_LOGIN_COMMAND must contain {password}');
  }
  if (config.afk.chatMessage && config.afk.chatIntervalMs < 15000) {
    e.push('AFK_CHAT_INTERVAL_MS must be >= 15000 (26.2+ spam threshold)');
  }
  if (e.length) throw new Error('Invalid config:\n  - ' + e.join('\n  - '));
}

module.exports = { config, validate, cmpVersion };
