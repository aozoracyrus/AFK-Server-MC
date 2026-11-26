'use strict';

/* ============================================================================
   mc-afk-bot v6 — single file
   Paper 26.3 + ViaVersion/ViaBackwards + plugin login (PAL)
   - Lần đầu: /register <pass> <pass> -> /login <pass>
   - Lần sau: /login <pass>
   - AFK freeze mode + client_tick_end guard cho luật 26.3
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const mineflayer = require('mineflayer');

/* ============================================================================
   1. HELPERS + CONFIG
   ========================================================================== */

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const str = (v, d) => (v === undefined || v === '' ? d : String(v).trim());
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const SERVER_VERSION = str(process.env.MC_SERVER_VERSION, '26.3');
const NEEDS_GUARD = cmpVersion(SERVER_VERSION, '26.3') >= 0;
const MODE_ENV = str(process.env.AFK_MODE, 'auto').toLowerCase();

const cfg = {
  host: str(process.env.MC_HOST, ''),
  port: num(process.env.MC_PORT, 25565),
  username: str(process.env.MC_USERNAME, 'AFK_Bot'),
  password: process.env.MC_PASSWORD || '',
  clientVersion: str(process.env.MC_VERSION, '26.1'),
  serverVersion: SERVER_VERSION,
  auth: str(process.env.MC_AUTH, 'offline').toLowerCase(),

  registerCommand: str(process.env.MC_REGISTER_COMMAND, '/register {password} {password}'),
  loginCommand: str(process.env.MC_LOGIN_COMMAND, '/login {password}'),
  firstDelayMs: num(process.env.MC_FIRST_DELAY_MS, 6000),
  stepGapMs: num(process.env.MC_STEP_GAP_MS, 5000),
  settleMs: num(process.env.MC_SETTLE_MS, 4000),
  minGapMs: num(process.env.MC_MIN_GAP_MS, 12000),
  accountTimeoutMs: num(process.env.MC_ACCOUNT_TIMEOUT_MS, 40000),

  tickEnd: bool(process.env.MC_TICK_END, true),
  viewDistance: str(process.env.MC_VIEW_DISTANCE, 'tiny'),
  spawnTimeoutMs: num(process.env.MC_SPAWN_TIMEOUT_MS, 90000),
  checkTimeoutMs: num(process.env.MC_CHECK_TIMEOUT_MS, 60000),

  mode: MODE_ENV === 'auto' ? (NEEDS_GUARD ? 'freeze' : 'native') : MODE_ENV,
  afkMinMs: num(process.env.AFK_MIN_INTERVAL_MS, 25000),
  afkMaxMs: num(process.env.AFK_MAX_INTERVAL_MS, 60000),
  autoEat: bool(process.env.AFK_AUTO_EAT, true),

  stateFile: str(process.env.STATE_FILE, './.data/state.json'),
  httpPort: num(process.env.PORT, 8080),
  webhook: str(process.env.DISCORD_WEBHOOK_URL, ''),
  downAfterMs: num(process.env.NOTIFY_DOWN_AFTER_MS, 300000),
  statsMs: num(process.env.STATS_INTERVAL_MS, 300000),
  retryMinMs: num(process.env.RECONNECT_MIN_DELAY_MS, 15000),
  retryMaxMs: num(process.env.RECONNECT_MAX_DELAY_MS, 300000),
  resetAfterMs: num(process.env.RECONNECT_RESET_AFTER_MS, 60000),

  needsGuard: NEEDS_GUARD,
  selftest: bool(process.env.SELFTEST, false),
};

