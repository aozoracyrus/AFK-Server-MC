'use strict';

/* ============================================================================
   mc-afk-bot v7 — Minekube 2 chặng
   1) cracked.minekube.net  -> /browser join <server>
   2) <server>.play.minekube.net -> /register (lần đầu) | /login (lần sau)
   3) AFK freeze mode + client_tick_end guard (luật 26.3)
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
  // --- chặng 1: cổng Minekube ---
  useGateway: bool(process.env.MC_USE_GATEWAY, true),
  gatewayHost: str(process.env.MC_GATEWAY_HOST, 'cracked.minekube.net'),
  gatewayPort: num(process.env.MC_GATEWAY_PORT, 25565),
  gatewayVersion: str(process.env.MC_GATEWAY_VERSION, ''),
  serverName: str(process.env.MC_SERVER_NAME, 'mzero-263'),
  joinCommand: str(process.env.MC_JOIN_COMMAND, '/browser join {server}'),
  joinDelayMs: num(process.env.MC_JOIN_DELAY_MS, 4000),
  gatewayWaitMs: num(process.env.MC_GATEWAY_WAIT_MS, 15000),

  // --- chặng 2: server gốc ---
  originHost: str(process.env.MC_ORIGIN_HOST, 'mzero-263.play.minekube.net'),
  originPort: num(process.env.MC_ORIGIN_PORT, 25565),

  // --- tài khoản ---
  username: str(process.env.MC_USERNAME, 'Guardians'),
  password: process.env.MC_PASSWORD || '',
  registerCommand: str(process.env.MC_REGISTER_COMMAND, '/register {password} {password}'),
  loginCommand: str(process.env.MC_LOGIN_COMMAND, '/login {password}'),
  loginAfterRegister: bool(process.env.MC_LOGIN_AFTER_REGISTER, false),
  firstDelayMs: num(process.env.MC_FIRST_DELAY_MS, 5000),
  stepGapMs: num(process.env.MC_STEP_GAP_MS, 5000),
  settleMs: num(process.env.MC_SETTLE_MS, 4000),
  minGapMs: num(process.env.MC_MIN_GAP_MS, 12000),
  accountTimeoutMs: num(process.env.MC_ACCOUNT_TIMEOUT_MS, 40000),

  // --- protocol ---
  clientVersion: str(process.env.MC_VERSION, '26.1'),
  serverVersion: SERVER_VERSION,
  auth: str(process.env.MC_AUTH, 'offline').toLowerCase(),
  tickEnd: bool(process.env.MC_TICK_END, true),
  viewDistance: str(process.env.MC_VIEW_DISTANCE, 'tiny'),
  spawnTimeoutMs: num(process.env.MC_SPAWN_TIMEOUT_MS, 90000),
  checkTimeoutMs: num(process.env.MC_CHECK_TIMEOUT_MS, 60000),

  // --- afk ---
  mode: MODE_ENV === 'auto' ? (NEEDS_GUARD ? 'freeze' : 'native') : MODE_ENV,
  afkMinMs: num(process.env.AFK_MIN_INTERVAL_MS, 25000),
  afkMaxMs: num(process.env.AFK_MAX_INTERVAL_MS, 60000),
  autoEat: bool(process.env.AFK_AUTO_EAT, true),

  // --- hệ thống ---
  stateFile: str(process.env.STATE_FILE, './.data/state.json'),
  httpPort: num(process.env.PORT, 8080),
  webhook: str(process.env.DISCORD_WEBHOOK_URL, ''),
  downAfterMs: num(process.env.NOTIFY_DOWN_AFTER_MS, 300000),
  statsMs: num(process.env.STATS_INTERVAL_MS, 300000),
  retryMinMs: num(process.env.RECONNECT_MIN_DELAY_MS, 15000),
  retryMaxMs: num(process.env.RECONNECT_MAX_DELAY_MS, 300000),
  resetAfterMs: num(process.env.RECONNECT_RESET_AFTER_MS, 60000),
  hopDelayMs: num(process.env.MC_HOP_DELAY_MS, 3000),

  needsGuard: NEEDS_GUARD,
  selftest: bool(process.env.SELFTEST, false),
};

function validate() {
  const e = [];
  if (!cfg.selftest) {
    if (cfg.useGateway && !cfg.gatewayHost) e.push('MC_GATEWAY_HOST is required');
    if (!cfg.originHost) e.push('MC_ORIGIN_HOST is required');
    if (cfg.useGateway && !cfg.serverName) e.push('MC_SERVER_NAME is required');
  }
  if (!cfg.username) e.push('MC_USERNAME is required');
  if (cfg.username.length > 16) e.push('MC_USERNAME must be <= 16 characters');
  if (!/^[A-Za-z0-9_]+$/.test(cfg.username)) e.push('MC_USERNAME must be A-Z a-z 0-9 _ only');
  if (!['offline', 'microsoft'].includes(cfg.auth)) e.push('MC_AUTH must be offline|microsoft');
  if (!['native', 'freeze', 'tick'].includes(cfg.mode)) e.push('AFK_MODE must be auto|native|freeze|tick');
  if (cfg.afkMinMs > cfg.afkMaxMs) e.push('AFK_MIN_INTERVAL_MS must be <= AFK_MAX_INTERVAL_MS');
  if (cfg.password && cfg.loginCommand.indexOf('{password}') === -1) e.push('MC_LOGIN_COMMAND must contain {password}');
  if (cfg.password && cfg.registerCommand.indexOf('{password}') === -1) e.push('MC_REGISTER_COMMAND must contain {password}');
  if (cfg.joinCommand.indexOf('{server}') === -1) e.push('MC_JOIN_COMMAND must contain {server}');
  if (cfg.minGapMs < 11000) e.push('MC_MIN_GAP_MS must be >= 11000');
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
   3. NOTIFY
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
   4. STATE — nhớ đã register
   ========================================================================== */

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
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
   5. GUARD — luật 26.3
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
    try { origWrite('tick_end', {}); canTickEnd = true; } catch (err) { canTickEnd = false; }
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
        try { origWrite('tick_end', {}); stats.tickEndSent++; } catch (err) { /* ignore */ }
      }
    }
    return result;
  };

  glog.info('guard installed', { mode: mode, canTickEnd: canTickEnd });
  return { stats: function () { return Object.assign({}, stats); } };
}

