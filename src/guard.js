'use strict';

/**
 * Server 26.3 chỉ cho 1 packet position mỗi client tick, và chỉ reset cờ khi nhận
 * client_tick_end. mineflayer 4.39.0 không gửi packet đó -> bị kick ~1.5s sau khi join.
 *
 *  freeze : chặn mọi packet movement -> không bao giờ chạm luật trên.
 *  tick   : gửi movement + ghép tick_end NGAY tại thời điểm ghi ra wire.
 *  native : server < 26.3 -> không gọi hàm này.
 *
 * KHÔNG buffer/throttle movement ở nơi khác: lệch cặp là kick lại.
 */
const MOVE = new Set(['position', 'position_look', 'look', 'flying']);

function installGuard(bot, log, { mode = 'freeze', tickEnd = true } = {}) {
  const client = bot._client;
  if (!client || typeof client.write !== 'function') {
    log.warn('guard skipped: client not ready');
    return null;
  }
  const origWrite = client.write.bind(client);

  let canTickEnd = false;
  if (tickEnd) {
    try { origWrite('tick_end', {}); canTickEnd = true; } catch { /* protocol < 1.21.2 */ }
  }

  const stats = { moveSent: 0, moveDropped: 0, tickEndSent: canTickEnd ? 1 : 0 };

  client.write = (name, packet) => {
    if (mode === 'freeze' && MOVE.has(name)) { stats.moveDropped++; return undefined; }
    const result = origWrite(name, packet);
    if (MOVE.has(name)) {
      stats.moveSent++;
      if (canTickEnd) {
        try { origWrite('tick_end', {}); stats.tickEndSent++; } catch { /* ignore */ }
      }
    }
    return result;
  };

  log.info('guard installed', { mode, canTickEnd, version: bot.version });
  return { stats: () => ({ ...stats }) };
}

module.exports = { installGuard };
