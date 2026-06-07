// ============================================================
// SOA TRADER — CONFIGURATION FILE
// Phase 1: feed freshness SLAs + analysis throttling
// ============================================================
module.exports = {
  angel: {
    apiKey: process.env.ANGEL_API_KEY,
    clientId: process.env.ANGEL_CLIENT_ID,
    password: process.env.ANGEL_PASSWORD,
    totpSecret: process.env.ANGEL_TOTP_SECRET,
  },
  server: { port: process.env.PORT || 3000, host: '0.0.0.0' },
  trading: {
    defaultLots: 15,
    defaultTarget: 25,
    defaultStopLoss: 20,
    defaultMonthlyGoal: 35000,
    optionType: 'ATM',
    tradingDays: 'MON_WED',
    maxTradesPerDay: 2,
  },
  market: {
    exchange: 'BFO',
    index: 'SENSEX',
    indexToken: '999901',
    strikesAbove: 3,
    strikesBelow: 3,
    refreshInterval: 1000,
  },
  oi: {
    wallTopN: Number(process.env.OI_WALL_TOP_N) || 8,
    imbalanceLookback: Number(process.env.OI_IMBALANCE_LOOKBACK) || 5,
    rollingWindow: Number(process.env.OI_ROLLING_WINDOW) || 5,
    minOiPct: Number(process.env.OI_MIN_PCT) || 0.05,

    // Phase 2C — safe imbalance knobs
    imbalanceBullishThreshold: Number(process.env.OI_IMBALANCE_BULLISH_THRESHOLD) || 0.08,
    imbalanceBearishThreshold: Number(process.env.OI_IMBALANCE_BEARISH_THRESHOLD) || -0.08,
    imbalanceWeakBoost: Number(process.env.OI_IMBALANCE_WEAK_BOOST) || 5,
    imbalanceStrongBoost: Number(process.env.OI_IMBALANCE_STRONG_BOOST) || 8,
    imbalanceMaxBoost: Number(process.env.OI_IMBALANCE_MAX_BOOST) || 10,
  },

  strategy: {
    setupThreshold: Number(process.env.SETUP_THRESHOLD) || 55,
    signalThreshold: Number(process.env.SIGNAL_THRESHOLD) || 70,
    oiVelocityThreshold: Number(process.env.OI_VELOCITY_THRESHOLD) || 0,
    maxOiAgeMs: Number(process.env.MAX_OI_AGE_MS) || 15000,
    maxPremiumAgeMs: Number(process.env.MAX_PREMIUM_AGE_MS) || 8000,
  },
    greeks: {
    enabled: process.env.GREEKS_ENABLED !== 'false',
    defaultIv: Number(process.env.DEFAULT_IV) || 0.18,
    riskFreeRate: Number(process.env.RISK_FREE_RATE) || 0.065,
    minTteYears: Number(process.env.MIN_TTE_YEARS) || (1 / (365 * 24)),
  },

   calibration: {
    // IMPORTANT: explicit opt-in; false means disabled exactly as requested
    enabled: process.env.CALIBRATION_ENABLED === 'true',
    minSamples: Number(process.env.CALIBRATION_MIN_SAMPLES) || 20,
    maxBoost: Number(process.env.CALIBRATION_MAX_BOOST) || 8,
    maxPenalty: Number(process.env.CALIBRATION_MAX_PENALTY) || 10,
    refreshMs: Number(process.env.CALIBRATION_REFRESH_MS) || 60000,
    lookbackSignals: Number(process.env.CALIBRATION_LOOKBACK_SIGNALS) || 200,
  },
  feeds: {
    sensex_ltp: {
      minFrequencyMs: Number(process.env.FEED_SENSEX_MIN_MS) || 2000,
      maxStaleMs: Number(process.env.FEED_SENSEX_MAX_STALE_MS) || 4000,
      description: 'Sensex price ticks'
    },
    option_chain: {
      minFrequencyMs: Number(process.env.FEED_CHAIN_MIN_MS) || 5000,
      maxStaleMs: Number(process.env.FEED_CHAIN_MAX_STALE_MS) || 8000,
      description: 'Full option chain / selected strikes'
    },
    option_ltp: {
      minFrequencyMs: Number(process.env.FEED_OPTION_LTP_MIN_MS) || 5000,
      maxStaleMs: Number(process.env.FEED_OPTION_LTP_MAX_STALE_MS) || 6000,
      description: 'Premium for active trade option'
    },
    indicators: {
      minFrequencyMs: Number(process.env.FEED_INDICATORS_MIN_MS) || 200,
      maxStaleMs: Number(process.env.FEED_INDICATORS_MAX_STALE_MS) || 1000,
      description: 'Calculated indicators'
    },
  },

  analysis: {
    throttleMs: Number(process.env.ANALYSIS_THROTTLE_MS) || 200,
    maxAnalysisAgeMs: Number(process.env.MAX_ANALYSIS_AGE_MS) || 10000,
  },
};
