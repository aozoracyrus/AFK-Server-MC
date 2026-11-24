'use strict';

const mineflayer = require('mineflayer');
const { installGuard } = require('./guard');

/** Đổi kick reason (string / JSON chat component) thành text dễ đọc. */
function reasonText(reason) {
  if (reason === null || reason === undefined) return 'unknown';
  if (typeof reason === 'string') {
    try { return reasonText(JSON.parse(reason)); } catch { return reason; }
  }
  if (typeof reason === 'object') {
    if (reason.translate) {
      const args = Array.isArray(reason.with) ? reason.with.map(reasonText).join(' ') : '';
      return `${reason.translate} ${args}`.trim();
    }
    const extra = Array.isArray(reason.extra) ? reason.extra.map(reasonText).join('') : '';
    if (reason.text !== undefined || extra) return `${reason.text || ''}${extra}`;
    try { return JSON.stringify(reason); } catch { return 'unserializable'; }
  }
  return String(reason);
}

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

/** Chạy 1 session. Resolve khi kết thúc. Reconnect do index.js lo. */
function runSession(cfg, log, state, signal, events) {
  return new Promise((resolve) => {
    let done = false;
    let activityStarted = false;
    let guardInstalled = false;
    let spawnCount = 0;
    let lastLoginAt = 0;
    let afkTimer = null;
    let chatTimer = null;
    let spawnTimer = null;
    let statsTimer = null;
    let guard = null;
    let eating = false;
    const pending = new Set();

    const later = (fn, ms) => {
      const t = setTimeout(() => { pending.delete(t); fn(); }, ms);
      pending.add(t);
      return t;
    };

    log.info('connecting', {
      target: `${cfg.mc.host}:${cfg.mc.port}`,
      user: cfg.mc.username,
      clientVersion: cfg.mc.version,
      serverVersion: cfg.mc.serverVersion,
      mode: cfg.afk.mode,
      login: Boolean(cfg.mc.password),
    });

    const bot = mineflayer.createBot({
      host: cfg.mc.host,
      port: cfg.mc.port,
      username: cfg.mc.username,
      auth: cfg.mc.auth,
      version: cfg.mc.version || undefined,
      profilesFolder: cfg.mc.profilesFolder,
      checkTimeoutInterval: cfg.mc.checkTimeoutMs,
      hideErrors: true,
      logErrors: false,
      onMsaCode: (d) => log.warn('MSA device code', { code: d.user_code, uri: d.verification_uri }),
    });

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(afkTimer); clearTimeout(chatTimer); clearTimeout(spawnTimer);
      clearInterval(statsTimer);
      for (const t of pending) clearTimeout(t);
      pending.clear();
      if (signal) signal.removeEventListener('abort', onAbort);
      state.connected = false;
      state.lastReason = reasonText(reason);
      try { bot.quit('afk-bot-shutdown'); } catch { /* ignore */ }
      try { bot.end(); } catch { /* ignore */ }
      events.emit('offline', { reason: state.lastReason });
      resolve({ reason: state.lastReason });
    }

    function onAbort() { finish('shutdown'); }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) return finish('shutdown');
    }

    function safeChat(cmd) {
      if (done) return;
      try { bot.chat(cmd); } catch (err) { log.warn('chat failed', { err: err.message }); }
    }

    /** Gửi lệnh đăng nhập rồi bật AFK. Không mật khẩu -> bật AFK luôn. */
    function scheduleLogin() {
      if (!cfg.mc.password) { startActivity(); return; }
      const now = Date.now();
      if (now - lastLoginAt < 12000) { startActivity(); return; }
      lastLoginAt = now;

      later(() => {
        if (done) return;
        log.info('send login', { cmd: cfg.mc.loginCommand.split(' ')[0] });
        safeChat(cfg.mc.loginCommand.replace(/\{password\}/g, cfg.mc.password));
        later(startActivity, cfg.mc.loginSettleMs);
      }, cfg.mc.loginDelayMs);
    }

    function startActivity() {
      if (activityStarted || done) return;
      activityStarted = true;
      state.ready = true;

      cfg.mc.joinCommands.forEach((cmd, i) => {
        later(() => {
          log.info('join command', { cmd: cmd.split(' ')[0] });
          safeChat(cmd);
        }, cfg.mc.joinCommandDelayMs * (i + 1));
      });

      if (cfg.afk.enabled) afkTimer = setTimeout(afkTick, rand(3000, 8000));

      if (cfg.afk.chatMessage) {
        const loop = () => {
          if (done) return;
          safeChat(cfg.afk.chatMessage);
          chatTimer = setTimeout(loop, cfg.afk.chatIntervalMs);
        };
        chatTimer = setTimeout(loop, cfg.afk.chatIntervalMs);
      }
      log.info('activity started', { mode: cfg.afk.mode });
    }

    function afkTick() {
      if (done || !state.connected) return;
      try {
        if (cfg.afk.mode === 'tick') {
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 1.2, false);
          if (Math.random() < 0.5) {
            bot.setControlState('jump', true);
            later(() => bot.setControlState('jump', false), 320);
          }
        } else {
          // native + freeze: chỉ packet reset idle-timeout, không di chuyển
          const acts = [
            () => { try { bot.swingArm('right'); } catch { bot.swingArm(); } },
            () => { bot.setControlState('sneak', true); later(() => bot.setControlState('sneak', false), 400); },
            () => bot.setQuickBarSlot(rand(0, 8)),
          ];
          acts[rand(0, acts.length)]();
        }
      } catch (err) {
        log.debug('afk tick skipped', { err: err.message });
      }
      afkTimer = setTimeout(afkTick, rand(cfg.afk.minIntervalMs, cfg.afk.maxIntervalMs));
    }

    async function autoEat() {
      if (eating || !cfg.afk.autoEat || !state.connected || !activityStarted) return;
      if (typeof bot.food !== 'number' || bot.food > 17) return;
      const foods = (bot.registry && bot.registry.foodsByName) || {};
      const item = bot.inventory.items().find((i) => foods[i.name]);
      if (!item) return;
      eating = true;
      try {
        await bot.equip(item, 'hand');
        await bot.consume();
        log.info('auto-eat', { item: item.name, food: bot.food });
      } catch (err) {
        log.debug('auto-eat failed', { err: err.message });
      } finally {
        eating = false;
      }
    }

    bot.once('login', () => log.info('login ok', { version: bot.version }));

    bot.on('spawn', () => {
      spawnCount += 1;
      clearTimeout(spawnTimer);

      if (!guardInstalled) {
        guardInstalled = true;
        if (cfg.needsGuard && cfg.afk.mode !== 'native') {
          guard = installGuard(bot, log.child('guard'), { mode: cfg.afk.mode, tickEnd: cfg.mc.tickEnd });
        } else {
          log.info('guard not needed', { serverVersion: cfg.mc.serverVersion, mode: cfg.afk.mode });
        }
        if (cfg.afk.mode === 'freeze') bot.physicsEnabled = false;
        try {
          if (typeof bot.setSettings === 'function') bot.setSettings({ viewDistance: cfg.mc.viewDistance });
        } catch { /* server cũ */ }
      }

      state.connected = true;
      state.lastConnectedAt = new Date().toISOString();
      if (spawnCount === 1) state.sessions += 1;

      const p = bot.entity && bot.entity.position;
      log.info('spawned', {
        n: spawnCount,
        pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
        dim: bot.game && bot.game.dimension,
        ping: bot.player && bot.player.ping,
      });

      if (spawnCount === 1) {
        events.emit('online', { sessions: state.sessions });
        scheduleLogin();
      } else if (cfg.mc.loginOnEverySpawn) {
        scheduleLogin();
      }

      if (!statsTimer) {
        statsTimer = setInterval(() => {
          if (done || !state.connected) return;
          log.info('stats', {
            mode: cfg.afk.mode,
            ready: state.ready,
            spawns: spawnCount,
            guard: guard ? guard.stats() : null,
            ping: bot.player && bot.player.ping,
            health: bot.health,
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
          });
        }, cfg.statsIntervalMs);
      }
    });

    bot.on('health', () => { autoEat(); });
    bot.on('death', () => { log.warn('died -> respawning'); try { bot.respawn(); } catch { /* ignore */ } });
    bot.on('kicked', (r) => log.warn('kicked', { reason: reasonText(r) }));
    bot.on('error', (err) => log.error('bot error', { code: err.code, msg: err.message }));
    bot.on('end', (r) => finish(r || 'ended'));
    bot.on('messagestr', (msg) => log.debug('chat', { msg }));

    spawnTimer = setTimeout(() => {
      if (!state.connected) { log.warn('spawn timeout'); finish('spawn-timeout'); }
    }, cfg.mc.spawnTimeoutMs);
  });
}

module.exports = { runSession, reasonText };