function validate() {
  const e = [];
  if (!cfg.selftest && !cfg.host) e.push('MC_HOST is required');
  if (!cfg.username) e.push('MC_USERNAME is required');
  if (cfg.username.length > 16) e.push('MC_USERNAME must be <= 16 characters');
  if (!/^[A-Za-z0-9_]+$/.test(cfg.username)) e.push('MC_USERNAME must be A-Z a-z 0-9 _ only');
  if (!['offline', 'microsoft'].includes(cfg.auth)) e.push('MC_AUTH must be offline|microsoft');
  if (!['native', 'freeze', 'tick'].includes(cfg.mode)) e.push('AFK_MODE must be auto|native|freeze|tick');
  if (cfg.afkMinMs > cfg.afkMaxMs) e.push('AFK_MIN_INTERVAL_MS must be <= AFK_MAX_INTERVAL_MS');
  if (cfg.password && cfg.loginCommand.indexOf('{password}') === -1) e.push('MC_LOGIN_COMMAND must contain {password}');
  if (cfg.password && cfg.registerCommand.indexOf('{password}') === -1) e.push('MC_REGISTER_COMMAND must contain {password}');
  if (cfg.minGapMs < 11000) e.push('MC_MIN_GAP_MS must be >= 11000 (26.2+ command spam threshold)');
  if (e.length) throw new Error('Invalid config:\n  - ' + e.join('\n  - '));
}

/* ============================================================================
   2. LOGGER
   ========================================================================== */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function createLogger(scope) {
  function emit(level, msg, meta) {
    if (LEVELS[level] < THRESHOLD) return;
    let tail = '';
    if (meta !== undefined) {
      try { tail = ' ' + JSON.stringify(meta); } catch (err) { tail = ' [unserializable]'; }
    }
    const line = new Date().toISOString() + ' ' + level.toUpperCase().padEnd(5) + ' [' + scope + '] ' + msg + tail;
    if (level === 'error') console.error(line);
    else console.log(line);
  }
  return {
    debug: function (m, x) { emit('debug', m, x); },
    info: function (m, x) { emit('info', m, x); },
    warn: function (m, x) { emit('warn', m, x); },
    error: function (m, x) { emit('error', m, x); },
    child: function (s) { return createLogger(scope + ':' + s); },
  };
}

const log = createLogger('main');

/* ============================================================================
   3. NOTIFY — Discord webhook (chỉ gửi ra)
   ========================================================================== */

function createNotifier(url) {
  if (!url) return { send: function () { return Promise.resolve(); } };
  const nlog = createLogger('notify');
  let queue = Promise.resolve();

  async function post(content) {
    const ac = new AbortController();
    const timer = setTimeout(function () { ac.abort(); }, 10000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: String(content).slice(0, 1900) }),
        signal: ac.signal,
      });
      if (!res.ok) nlog.warn('webhook failed', { status: res.status });
    } catch (err) {
      nlog.warn('webhook error', { msg: err.message });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    send: function (content) {
      queue = queue.then(function () { return post(content); }).catch(function () {});
      return queue;
    },
  };
}

const notify = createNotifier(cfg.webhook);

/* ============================================================================
   4. STATE — nhớ đã register (mất file cũng tự nhận lại được)
   ========================================================================== */

function loadState() {
  try {
    const raw = fs.readFileSync(cfg.stateFile, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    return {};
  }
}

function saveState(obj) {
  try {
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    fs.writeFileSync(cfg.stateFile, JSON.stringify(obj, null, 2));
    return true;
  } catch (err) {
    log.debug('state save skipped', { msg: err.message });
    return false;
  }
}

/* ============================================================================
   5. GUARD — luật "1 position packet / client tick" của 26.3
   ========================================================================== */

const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);

function installGuard(bot, glog, mode, tickEnd) {
  const client = bot._client;
  if (!client || typeof client.write !== 'function') {
    glog.warn('guard skipped: client not ready');
    return null;
  }
  const origWrite = client.write.bind(client);

  let canTickEnd = false;
  if (tickEnd) {
    try {
      origWrite('tick_end', {});
      canTickEnd = true;
    } catch (err) {
      canTickEnd = false;
    }
  }

  const stats = { moveSent: 0, moveDropped: 0, tickEndSent: canTickEnd ? 1 : 0 };

  client.write = function (name, packet) {
    if (mode === 'freeze' && MOVE_PACKETS.has(name)) {
      stats.moveDropped++;
      return undefined;
    }
    const result = origWrite(name, packet);
    if (MOVE_PACKETS.has(name)) {
      stats.moveSent++;
      if (canTickEnd) {
        try {
          origWrite('tick_end', {});
          stats.tickEndSent++;
        } catch (err) { /* ignore */ }
      }
    }
    return result;
  };

  glog.info('guard installed', { mode: mode, canTickEnd: canTickEnd });
  return { stats: function () { return Object.assign({}, stats); } };
}

