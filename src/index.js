'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');
const mineflayer = require('mineflayer');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const str = (v, d) => (v === undefined || v === '' ? d : String(v).trim());
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function getAutoPassword(username) {
  const salt = "FadeHost_MC_Bot_Secure_Salt_2024";
  let hash = 0;
  const text = username + salt;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  return `Auto_${Math.abs(hash).toString(36).toUpperCase().padEnd(6, 'X')}_${username.substring(0, 4)}`;
}

const SERVER_VERSION = str(process.env.MC_SERVER_VERSION, '26.3');
const NEEDS_GUARD = cmpVersion(SERVER_VERSION, '26.3') >= 0;
const MODE_ENV = str(process.env.AFK_MODE, 'auto').toLowerCase();

const cfg = {
  username: str(process.env.MC_USERNAME, 'Guardians'),
  autoPassword: getAutoPassword(process.env.MC_USERNAME || 'Guardians'),
  clientVersion: str(process.env.MC_VERSION, '26.1'),
  auth: str(process.env.MC_AUTH, 'offline').toLowerCase(),

  gateHost: str(process.env.GATE_HOST, 'cracked.minekube.net'),
  gatePort: num(process.env.GATE_PORT, 25565),
  gateEndpoint: str(process.env.GATE_ENDPOINT, 'mzero-263'),
  gateJoinCmd: str(process.env.GATE_JOIN_CMD, '/browser join {endpoint}'),
  gateDelayMs: num(process.env.GATE_DELAY_MS, 1500),

  originRegCmd: '/register {password} {password}',
  originLoginCmd: '/login {password}',
  originSettle: num(process.env.ORIGIN_SETTLE || 4000, 4000),
  originTimeout: num(process.env.ORIGIN_TIMEOUT || 45000, 45000),

  minGap: num(process.env.MC_MIN_GAP, 12000),
  tickEnd: bool(process.env.MC_TICK_END, true),
  viewDist: str(process.env.MC_VIEW_DIST, 'tiny'),
  spawnTimeout: num(process.env.MC_SPAWN_TIMEOUT, 90000),

  mode: MODE_ENV === 'auto' ? (NEEDS_GUARD ? 'freeze' : 'native') : MODE_ENV,
  afkMin: num(process.env.AFK_MIN, 25000),
  afkMax: num(process.env.AFK_MAX, 60000),
  autoEat: bool(process.env.AFK_AUTO_EAT, true),

  httpPort: num(process.env.PORT, 8080),
  retryMin: num(process.env.RETRY_MIN, 5000),
  retryMax: num(process.env.RETRY_MAX, 120000),
  needsGuard: NEEDS_GUARD,
};

function validate() {
  const e = [];
  if (!cfg.username || cfg.username.length > 16 || !/^[A-Za-z0-9_]+$/.test(cfg.username)) e.push('MC_USERNAME invalid');
  if (!['offline', 'microsoft'].includes(cfg.auth)) e.push('MC_AUTH invalid');
  if (!cfg.gateHost || !cfg.gateEndpoint) e.push('GATE config missing');
  if (cfg.minGap < 11000) e.push('MC_MIN_GAP must be >= 11000');
  if (e.length) throw new Error('Config Error:\n  - ' + e.join('\n  - '));
}

