// ============================================================
// CONFIGURATION
// Environment-driven configuration for SOA Trader
// FIX: Added maxDailyLoss, CORS whitelist
// ============================================================

require('dotenv').config();

const config = {
  angel: {
    apiKey: process.env.ANGEL_API_KEY || '',
    clientId: process.env.ANGEL_CLIENT_ID || '',
    password: process.env.ANGEL_PASSWORD || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || '',
    baseUrl: 'https://apiconnect.angelone.in',
  },
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '0.0.0.0',
  },
  trading: {
    defaultLots: parseInt(process.env.DEFAULT_LOTS) || 15,
    defaultTarget: parseInt(process.env.DEFAULT_TARGET) || 25,
    defaultStopLoss: parseInt(process.env.DEFAULT_SL) || 20,
    defaultMonthlyGoal: parseInt(process.env.MONTHLY_GOAL) || 35000,
    maxSignalsDay: parseInt(process.env.MAX_SIGNALS_DAY) || 5,
    maxTradesDay: parseInt(process.env.MAX_TRADES_DAY) || 3,
    cooldownMs: parseInt(process.env.COOLDOWN_MS) || 300000,
    maxDailyLoss: parseInt(process.env.MAX_DAILY_LOSS) || 10000,
  },
  market: {
    openTime: '09:15',
    closeTime: '15:30',
    timezone: 'Asia/Kolkata',
  },
  oi: {
    rollingWindow: parseInt(process.env.OI_ROLLING_WINDOW) || 5,
    minOiPct: parseFloat(process.env.OI_MIN_PCT) || 0.05,
    imbalanceBullishThreshold: parseFloat(process.env.OI_BULLISH_THRESHOLD) || 0.08,
    imbalanceBearishThreshold: parseFloat(process.env.OI_BEARISH_THRESHOLD) || -0.08,
  },
  calibration: {
    enabled: process.env.CALIBRATION_ENABLED === 'true',
    minSamples: parseInt(process.env.CALIBRATION_MIN_SAMPLES) || 50,
  },
  // FIX: CORS whitelist
  corsWhitelist: (process.env.CORS_WHITELIST || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean),
  // NEW: Multi-instrument configuration
  activeInstruments: (process.env.INSTRUMENTS || 'SENSEX,NIFTY,BANKNIFTY,FINNIFTY,BANKEX').split(',').map(s => s.trim().toUpperCase()),
  stockWatchlist: (process.env.STOCK_WATCHLIST || 'RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK').split(',').map(s => s.trim().toUpperCase()),
  enableStockOptions: process.env.ENABLE_STOCKS === 'true',
};

module.exports = config;
