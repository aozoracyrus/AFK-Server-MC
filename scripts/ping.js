'use strict';

// npm run ping -- <host> [port]
const mc = require('minecraft-protocol');
const host = process.argv[2] || process.env.MC_HOST;
const port = Number(process.argv[3] || process.env.MC_PORT || 25565);

if (!host) { console.error('Usage: npm run ping -- <host> [port]'); process.exit(1); }

mc.ping({ host, port, closeTimeout: 10000 }, (err, res) => {
  if (err) { console.error('PING FAILED:', err.message); process.exit(1); }
  console.log(JSON.stringify({ version: res.version, players: res.players }, null, 2));
});
