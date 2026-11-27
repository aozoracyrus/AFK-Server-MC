'use strict';

/* ============================================================================
   mc-afk-bot v10 — Hoàn toàn tự động (Zero Config Password)
   Tối ưu cho FadeHost 256MB RAM. Không lưu file, không cần ENV password.
   Quy trình: Gate -> /browser join -> Transfer -> Auto Register/Login -> AFK
   ========================================================================== */

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

// --- TỰ ĐỘNG SINH MẬT KHẨU ---
// Tạo mật khẩu cố định, phức tạp dựa trên tên bot. Không cần lưu file, không cần ENV.
function getAutoPassword(username) {
  const salt = "FadeHost_MC_Bot_Secure_Salt_2024";
  let hash = 0;
  const text = username + salt;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; 
  }
  const absHash = Math.abs(hash).toString(36).toUpperCase().padEnd(6, 'X');
  return `Auto_${absHash}_${username.substring(0, 4)}`;
}

const SERVER_VERSION = str(process.env.MC_SERVER_VERSION, '26.3');
const NEEDS_GUARD = cmpVersion(SERVER_VERSION, '26.3') >= 0;
const MODE_ENV = str(process.env.AFK_MODE, 'auto').toLowerCase();

const cfg = {
  username: str(process.env.MC_USERNAME, 'Guardians'),
  autoPassword: getAutoPassword(process.env.MC_USERNAME || 'Guardians'), // Mật khẩu tự sinh
  clientVersion: str(process.env.MC_VERSION, '26.1'),
  auth: str(process.env.MC_AUTH, 'offline').toLowerCase(),

  gateHost: str(process.env.GATE_HOST, 'cracked.minekube.net'),
  gatePort: num(process.env.GATE_PORT, 25565),
  gateEndpoint: str(process.env.GATE_ENDPOINT, 'mzero-263'),
  gateJoinCmd: str(process.env.GATE_JOIN_CMD, '/browser join {endpoint}'),
  gateDelayMs: num(process.env.GATE_DELAY_MS, 3000),
  gateTimeoutMs: num(process.env.GATE_TIMEOUT_MS, 30000),

  originRegCmd: '/register {password} {password}',
  originLoginCmd: '/login {password}',
  originFirstDelay: num(process.env.ORIGIN_FIRST_DELAY || 5000, 5000),
  originStepGap: num(process.env.ORIGIN_STEP_GAP || 5000, 5000),
  originSettle: num(process.env.ORIGIN_SETTLE || 4000, 4000),
  originTimeout: num(process.env.ORIGIN_TIMEOUT || 45000, 45000),

  minGap: num(process.env.MC_MIN_GAP, 12000),
  transferGrace: num(process.env.MC_TRANSFER_GRACE, 2500),
  tickEnd: bool(process.env.MC_TICK_END, true),
  viewDist: str(process.env.MC_VIEW_DIST, 'tiny'),
  spawnTimeout: num(process.env.MC_SPAWN_TIMEOUT, 90000),

  mode: MODE_ENV === 'auto' ? (NEEDS_GUARD ? 'freeze' : 'native') : MODE_ENV,
  afkMin: num(process.env.AFK_MIN, 25000),
  afkMax: num(process.env.AFK_MAX, 60000),
  autoEat: bool(process.env.AFK_AUTO_EAT, true),

  httpPort: num(process.env.PORT, 8080),
  retryMin: num(process.env.RETRY_MIN, 15000),
  retryMax: num(process.env.RETRY_MAX, 300000),
  resetAfter: num(process.env.RESET_AFTER, 60000),
  needsGuard: NEEDS_GUARD,
};

