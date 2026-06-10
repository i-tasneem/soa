// ============================================================
// CONFIG v7 — Broker-Agnostic Configuration
// Changes from v6:
// 1. Added broker section (type, credentials per broker)
// 2. Added Redis configuration section
// 3. Added polling configuration section
// 4. Instrument profiles include Dhan security IDs
// ============================================================

require('dotenv').config();

const config = {
  // ── BROKER CONFIGURATION ───────────────────────────────────
  broker: {
    // Supported: 'angel', 'dhan'
    type: process.env.BROKER_TYPE || 'angel',

    // Angel One credentials (used when type = 'angel')
    apiKey: process.env.ANGEL_API_KEY || '',
    clientId: process.env.ANGEL_CLIENT_ID || '',
    password: process.env.ANGEL_PASSWORD || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || '',
    baseUrl: process.env.ANGEL_BASE_URL || 'https://apiconnect.angelone.in',

    // Dhan credentials (used when type = 'dhan')
    accessToken: process.env.DHAN_ACCESS_TOKEN || '',
    clientId: process.env.DHAN_CLIENT_ID || '',
    baseUrl: process.env.DHAN_BASE_URL || 'https://api.dhan.co',
  },

  // ── REDIS CONFIGURATION ────────────────────────────────────
  redis: {
    enabled: process.env.REDIS_ENABLED === 'true',
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD || '',
  },

  // ── POLLING CONFIGURATION ──────────────────────────────────
  polling: {
    ltpInterval: parseInt(process.env.LTP_INTERVAL) || 2000,
    chainInterval: parseInt(process.env.CHAIN_INTERVAL) || 5000,
    wsThrottleMs: parseInt(process.env.WS_THROTTLE_MS) || 5000,
  },

  // ── INSTRUMENT PROFILES ────────────────────────────────────
  instruments: {
    NIFTY: {
      name: 'NIFTY 50',
      exchange: 'NSE',
      token: '26000',
      dhanSecurityId: '13', // NIFTY index on Dhan
      instrumenttype: 'OPTIDX',
      optionExchange: 'NFO',
      strikeStep: 50,
      lots: 15,
      optimalWindows: [
        { start: '09:30', end: '11:30' },
        { start: '13:30', end: '15:00' },
      ],
    },
    BANKNIFTY: {
      name: 'NIFTY BANK',
      exchange: 'NSE',
      token: '26009',
      dhanSecurityId: '25', // BANKNIFTY index on Dhan
      instrumenttype: 'OPTIDX',
      optionExchange: 'NFO',
      strikeStep: 100,
      lots: 15,
      optimalWindows: [
        { start: '09:30', end: '11:30' },
        { start: '13:30', end: '15:00' },
      ],
    },
    SENSEX: {
      name: 'SENSEX',
      exchange: 'BSE',
      token: '1',
      dhanSecurityId: '51', // SENSEX index on Dhan
      instrumenttype: 'OPTIDX',
      optionExchange: 'BFO',
      strikeStep: 100,
      lots: 10,
      optimalWindows: [
        { start: '09:30', end: '11:30' },
        { start: '13:30', end: '15:00' },
      ],
    },
    BANKEX: {
      name: 'BANKEX',
      exchange: 'BSE',
      token: '12',
      dhanSecurityId: '69', // BANKEX index on Dhan
      instrumenttype: 'OPTIDX',
      optionExchange: 'BFO',
      strikeStep: 100,
      lots: 10,
      optimalWindows: [
        { start: '09:30', end: '11:30' },
        { start: '13:30', end: '15:00' },
      ],
    },
  },

  // ── DATABASE ───────────────────────────────────────────────
  database: {
    path: process.env.DB_PATH || './data/trading.db',
  },

  // ── LOGGING ────────────────────────────────────────────────
  logLevel: process.env.LOG_LEVEL || 'info',

  // ── SERVER ─────────────────────────────────────────────────
  port: parseInt(process.env.PORT) || 3000,
};

module.exports = config;
