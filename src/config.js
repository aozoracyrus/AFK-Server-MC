require('dotenv').config();

module.exports = {
  hub: {
    host: process.env.MC_HOST || 'cracked.minekube.net',
    port: parseInt(process.env.MC_PORT) || 25565,
  },
  endpoint: process.env.MC_ENDPOINT || 'mzero-263',
  username: process.env.MC_USERNAME || 'Auto_RTFEAX_Guar',
  password: process.env.MC_PASSWORD || 'Auto_RTFEAX_Guar',
  version: process.env.MC_VERSION || '1.21.4',
  watchdog: {
    verifyTimeout: parseInt(process.env.WATCHDOG_VERIFY_TIMEOUT) || 20000,
    retryDelay: parseInt(process.env.WATCHDOG_RETRY_DELAY) || 60000,
  },
  discord: {
    webhook: process.env.DISCORD_WEBHOOK || '',
  },
};
