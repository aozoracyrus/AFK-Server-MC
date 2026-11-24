'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');
const { config: cfg, validate } = require('./config');
const { createLogger } = require('./logger');
const { createNotifier } = require('./notify');
const { runSession } = require('./bot');

const log = createLogger('main');
const notify = createNotifier(cfg.notify.webhookUrl);
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
};

const snapshot = () => ({
  status: state.connected ? (state.ready ? 'online' : 'joining') : 'reconnecting',
  target: `${cfg.mc.host}:${cfg.mc.port}`,
  username: cfg.mc.username,
  clientVersion: cfg.mc.version,
  serverVersion: cfg.mc.serverVersion,
  mode: cfg.afk.mode,
  sessions: state.sessions,
  attempt: state.attempt,
  lastConnectedAt: state.lastConnectedAt,
  lastReason: state.lastReason,
  processUptimeSec: Math.round((Date.now() - startedAt) / 1000),
  memoryMb: Math.round(process.memoryUsage().rss / 1048576),
});

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

// /health = liveness: luôn 200 khi process sống -> platform KHÔNG restart lúc server MC offline
// /ready  = readiness: 503 khi bot chưa vào xong
const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/ready') return json(res, state.connected && state.ready ? 200 : 503, snapshot());
  if (path === '/health' || path === '/' || path === '/status') return json(res, 200, snapshot());
  return json(res, 404, { error: 'not found' });
});

let downSince = null;
let downTimer = null;

events.on('online', ({ sessions }) => {
  clearTimeout(downTimer);
  if (sessions === 1) {
    notify.send(`🟢 ${cfg.mc.username} connected @ \`${cfg.mc.host}:${cfg.mc.port}\` (mode ${cfg.afk.mode})`);
  } else if (downSince) {
    notify.send(`🟢 ${cfg.mc.username} reconnected after ~${Math.round((Date.now() - downSince) / 60000)} min`);
  }
  downSince = null;
});

events.on('offline', ({ reason }) => {
  state.ready = false;
  downSince = Date.now();
  clearTimeout(downTimer);
  downTimer = setTimeout(() => {
    if (!state.connected && !shutdown.signal.aborted) {
      notify.send(`🔴 ${cfg.mc.username} offline > ${Math.round(cfg.notify.downAfterMs / 60000)} min. Reason: ${reason}`);
    }
  }, cfg.notify.downAfterMs);
  if (downTimer.unref) downTimer.unref();
});

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const fin = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', fin); resolve(); };
    const t = setTimeout(fin, ms);
    if (signal) signal.addEventListener('abort', fin, { once: true });
  });
}

function backoffDelay(attempt) {
  const base = Math.min(cfg.reconnect.maxDelayMs, cfg.reconnect.minDelayMs * Math.pow(2, attempt));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

async function main() {
  validate();
  log.info('boot', {
    target: `${cfg.mc.host}:${cfg.mc.port}`,
    user: cfg.mc.username,
    clientVersion: cfg.mc.version,
    serverVersion: cfg.mc.serverVersion,
    mode: cfg.afk.mode,
    needsGuard: cfg.needsGuard,
    login: Boolean(cfg.mc.password),
  });

  await new Promise((r) => server.listen(cfg.http.port, '0.0.0.0', r));
  log.info('http listening', { port: cfg.http.port, routes: ['/health', '/ready', '/status'] });

  while (!shutdown.signal.aborted) {
    const t0 = Date.now();
    const { reason } = await runSession(cfg, log.child('bot'), state, shutdown.signal, events);
    const uptime = Date.now() - t0;
    if (shutdown.signal.aborted) break;

    state.attempt = uptime > cfg.reconnect.resetAfterMs ? 0 : state.attempt + 1;
    const delay = backoffDelay(state.attempt);
    log.warn('session ended', {
      reason,
      uptimeSec: Math.round(uptime / 1000),
      retryInMs: delay,
      attempt: state.attempt,
    });
    await sleep(delay, shutdown.signal);
  }

  log.info('shutdown complete');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log.info(`received ${sig}`); shutdown.abort(); });
}
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { msg: String((e && e.message) || e) }));
process.on('uncaughtException', (e) => { log.error('uncaughtException', { msg: e.message }); shutdown.abort(); });

main().catch((err) => { log.error('fatal', { msg: err.message }); process.exit(1); });