function validate() {
  const e = [];
  if (!cfg.username || cfg.username.length > 16 || !/^[A-Za-z0-9_]+$/.test(cfg.username)) e.push('MC_USERNAME invalid (A-Z, 0-9, _, max 16 chars)');
  if (!['offline', 'microsoft'].includes(cfg.auth)) e.push('MC_AUTH invalid');
  if (!cfg.gateHost || !cfg.gateEndpoint) e.push('GATE config missing');
  if (cfg.gateJoinCmd.indexOf('{endpoint}') === -1) e.push('GATE_JOIN_CMD missing {endpoint}');
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

// Guard cho 26.3 (Chặn packet di chuyển để không bị kick)
const MOVE_PKTS = new Set(['position', 'position_look', 'look', 'flying']);
function installGuard(bot, mode, tickEnd) {
  const client = bot._client;
  if (!client || typeof client.write !== 'function') return null;
  const orig = client.write.bind(client);
  let canTick = false;
  if (tickEnd) { try { orig('tick_end', {}); canTick = true; } catch(e) {} }
  const stats = { sent: 0, dropped: 0, tick: canTick ? 1 : 0 };
  client.write = (name, pkt) => {
    if (mode === 'freeze' && MOVE_PKTS.has(name)) { stats.dropped++; return; }
    const res = orig(name, pkt);
    if (MOVE_PKTS.has(name)) {
      stats.sent++;
      if (canTick) { try { orig('tick_end', {}); stats.tick++; } catch(e) {} }
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

// Flow xử lý đăng ký/đăng nhập tự động ở Server Gốc
function createOriginFlow(send, infoObj, onReady, onFatal) {
  let registered = infoObj.originReg || false;
  let ready = false, stopped = false;
  let lastSent = 0;
  let attempt = 0;
  const timers = new Set();
  const pass = cfg.autoPassword; // Dùng mật khẩu tự sinh

  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t); return t;
  };
  const clear = () => { for (const t of timers) clearTimeout(t); timers.clear(); };

  const sendCmd = (kind, tpl) => {
    if (stopped) return false;
    const now = Date.now();
    if (now - lastSent < cfg.minGap) return false;
    lastSent = now;
    const payload = tpl.replace('{password}', pass);
    log('info', 'origin', 'send', { cmd: payload.split(' ')[0], attempt: ++attempt });
    send(payload);
    return true;
  };

  const markReady = (why) => {
    if (ready || stopped) return;
    ready = true; infoObj.originReady = true;
    clear(); log('info', 'origin', 'ready & AFK started', { why, registered, passUsed: pass });
    onReady();
  };

  const doLogin = () => {
    if (stopped || ready) return;
    sendCmd('login', cfg.originLoginCmd);
    later(() => markReady('settle_after_login'), cfg.originSettle);
  };

  const doRegister = () => {
    if (stopped || ready) return;
    const ok = sendCmd('reg', cfg.originRegCmd);
    infoObj.originReg = true;
    // Sau khi register, server thường tự đăng nhập. Ta chờ một chút để xác nhận.
    later(() => {
        if (!ready) markReady('settle_after_register');
    }, cfg.originSettle);
  };

  const handleMessage = (raw) => {
    if (stopped) return;
    const m = String(raw || '');
    
    if (RX.wrong.test(m)) { 
        stopped = true; clear(); onFatal('wrong-password (Server đã có acc này nhưng mk khác)'); return; 
    }
    if (RX.regOk.test(m)) { 
        infoObj.originReg = true; 
        markReady('registered_successfully'); 
        return; 
    }
    if (RX.regDup.test(m)) { 
        infoObj.originReg = true; 
        doLogin(); // Đã có acc, chuyển sang login
        return; 
    }
    if (RX.loginOk.test(m)) { 
        infoObj.originReg = true; 
        markReady('login_success'); 
        return; 
    }
    if (RX.needReg.test(m)) { 
        infoObj.originReg = false; 
        doRegister(); 
    }
  };

  const start = () => {
    log('info', 'origin', 'start auth flow', { registered, autoPass: pass });
    later(() => { 
        if (registered) doLogin(); 
        else doRegister(); 
    }, cfg.originFirstDelay);
    later(() => markReady('fallback_timeout'), cfg.originTimeout);
  };

  return { start, stop: () => { stopped = true; clear(); }, handleMessage };
}

function runSession(stage, target, state, signal, events) {
  return new Promise((resolve) => {
    let done = false, guard = null, flow = null, transferTo = null;
    let afkTimer = null, spawnTimer = null, statsTimer = null, transferTimer = null;
    let spawnCount = 0, activityStarted = false, eating = false;
    const pending = new Set();

    const later = (fn, ms) => {
      const t = setTimeout(() => { pending.delete(t); fn(); }, ms);
      pending.add(t); return t;
    };

    log('info', 'main', 'connecting', { target: target.host + ':' + target.port, user: cfg.username });

    let bot;
    try {
      bot = mineflayer.createBot({
        host: target.host, port: target.port, username: cfg.username, auth: cfg.auth,
        version: cfg.clientVersion || undefined, checkTimeoutInterval: 60000,
        hideErrors: true, logErrors: false,
      });
    } catch (err) {
      log('error', 'main', 'createBot failed', { msg: err.message });
      resolve({ reason: 'createBot: ' + err.message, transfer: null });
      return;
    }

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(afkTimer); clearTimeout(spawnTimer); clearTimeout(transferTimer);
      clearInterval(statsTimer);
      for (const t of pending) clearTimeout(t);
      pending.clear();
      if (flow) flow.stop();
      if (signal) signal.removeEventListener('abort', onAbort);
      state.connected = false; state.ready = false; state.lastReason = reason;
      try { bot.quit('bye'); } catch(e) {}
      try { bot.end(); } catch(e) {}
      if (!transferTo) events.emit('offline', { reason });
      resolve({ reason, transfer: transferTo });
    };

    const onAbort = () => finish('shutdown');
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { finish('shutdown'); return; }
    }

    const safeChat = (cmd) => { if (!done) try { bot.chat(cmd); } catch(e) {} };

    try {
      bot._client.on('transfer', (pkt) => {
        if (pkt && pkt.host) {
          log('info', 'main', 'transfer received', { host: pkt.host, port: pkt.port || 25565 });
          transferTo = { host: pkt.host, port: pkt.port || 25565 };
          finish('transfer');
        }
      });
    } catch(e) {}

    const startActivity = () => {
      if (activityStarted || done) return;
      activityStarted = true; state.ready = true;
      log('info', 'main', 'ACTIVITY STARTED (AFK MODE)', { mode: cfg.mode });
      afkTimer = setTimeout(afkTick, rand(3000, 8000));
      events.emit('ready', {});
    };

    const afkTick = () => {
      if (done || !state.connected) return;
      try {
        if (cfg.mode === 'tick') {
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 1.2, false);
          if (Math.random() < 0.5) {
            bot.setControlState('jump', true);
            later(() => { try { bot.setControlState('jump', false); } catch(e) {} }, 320);
          }
        } else {
          const pick = rand(0, 3);
          if (pick === 0) { try { bot.swingArm('right'); } catch(e) { try { bot.swingArm(); } catch(e2) {} } }
          else if (pick === 1) {
            bot.setControlState('sneak', true);
            later(() => { try { bot.setControlState('sneak', false); } catch(e) {} }, 400);
          } else {
            bot.setQuickBarSlot(rand(0, 8));
          }
        }
      } catch(e) {}
      afkTimer = setTimeout(afkTick, rand(cfg.afkMin, cfg.afkMax));
    };

    bot.once('login', () => log('info', 'main', 'login ok'));

    bot.on('spawn', () => {
      spawnCount++;
      clearTimeout(spawnTimer);
      
      if (!guard && cfg.needsGuard && cfg.mode !== 'native') {
        guard = installGuard(bot, cfg.mode, cfg.tickEnd);
      }
      if (cfg.mode === 'freeze') { try { bot.physicsEnabled = false; } catch(e) {} }
      try { if (typeof bot.setSettings === 'function') bot.setSettings({ viewDistance: cfg.viewDist }); } catch(e) {}

      state.connected = true; state.stage = stage;
      state.lastConnectedAt = new Date().toISOString();
      if (spawnCount === 1) state.sessions++;

      log('info', 'main', 'spawned', { n: spawnCount, ping: bot.player?.ping });

      if (spawnCount === 1) {
        events.emit('online', { stage, sessions: state.sessions });
        
        if (stage === 'gate') {
          log('info', 'gate', 'waiting to send join command');
          later(() => {
            const cmd = cfg.gateJoinCmd.replace('{endpoint}', cfg.gateEndpoint);
            log('info', 'gate', 'send', { cmd: cmd.split(' ')[0] });
            safeChat(cmd);
            state.flags.gateJoinSent = true;
            transferTimer = setTimeout(() => { 
              if (!transferTo && !done) {
                log('warn', 'gate', 'no transfer packet received, retrying');
                finish('gate-no-transfer'); 
              }
            }, cfg.gateTimeoutMs);
          }, cfg.gateDelayMs);
        } else {
          flow = createOriginFlow(safeChat, state.flags, startActivity, finish);
          flow.start();
        }
      } else if (stage === 'gate' && state.flags.gateJoinSent && !transferTo) {
        log('info', 'main', 'in-place switch detected, treating as origin');
        stage = 'origin'; state.stage = 'origin';
        flow = createOriginFlow(safeChat, state.flags, startActivity, finish);
        flow.start();
      }

      if (!statsTimer) {
        statsTimer = setInterval(() => {
          if (done || !state.connected) return;
          log('info', 'main', 'stats', {
            stage, mode: cfg.mode, ready: state.ready,
            guard: guard ? `sent:${guard.sent}/dropped:${guard.dropped}` : 'none',
            rssMb: Math.round(process.memoryUsage().rss / 1048576)
          });
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
        eating = true;
        await bot.equip(item, 'hand');
        await bot.consume();
        eating = false;
      } catch(e) { eating = false; }
    });
    
    bot.on('death', () => { try { bot.respawn(); } catch(e) {} });
    bot.on('kicked', (r) => log('warn', 'main', 'kicked', { reason: r }));
    bot.on('error', (err) => log('error', 'main', 'error', { msg: err.message }));
    bot.on('end', (r) => finish(r || 'ended'));

    spawnTimer = setTimeout(() => { if (!state.connected) finish('spawn-timeout'); }, cfg.spawnTimeout);
  });
}

// Supervisor
const events = new EventEmitter();
const shutdown = new AbortController();
const startedAt = Date.now();
const state = { connected: false, ready: false, stage: 'init', sessions: 0, lastReason: null, attempt: 0, flags: {} };

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  const status = state.connected ? (state.ready ? 'online' : 'joining') : 'reconnecting';
  const body = { status, stage: state.stage, username: cfg.username, rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  res.writeHead(p === '/ready' && state.connected && state.ready ? 200 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
    let stage = 'gate';
    let target = { host: cfg.gateHost, port: cfg.gatePort };
    
    state.flags = { gateJoinSent: false, originReg: false, originReady: false };
    const t0 = Date.now();
    const result = await runSession(stage, target, state, shutdown.signal, events);
    const uptime = Date.now() - t0;
    if (shutdown.signal.aborted) break;

    if (result.transfer && !shutdown.signal.aborted) {
      log('info', 'main', 'hop to origin', { target: result.transfer.host + ':' + result.transfer.port });
      await sleep(cfg.transferGrace, shutdown.signal);
      if (shutdown.signal.aborted) break;
      
      const r2 = await runSession('origin', result.transfer, state, shutdown.signal, events);
      if (shutdown.signal.aborted) break;
      
      state.attempt = uptime > cfg.resetAfter ? 0 : state.attempt + 1;
      await sleep(Math.min(cfg.retryMax, cfg.retryMin * Math.pow(2, state.attempt)), shutdown.signal);
      continue;
    }

    state.attempt = uptime > cfg.resetAfter ? 0 : state.attempt + 1;
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