/* ============================================================================
   6. ACCOUNT — register lần đầu, login các lần sau
   ========================================================================== */

const RX = {
  wrong: /wrong password|incorrect password|invalid password|sai mật khẩu/i,
  regOk: /successfully registered|registered successfully|đăng ký thành công/i,
  regDup: /already registered|already exists|account exists|đã được đăng ký/i,
  needReg: /not registered|please register|chưa đăng ký|\/register\b|\/reg\b/i,
  loginOk: /successfully logged in|already logged in|logged in successfully|đăng nhập thành công/i,
};

function createAccount(opts) {
  const send = opts.send;
  const alog = opts.alog;
  const onReady = opts.onReady;
  const onFatal = opts.onFatal;
  const info = opts.info;

  let registered = Boolean(loadState()[cfg.username]);
  let ready = false;
  let stopped = false;
  const lastSent = {};
  const timers = new Set();

  info.registered = registered;
  info.ready = false;

  function later(fn, ms) {
    const t = setTimeout(function () {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  function clearAll() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function markRegistered() {
    info.registered = true;
    if (registered) return;
    registered = true;
    const s = loadState();
    s[cfg.username] = true;
    saveState(s);
    alog.info('registered flag saved', { user: cfg.username });
  }

  function sendCmd(kind) {
    if (stopped) return false;
    const now = Date.now();
    if (lastSent[kind] && now - lastSent[kind] < cfg.minGapMs) return false;
    lastSent[kind] = now;
    const tpl = kind === 'register' ? cfg.registerCommand : cfg.loginCommand;
    alog.info('send', { cmd: tpl.split(' ')[0] });
    send(tpl.split('{password}').join(cfg.password));
    return true;
  }

  function markReady(why) {
    if (ready || stopped) return;
    ready = true;
    info.ready = true;
    clearAll();
    alog.info('ready', { why: why, registered: registered });
    onReady();
  }

  function doLogin() {
    if (stopped || ready) return;
    sendCmd('login');
    later(function () { markReady('settle'); }, cfg.settleMs);
  }

  function doRegister() {
    if (stopped || ready) return;
    const ok = sendCmd('register');
    later(doLogin, ok ? cfg.stepGapMs : cfg.minGapMs);
  }

  function handleMessage(raw) {
    if (stopped) return;
    const m = String(raw || '');
    if (RX.wrong.test(m)) {
      stopped = true;
      clearAll();
      onFatal('wrong-password');
      return;
    }
    if (RX.regOk.test(m)) { markRegistered(); doLogin(); return; }
    if (RX.regDup.test(m)) { markRegistered(); doLogin(); return; }
    if (RX.loginOk.test(m)) { markRegistered(); markReady('server-message'); return; }
    if (RX.needReg.test(m)) { registered = false; info.registered = false; doRegister(); }
  }

  function start() {
    alog.info('account start', { user: cfg.username, registered: registered });
    later(function () {
      if (registered) doLogin();
      else doRegister();
    }, cfg.firstDelayMs);
    // Lưới an toàn: dù không khớp thông báo nào vẫn bật AFK
    later(function () { markReady('fallback'); }, cfg.accountTimeoutMs);
  }

  function stop() {
    stopped = true;
    clearAll();
  }

  return { start: start, stop: stop, handleMessage: handleMessage };
}

/* ============================================================================
   7. SESSION
   ========================================================================== */

function reasonText(reason) {
  if (reason === null || reason === undefined) return 'unknown';
  if (typeof reason === 'string') {
    try { return reasonText(JSON.parse(reason)); } catch (err) { return reason; }
  }
  if (typeof reason === 'object') {
    if (reason.translate) {
      const args = Array.isArray(reason.with) ? reason.with.map(reasonText).join(' ') : '';
      return (String(reason.translate) + ' ' + args).trim();
    }
    const extra = Array.isArray(reason.extra) ? reason.extra.map(reasonText).join('') : '';
    if (reason.text !== undefined || extra) return String(reason.text || '') + extra;
    try { return JSON.stringify(reason); } catch (err) { return 'unserializable'; }
  }
  return String(reason);
}

function runSession(state, signal, events) {
  return new Promise(function (resolve) {
    const blog = createLogger('bot');

    let done = false;
    let activityStarted = false;
    let guardInstalled = false;
    let spawnCount = 0;
    let guard = null;
    let account = null;
    let eating = false;
    let afkTimer = null;
    let spawnTimer = null;
    let statsTimer = null;
    const pending = new Set();

    function later(fn, ms) {
      const t = setTimeout(function () {
        pending.delete(t);
        fn();
      }, ms);
      pending.add(t);
      return t;
    }

    blog.info('connecting', {
      target: cfg.host + ':' + cfg.port,
      user: cfg.username,
      client: cfg.clientVersion,
      server: cfg.serverVersion,
      mode: cfg.mode,
    });

    let bot;
    try {
      bot = mineflayer.createBot({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth: cfg.auth,
        version: cfg.clientVersion || undefined,
        checkTimeoutInterval: cfg.checkTimeoutMs,
        hideErrors: true,
        logErrors: false,
      });
    } catch (err) {
      blog.error('createBot failed', { msg: err.message });
      state.lastReason = 'createBot: ' + err.message;
      resolve({ reason: state.lastReason });
      return;
    }

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(afkTimer);
      clearTimeout(spawnTimer);
      clearInterval(statsTimer);
      for (const t of pending) clearTimeout(t);
      pending.clear();
      if (account) account.stop();
      if (signal) signal.removeEventListener('abort', onAbort);
      state.connected = false;
      state.ready = false;
      state.lastReason = reasonText(reason);
      try { bot.quit('bye'); } catch (err) { /* ignore */ }
      try { bot.end(); } catch (err) { /* ignore */ }
      events.emit('offline', { reason: state.lastReason });
      resolve({ reason: state.lastReason });
    }

    function onAbort() { finish('shutdown'); }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { finish('shutdown'); return; }
    }

    function safeChat(cmd) {
      if (done) return;
      try { bot.chat(cmd); } catch (err) { blog.warn('chat failed', { msg: err.message }); }
    }

    function startActivity() {
      if (activityStarted || done) return;
      activityStarted = true;
      state.ready = true;
      blog.info('activity started', { mode: cfg.mode });
      afkTimer = setTimeout(afkTick, rand(3000, 8000));
    }

    function afkTick() {
      if (done || !state.connected) return;
      try {
        if (cfg.mode === 'tick') {
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 1.2, false);
          if (Math.random() < 0.5) {
            bot.setControlState('jump', true);
            later(function () {
              try { bot.setControlState('jump', false); } catch (err) { /* ignore */ }
            }, 320);
          }
        } else {
          const pick = rand(0, 3);
          if (pick === 0) {
            try { bot.swingArm('right'); } catch (err) { try { bot.swingArm(); } catch (e2) { /* ignore */ } }
          } else if (pick === 1) {
            bot.setControlState('sneak', true);
            later(function () {
              try { bot.setControlState('sneak', false); } catch (err) { /* ignore */ }
            }, 400);
          } else {
            bot.setQuickBarSlot(rand(0, 8));
          }
        }
      } catch (err) {
        blog.debug('afk tick skipped', { msg: err.message });
      }
      afkTimer = setTimeout(afkTick, rand(cfg.afkMinMs, cfg.afkMaxMs));
    }

    async function autoEat() {
      if (eating || !cfg.autoEat || !state.connected || !activityStarted) return;
      if (typeof bot.food !== 'number' || bot.food > 17) return;
      let item = null;
      try {
        const foods = (bot.registry && bot.registry.foodsByName) || {};
        item = bot.inventory.items().find(function (i) { return Boolean(foods[i.name]); });
      } catch (err) {
        return;
      }
      if (!item) return;
      eating = true;
      try {
        await bot.equip(item, 'hand');
        await bot.consume();
        blog.info('auto-eat', { item: item.name });
      } catch (err) {
        blog.debug('auto-eat failed', { msg: err.message });
      } finally {
        eating = false;
      }
    }

    bot.once('login', function () {
      blog.info('login ok', { version: bot.version });
    });

    bot.on('spawn', function () {
      spawnCount += 1;
      clearTimeout(spawnTimer);

      if (!guardInstalled) {
        guardInstalled = true;
        if (cfg.needsGuard && cfg.mode !== 'native') {
          guard = installGuard(bot, blog.child('guard'), cfg.mode, cfg.tickEnd);
        } else {
          blog.info('guard not needed', { server: cfg.serverVersion, mode: cfg.mode });
        }
        if (cfg.mode === 'freeze') {
          try { bot.physicsEnabled = false; } catch (err) { /* ignore */ }
        }
        try {
          if (typeof bot.setSettings === 'function') bot.setSettings({ viewDistance: cfg.viewDistance });
        } catch (err) { /* ignore */ }
      }

      state.connected = true;
      state.lastConnectedAt = new Date().toISOString();
      if (spawnCount === 1) state.sessions += 1;

      let pos = null;
      try {
        const p = bot.entity && bot.entity.position;
        if (p) pos = { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)), z: Number(p.z.toFixed(1)) };
      } catch (err) { /* ignore */ }

      blog.info('spawned', {
        n: spawnCount,
        pos: pos,
        ping: bot.player && bot.player.ping,
      });

      if (spawnCount === 1) {
        events.emit('online', { sessions: state.sessions });
        if (cfg.password) {
          account = createAccount({
            send: safeChat,
            alog: blog.child('acc'),
            info: state.account,
            onReady: startActivity,
            onFatal: function (why) { finish('account:' + why); },
          });
          account.start();
        } else {
          startActivity();
        }
      }

      if (!statsTimer) {
        statsTimer = setInterval(function () {
          if (done || !state.connected) return;
          blog.info('stats', {
            mode: cfg.mode,
            ready: state.ready,
            registered: state.account.registered,
            spawns: spawnCount,
            guard: guard ? guard.stats() : null,
            ping: bot.player && bot.player.ping,
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
          });
        }, cfg.statsMs);
      }
    });

    bot.on('messagestr', function (msg) {
      blog.debug('chat', { msg: msg });
      if (account) account.handleMessage(msg);
    });

    bot.on('health', function () { autoEat(); });

    bot.on('death', function () {
      blog.warn('died -> respawning');
      try { bot.respawn(); } catch (err) { /* ignore */ }
    });

    bot.on('kicked', function (r) { blog.warn('kicked', { reason: reasonText(r) }); });
    bot.on('error', function (err) { blog.error('bot error', { code: err.code, msg: err.message }); });
    bot.on('end', function (r) { finish(r || 'ended'); });

    spawnTimer = setTimeout(function () {
      if (!state.connected) {
        blog.warn('spawn timeout');
        finish('spawn-timeout');
      }
    }, cfg.spawnTimeoutMs);
  });
}