const log = (level, scope, msg, meta) => {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const thresh = levels[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
  if (levels[level] < thresh) return;
  const tail = meta ? ' ' + JSON.stringify(meta) : '';
  const line = new Date().toISOString() + ` ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
  if (level === 'error') console.error(line); else console.log(line);
};

const MOVE_PKTS = new Set(['position', 'position_look', 'look', 'flying']);
function installGuard(bot, mode, tickEnd) {
  const client = bot._client;
  if (!client || typeof client.write !== 'function') return null;
  const orig = client.write.bind(client);
  let canTick = false;
  if (tickEnd) { try { orig('tick_end', {}); canTick = true; } catch (e) {} }
  const stats = { sent: 0, dropped: 0, tick: canTick ? 1 : 0 };
  client.write = (name, pkt) => {
    if (mode === 'freeze' && MOVE_PKTS.has(name)) { stats.dropped++; return; }
    const res = orig(name, pkt);
    if (MOVE_PKTS.has(name)) {
      stats.sent++;
      if (canTick) { try { orig('tick_end', {}); stats.tick++; } catch (e) {} }
    }
    return res;
  };
  return stats;
}

const RX = {
  wrong: /wrong password|incorrect password|invalid password|sai mật khẩu/i,
  regOk: /successfully registered|registered successfully|đăng ký thành công/i,
  regDup: /already registered|already exists|account exists|đã được đăng ký/i,
  needReg: /not registered|please register|chưa đăng ký|\/register\b|\/reg\b/i,
  loginOk: /successfully logged in|already logged in|logged in successfully|đăng nhập thành công/i,
};

function createOriginFlow(send, infoObj, onReady, onFatal) {
  let registered = infoObj.originReg || false;
  let ready = false, stopped = false, lastSent = 0, attempt = 0;
  const timers = new Set();
  const pass = cfg.autoPassword;

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const clear = () => { for (const t of timers) clearTimeout(t); timers.clear(); };

  const sendCmd = (kind, tpl) => {
    if (stopped) return false;
    const now = Date.now();
    if (now - lastSent < cfg.minGap) return false;
    lastSent = now;
    log('info', 'origin', 'send', { cmd: tpl.split(' ')[0], attempt: ++attempt });
    send(tpl.replace('{password}', pass));
    return true;
  };

  const markReady = (why) => {
    if (ready || stopped) return;
    ready = true; infoObj.originReady = true; clear();
    log('info', 'origin', 'ready & AFK', { why, registered });
    onReady();
  };

  const doLogin = () => { if (stopped || ready) return; sendCmd('login', cfg.originLoginCmd); later(() => markReady('settle_login'), cfg.originSettle); };
  const doRegister = () => { if (stopped || ready) return; sendCmd('reg', cfg.originRegCmd); infoObj.originReg = true; later(() => { if (!ready) markReady('settle_reg'); }, cfg.originSettle); };

  const handleMessage = (raw) => {
    if (stopped) return;
    const m = String(raw || '');
    if (RX.wrong.test(m)) { stopped = true; clear(); onFatal('wrong-password'); return; }
    if (RX.regOk.test(m)) { infoObj.originReg = true; markReady('reg_ok'); return; }
    if (RX.regDup.test(m)) { infoObj.originReg = true; doLogin(); return; }
    if (RX.loginOk.test(m)) { infoObj.originReg = true; markReady('login_ok'); return; }
    if (RX.needReg.test(m)) { infoObj.originReg = false; doRegister(); }
  };

  // GỬI NGAY, không delay — vì bot chỉ sống được ~1 giây trước khi bị kick
  const start = () => {
    log('info', 'origin', 'start auth (immediate)', { registered });
    if (registered) doLogin(); else doRegister();
    later(() => markReady('fallback'), cfg.originTimeout);
  };

  return { start, stop: () => { stopped = true; clear(); }, handleMessage };
}

function runSession(state, signal, events) {
  return new Promise((resolve) => {
    let done = false, guard = null, flow = null;
    let afkTimer = null, spawnTimer = null, statsTimer = null;
    let spawnCount = 0, activityStarted = false, eating = false, joinSent = false;
    const pending = new Set();

    const later = (fn, ms) => { const t = setTimeout(() => { pending.delete(t); fn(); }, ms); pending.add(t); return t; };

    log('info', 'main', 'connecting', { target: cfg.gateHost + ':' + cfg.gatePort, user: cfg.username });

    let bot;
    try {
      bot = mineflayer.createBot({
        host: cfg.gateHost, port: cfg.gatePort, username: cfg.username, auth: cfg.auth,
        version: cfg.clientVersion || undefined, checkTimeoutInterval: 90000,
        hideErrors: true, logErrors: false,
      });
    } catch (err) {
      log('error', 'main', 'createBot failed', { msg: err.message });
      resolve({ reason: 'createBot: ' + err.message });
      return;
    }

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(afkTimer); clearTimeout(spawnTimer); clearInterval(statsTimer);
      for (const t of pending) clearTimeout(t); pending.clear();
      if (flow) flow.stop();
      if (signal) signal.removeEventListener('abort', onAbort);
      state.connected = false; state.ready = false; state.lastReason = reason;
      try { bot.quit('bye'); } catch (e) {}
      try { bot.end(); } catch (e) {}
      events.emit('offline', { reason });
      resolve({ reason });
    };

    const onAbort = () => finish('shutdown');
    if (signal) { signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) { finish('shutdown'); return; } }

    const safeChat = (cmd) => { if (!done) try { bot.chat(cmd); } catch (e) {} };

    const startActivity = () => {
      if (activityStarted || done) return;
      activityStarted = true; state.ready = true;
      log('info', 'main', 'ACTIVITY STARTED', { mode: cfg.mode });
      afkTimer = setTimeout(afkTick, rand(3000, 8000));
      events.emit('ready', {});
    };

    const afkTick = () => {
      if (done || !state.connected) return;
      try {
        if (cfg.mode === 'tick') {
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 1.2, false);
          if (Math.random() < 0.5) { bot.setControlState('jump', true); later(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 320); }
        } else {
          const pick = rand(0, 3);
          if (pick === 0) { try { bot.swingArm('right'); } catch (e) { try { bot.swingArm(); } catch (e2) {} } }
          else if (pick === 1) { bot.setControlState('sneak', true); later(() => { try { bot.setControlState('sneak', false); } catch (e) {} }, 400); }
          else { bot.setQuickBarSlot(rand(0, 8)); }
        }
      } catch (e) {}
      afkTimer = setTimeout(afkTick, rand(cfg.afkMin, cfg.afkMax));
    };

    bot.once('login', () => log('info', 'main', 'login ok'));

    bot.on('spawn', () => {
      spawnCount++;
      clearTimeout(spawnTimer);
      if (!guard && cfg.needsGuard && cfg.mode !== 'native') guard = installGuard(bot, cfg.mode, cfg.tickEnd);
      if (cfg.mode === 'freeze') { try { bot.physicsEnabled = false; } catch (e) {} }
      try { if (typeof bot.setSettings === 'function') bot.setSettings({ viewDistance: cfg.viewDist }); } catch (e) {}

      state.connected = true; state.lastConnectedAt = new Date().toISOString();
      if (spawnCount === 1) state.sessions++;
      log('info', 'main', 'spawned', { n: spawnCount, ping: bot.player?.ping });

      // Lần spawn đầu: gửi /browser join
      if (!joinSent) {
        joinSent = true;
        later(() => {
          const cmd = cfg.gateJoinCmd.replace('{endpoint}', cfg.gateEndpoint);
          log('info', 'gate', 'send', { cmd: cmd.split(' ')[0] });
          safeChat(cmd);
          // KHÔNG chờ transfer packet. Sau 1.5s bắt đầu origin flow ngay.
          later(() => {
            log('info', 'main', 'origin flow start (no transfer wait)');
            flow = createOriginFlow(safeChat, state.flags, startActivity, finish);
            flow.start();
          }, cfg.gateDelayMs);
        }, 1000);
      }

      if (!statsTimer) {
        statsTimer = setInterval(() => {
          if (done || !state.connected) return;
          log('info', 'main', 'stats', { mode: cfg.mode, ready: state.ready, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
        }, 60000);
      }
    });

    bot.on('messagestr', (msg) => { if (flow) flow.handleMessage(msg); });
    bot.on('health', async () => {
      if (eating || !cfg.autoEat || !state.connected || !activityStarted) return;
      if (typeof bot.food !== 'number' || bot.food > 17) return;
      try {
        const foods = (bot.registry?.foodsByName) || {};
        const item = bot.inventory.items().find(i => foods[i.name]);
        if (!item) return;
        eating = true; await bot.equip(item, 'hand'); await bot.consume(); eating = false;
      } catch (e) { eating = false; }
    });
    bot.on('death', () => { try { bot.respawn(); } catch (e) {} });
    bot.on('kicked', (r) => log('warn', 'main', 'kicked', { reason: r }));
    bot.on('error', (err) => log('error', 'main', 'error', { msg: err.message }));
    bot.on('end', (r) => finish(r || 'ended'));

    spawnTimer = setTimeout(() => { if (!state.connected) finish('spawn-timeout'); }, cfg.spawnTimeout);
  });
}

const events = new EventEmitter();
const shutdown = new AbortController();
const state = { connected: false, ready: false, sessions: 0, lastReason: null, attempt: 0, flags: {} };

const server = http.createServer((req, res) => {
  const status = state.connected ? (state.ready ? 'online' : 'joining') : 'reconnecting';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status, username: cfg.username, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
});

events.on('ready', () => log('info', 'main', '✅ BOT IS ONLINE AND AFK'));
events.on('offline', (p) => log('warn', 'main', 'offline', { reason: p.reason }));

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', resolve); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function main() {
  validate();
  log('info', 'main', 'boot', { user: cfg.username, autoPass: cfg.autoPassword, mode: cfg.mode, gate: cfg.gateHost });
  await new Promise(r => server.listen(cfg.httpPort, '0.0.0.0', r));
  log('info', 'main', 'http listening', { port: cfg.httpPort });

  while (!shutdown.signal.aborted) {
    state.flags = { originReg: false, originReady: false };
    const result = await runSession(state, shutdown.signal, events);
    if (shutdown.signal.aborted) break;
    state.attempt++;
    const delay = Math.min(cfg.retryMax, cfg.retryMin * Math.pow(2, state.attempt));
    log('warn', 'main', 'session ended', { reason: result.reason, retryInMs: delay });
    await sleep(delay, shutdown.signal);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown.abort());
process.on('SIGINT', () => shutdown.abort());
process.on('uncaughtException', (e) => { log('error', 'main', 'fatal', { msg: e.message }); shutdown.abort(); });
main().catch(err => { log('error', 'main', 'fatal', { msg: err.message }); process.exit(1); });
