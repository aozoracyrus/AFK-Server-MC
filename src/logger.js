'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function safeJson(meta) {
  try { return JSON.stringify(meta); } catch { return '"[unserializable]"'; }
}

function emit(level, scope, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const write = level === 'error' ? console.error : console.log;
  write(meta === undefined ? line : `${line} ${safeJson(meta)}`);
}

function createLogger(scope) {
  return {
    debug: (m, x) => emit('debug', scope, m, x),
    info: (m, x) => emit('info', scope, m, x),
    warn: (m, x) => emit('warn', scope, m, x),
    error: (m, x) => emit('error', scope, m, x),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

module.exports = { createLogger };