/* ============================================================================
   6. ACCOUNT — chạy ở CHẶNG 2
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
    const t = setTimeout(function () { timers.delete(t); fn(); }, ms);
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
    if (cfg.loginAfterRegister) {
      later(doLogin, ok ? cfg.stepGapMs : cfg.minGapMs);
    } else {
      // PAL tự login sau khi register
      later(function () { markRegistered(); markReady('registered'); }, cfg.settleMs);
    }
  }

  function handleMessage(raw) {
    if (stopped) return;
    const m = String(raw || '');
    if (RX.wrong.test(m)) { stopped = true; clearAll(); onFatal('wrong-password'); return; }
    if (RX.regOk.test(m)) { markRegistered(); markReady('server-message'); return; }
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
    later(function () { markReady('fallback'); }, cfg.accountTimeoutMs);
  }

  function stop() { stopped = true; clearAll(); }

  return { start: start, stop: stop, handleMessage: handleMessage };
}

/* ============================================================================
   7. SESSION — 1 kết nối (gateway hoặc origin)
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

function runSession(state, signal, events, target) {
  return new Promise(function (resolve) {
    const blog = createLogger(target.kind);

    let done = false;
    let phase = target.kind;          // 'gateway' | 'origin'
    let activityStarted = false;
    let guardInstalled = false;
    let spawnCount = 0;
    let guard = null;
    let account = null;
    let eating = false;
    let afkTimer = null;
    let spawnTimer = null;
    let statsTimer = null;
    let gatewayTimer = null;
    let nextHop = null;               // 'origin' | 'gateway' | {host,port}
    let errorCode = null;
    let kickReason = null;
    const pending = new Set();

    function later(fn, ms) {
      const t = setTimeout(function () { pending.delete(t); fn(); }, ms);
      pending.add(t);
      return t;
    }

    blog.info('connecting', {
      target: target.host + ':' + target.port,
      phase: phase,
      user: cfg.username,
      client: target.version || cfg.clientVersion,
    });

    let bot;
    try {
      bot = mineflayer.createBot({
        host: target.host,
        port: target.port,
        username: cfg.username,
        auth: cfg.auth,
        version: (target.version || cfg.clientVersion) || undefined,
        checkTimeoutInterval: cfg.checkTimeoutMs,
        hideErrors: true,
        logErrors: false,
      });
    } catch (err) {
      blog.error('createBot failed', { msg: err.message });
      resolve({ reason: 'createBot: ' + err.message, next: null, errorCode: 'CREATE' });
      return;
    }

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(afkTimer);
      clearTimeout(spawnTimer);
      clearTimeout(gatewayTimer);
      clearInterval(statsTimer);
      for (const t of pending) clearTimeout(t);
      pending.clear();
      if (account) account.stop();
      if (signal) signal.removeEventListener('abort', onAbort);
      state.connected = false;
      state.ready = false;
      state.phase = phase;
      state.lastReason = reasonText(reason);
      try { bot.quit('bye'); } catch (err) { /* ignore */ }
      try { bot.end(); } catch (err) { /* ignore */ }
      events.emit('offline', { reason: state.lastReason });
      resolve({ reason: state.lastReason, next: nextHop, errorCode: errorCode, kick: kickReason });
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
      } catch (err) { return; }
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

    function beginOrigin(why) {
      phase = 'origin';
      state.phase = 'origin';
      state.atOrigin = true;
      clearTimeout(gatewayTimer);
      blog.info('arrived at origin', { why: why });
      events.emit('origin', {});
      if (cfg.password) {
        account = createAccount({
          send: safeChat,
          alog: blog.child('acc'),
          info: state.account,
          onReady: startActivity,
          onFatal: function (w) { finish('account:' + w); },
        });
        account.start();
      } else {
        startActivity();
      }
    }

    function sendGatewayJoin() {
      if (done || phase !== 'gateway') return;
      const cmd = cfg.joinCommand.split('{server}').join(cfg.serverName);
      blog.info('send gateway join', { cmd: cmd });
      safeChat(cmd);
      gatewayTimer = setTimeout(function () {
        if (done || phase !== 'gateway') return;
        blog.info('no server-switch seen -> try direct origin connect');
        nextHop = 'origin';
        finish('gateway-timeout');
      }, cfg.gatewayWaitMs);
    }

    bot.once('login', function () { blog.info('login ok', { version: bot.version }); });

    bot.on('spawn', function () {
      spawnCount += 1;
      clearTimeout(spawnTimer
