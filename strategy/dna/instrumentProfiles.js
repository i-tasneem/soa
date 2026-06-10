// ============================================================
// INSTRUMENT PROFILES v7 — Added Dhan Security IDs
// Changes from v6:
// 1. Added dhanSecurityId field for each instrument
// 2. Added dhanExchange field for option exchange mapping
// 3. Preserved all existing fields for backward compatibility
// ============================================================

const instrumentProfiles = {
  NIFTY: {
    name: 'NIFTY 50',
    exchange: 'NSE',
    token: '26000',
    dhanSecurityId: '13',        // NIFTY index on Dhan
    dhanExchange: 'NSE',        // Dhan exchange code
    dhanOptionExchange: 'NFO',  // Dhan options exchange
    instrumenttype: 'OPTIDX',
    optionExchange: 'NFO',
    strikeStep: 50,
    lots: 15,
    optimalWindows: [
      { start: '09:30', end: '11:30' },
      { start: '13:30', end: '15:00' },
    ],
    description: 'NIFTY 50 Index Options',
  },
  BANKNIFTY: {
    name: 'NIFTY BANK',
    exchange: 'NSE',
    token: '26009',
    dhanSecurityId: '25',        // BANKNIFTY index on Dhan
    dhanExchange: 'NSE',
    dhanOptionExchange: 'NFO',
    instrumenttype: 'OPTIDX',
    optionExchange: 'NFO',
    strikeStep: 100,
    lots: 15,
    optimalWindows: [
      { start: '09:30', end: '11:30' },
      { start: '13:30', end: '15:00' },
    ],
    description: 'NIFTY Bank Index Options',
  },
  SENSEX: {
    name: 'SENSEX',
    exchange: 'BSE',
    token: '1',
    dhanSecurityId: '51',        // SENSEX index on Dhan
    dhanExchange: 'BSE',
    dhanOptionExchange: 'BFO',
    instrumenttype: 'OPTIDX',
    optionExchange: 'BFO',
    strikeStep: 100,
    lots: 10,
    optimalWindows: [
      { start: '09:30', end: '11:30' },
      { start: '13:30', end: '15:00' },
    ],
    description: 'BSE SENSEX Index Options',
  },
  BANKEX: {
    name: 'BANKEX',
    exchange: 'BSE',
    token: '12',
    dhanSecurityId: '69',        // BANKEX index on Dhan
    dhanExchange: 'BSE',
    dhanOptionExchange: 'BFO',
    instrumenttype: 'OPTIDX',
    optionExchange: 'BFO',
    strikeStep: 100,
    lots: 10,
    optimalWindows: [
      { start: '09:30', end: '11:30' },
      { start: '13:30', end: '15:00' },
    ],
    description: 'BSE BANKEX Index Options',
  },
};

module.exports = { instrumentProfiles };