/* ============================================================================
   8. SUPERVISOR + HTTP
   ========================================================================== */

const events = new EventEmitter();
const shutdown = new AbortController();
const startedAt = Date.now();

const state = {
  connected: false,
  ready: false,
  sessions: 0,
  lastConnectedAt: null,
  lastReason: null,
  attempt: 0,
  account: { registered: false, ready: false },
};

function snapshot() {
  return {
    status: state.connected ? (state.ready ? 'online' : 'joining') : 'reconnecting',
    target: cfg.host + ':' + cfg.port,
    username: cfg.username,
    clientVersion: cfg.clientVersion,
    serverVersion: cfg.serverVersion,
    mode: cfg.mode,
    registered: state.account.registered,
    sessions: state.sessions,
    attempt: state.attempt,
    lastConnectedAt: state.lastConnectedAt,
    lastReason: state.lastReason,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer(function (req, res) {
  const p = (req.url || '/').split('?')[0];
  if (p === '/ready') return json(res, state.connected && state.ready ? 200 : 503, snapshot());
  if (p === '/health' || p === '/' || p === '/status') return json(res, 200, snapshot());
  return json(res, 404, { error: 'not found' });
});

let downSince = null;
let downTimer = null;

events.on('online', function (payload) {
  clearTimeout(downTimer);
  if (payload.sessions === 1) {
    notify.send('🟢 ' + cfg.username + ' connected @ `' + cfg.host + ':' + cfg.port + '` (mode ' + cfg.mode + ')');
  } else if (downSince) {
    notify.send('🟢 ' + cfg.username + ' reconnected after ~' + Math.round((Date.now() - downSince) / 60000) + ' min');
  }
  downSince = null;
});

events.on('offline', function (payload) {
  downSince = Date.now();
  clearTimeout(downTimer);
  downTimer = setTimeout(function () {
    if (!state.connected && !shutdown.signal.aborted) {
      notify.send('🔴 ' + cfg.username + ' offline > ' + Math.round(cfg.downAfterMs / 60000) + ' min. Reason: ' + payload.reason);
    }
  }, cfg.downAfterMs);
  if (downTimer.unref) downTimer.unref();
});

function sleep(ms, signal) {
  return new Promise(function (resolve) {
    if (signal && signal.aborted) { resolve(); return; }
    function fin() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', fin);
      resolve();
    }
    const t = setTimeout(fin, ms);
    if (signal) signal.addEventListener('abort', fin, { once: true });
  });
}

function backoff(attempt) {
  const base = Math.min(cfg.retryMaxMs, cfg.retryMinMs * Math.pow(2, attempt));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

async function main() {
  validate();

  const bootInfo = {
    target: cfg.host + ':' + cfg.port,
    user: cfg.username,
    client: cfg.clientVersion,
    server: cfg.serverVersion,
    mode: cfg.mode,
    needsGuard: cfg.needsGuard,
    account: Boolean(cfg.password),
    stateFile: cfg.stateFile,
    node: process.version,
  };

  if (cfg.selftest) {
    log.info('SELFTEST OK — config hợp lệ, module load đủ', bootInfo);
    process.exit(0);
    return;
  }

  log.info('boot', bootInfo);

  await new Promise(function (r) { server.listen(cfg.httpPort, '0.0.0.0', r); });
  log.info('http listening', { port: cfg.httpPort, routes: ['/health', '/ready', '/status'] });

  while (!shutdown.signal.aborted) {
    const t0 = Date.now();
    const result = await runSession(state, shutdown.signal, events);
    const uptime = Date.now() - t0;
    if (shutdown.signal.aborted) break;

    state.attempt = uptime > cfg.resetAfterMs ? 0 : state.attempt + 1;
    const delay = backoff(state.attempt);
    log.warn('session ended', {
      reason: result.reason,
      uptimeSec: Math.round(uptime / 1000),
      retryInMs: delay,
      attempt: state.attempt,
    });
    await sleep(delay, shutdown.signal);
  }

  log.info('shutdown complete');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, function () {
    log.info('received ' + sig);
    shutdown.abort();
  });
}
process.on('unhandledRejection', function (e) {
  log.error('unhandledRejection', { msg: String((e && e.message) || e) });
});
process.on('uncaughtException', function (e) {
  log.error('uncaughtException', { msg: e.message });
  shutdown.abort();
});

main().catch(function (err) {
  log.error('fatal', { msg: err.message });
  process.exit(1);
});
