// ============================================================
// INSTRUMENT DNA PROFILES
// Institutional Grade A — Per-instrument trading parameters
// ============================================================

const SENSEX = {
  name: 'SENSEX',
  lotSize: 20,
  strikeStep: 100,
  tickSize: 0.05,
  atrPeriod: 14,
  atrMultiplier: { target: 0.8, sl: 0.6 },
  minPremium: 15,
  maxPremium: 800,
  optimalWindows: ['09:30-11:30', '13:30-15:00'],
  ivPercentileMax: 70,
  gammaRiskExpiryHours: 3,
  oiWallThreshold: 1.5,
  first15MinBan: true,
  lunchBanStart: '12:00',
  lunchBanEnd: '13:15',
  maxSignalsDay: 5,
  maxTradesDay: 3,
  cooldownMs: 300000,
};

const NIFTY = {
  name: 'NIFTY',
  lotSize: 25,
  strikeStep: 50,
  tickSize: 0.05,
  atrMultiplier: { target: 0.8, sl: 0.6 },
  minPremium: 15,
  maxPremium: 600,
  optimalWindows: ['10:15-11:30', '13:45-14:45'],
  gammaRiskExpiryHours: 3,
  ivPercentileMax: 70,
};

const BANKNIFTY = {
  name: 'BANKNIFTY',
  lotSize: 15,
  strikeStep: 100,
  tickSize: 0.05,
  atrMultiplier: { target: 1.0, sl: 0.75 },
  minPremium: 25,
  maxPremium: 1200,
  optimalWindows: ['10:30-11:15', '14:00-14:30'],
  gammaRiskExpiryHours: 4,
  ivPercentileMax: 65,
};

const FINNIFTY = {
  name: 'FINNIFTY',
  lotSize: 60,
  strikeStep: 50,
  tickSize: 0.05,
  atrPeriod: 14,
  atrMultiplier: { target: 0.8, sl: 0.6 },
  minPremium: 15,
  maxPremium: 600,
  optimalWindows: ['10:15-11:30', '13:45-14:45'],
  ivPercentileMax: 70,
  gammaRiskExpiryHours: 3,
  oiWallThreshold: 1.5,
  first15MinBan: true,
  lunchBanStart: '12:00',
  lunchBanEnd: '13:15',
  maxSignalsDay: 5,
  maxTradesDay: 3,
  cooldownMs: 300000,
};

const BANKEX = {
  name: 'BANKEX',
  lotSize: 30,
  strikeStep: 100,
  tickSize: 0.05,
  atrPeriod: 14,
  atrMultiplier: { target: 0.8, sl: 0.6 },
  minPremium: 20,
  maxPremium: 800,
  optimalWindows: ['09:30-11:30', '13:30-15:00'],
  ivPercentileMax: 70,
  gammaRiskExpiryHours: 3,
  oiWallThreshold: 1.5,
  first15MinBan: true,
  lunchBanStart: '12:00',
  lunchBanEnd: '13:15',
  maxSignalsDay: 5,
  maxTradesDay: 3,
  cooldownMs: 300000,
};

module.exports = {
  SENSEX,
  NIFTY,
  BANKNIFTY,
  FINNIFTY,
  BANKEX,
};
