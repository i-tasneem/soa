// ============================================================
//  INDICATORS
//  EMA, Bollinger Bands, VWAP, Candle Analysis
// ============================================================

// ── EMA ──────────────────────────────────────────────────────
function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

// Returns array of EMA values (one per candle)
function calcEMAArray(candles, period) {
  if (candles.length < period) return [];
  const closes = candles.map(c => c.close);
  const k = 2 / (period + 1);
  const result = new Array(period - 1).fill(null);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(parseFloat(ema.toFixed(2)));
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(parseFloat(ema.toFixed(2)));
  }
  return result;
}

// ── BOLLINGER BANDS ──────────────────────────────────────────
function calcBollingerBands(candles, period = 15, stdDev = 2) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean   = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
  const sd     = Math.sqrt(variance);
  const upper  = parseFloat((mean + stdDev * sd).toFixed(2));
  const lower  = parseFloat((mean - stdDev * sd).toFixed(2));
  const middle = parseFloat(mean.toFixed(2));
  const bw     = parseFloat(((upper - lower) / middle * 100).toFixed(4)); // bandwidth %

  // Squeeze: bandwidth below 1.5% = compressed
  const squeeze = bw < 1.5;
  // Expansion: bandwidth > previous avg
  const lastClose = candles[candles.length - 1].close;
  const expanding = lastClose > upper || lastClose < lower;

  return { upper, middle, lower, bandwidth: bw, squeeze, expanding };
}

// ── VWAP ─────────────────────────────────────────────────────
class VWAPCalculator {
  constructor() {
    this.reset();
  }

  reset() {
    this.cumTPV  = 0; // cumulative typical price × volume
    this.cumVol  = 0; // cumulative volume
    this.vwap    = null;
    this.bands   = { upper1: null, lower1: null, upper2: null, lower2: null };
    this.tpSq    = 0; // for std dev bands
    this.count   = 0;
  }

  // Update with candle — call on each new/updated candle
  update(candle) {
    const tp = (candle.high + candle.low + candle.close) / 3;
    const vol = candle.ticks || 1; // use tick count as volume proxy
    this.cumTPV += tp * vol;
    this.cumVol += vol;
    this.tpSq   += tp * tp * vol;
    this.count++;
    if (this.cumVol === 0) return;
    this.vwap = parseFloat((this.cumTPV / this.cumVol).toFixed(2));
    // Standard deviation bands
    const variance = (this.tpSq / this.cumVol) - Math.pow(this.vwap, 2);
    const sd = Math.sqrt(Math.max(0, variance));
    this.bands = {
      upper1: parseFloat((this.vwap + sd).toFixed(2)),
      lower1: parseFloat((this.vwap - sd).toFixed(2)),
      upper2: parseFloat((this.vwap + 2 * sd).toFixed(2)),
      lower2: parseFloat((this.vwap - 2 * sd).toFixed(2)),
    };
  }

  get() {
    return { vwap: this.vwap, ...this.bands };
  }
}

// ── CANDLE ANALYSIS ──────────────────────────────────────────
function analyzeCandle(candle) {
  if (!candle) return null;
  const body    = Math.abs(candle.close - candle.open);
  const range   = candle.high - candle.low;
  const bodyPct = range > 0 ? (body / range) * 100 : 0;
  const bullish = candle.close > candle.open;
  const bearish = candle.close < candle.open;
  const upperWick = bullish
    ? candle.high - candle.close
    : candle.high - candle.open;
  const lowerWick = bullish
    ? candle.open - candle.low
    : candle.close - candle.low;

  // Candle types
  const isStrong    = bodyPct > 60;   // strong body
  const isDoji      = bodyPct < 10;   // indecision
  const isHammer    = lowerWick > body * 2 && upperWick < body * 0.5;
  const isShootingStar = upperWick > body * 2 && lowerWick < body * 0.5;
  const isEngulfing = body > 15;      // large candle

  return {
    body, range, bodyPct, bullish, bearish,
    upperWick, lowerWick,
    isStrong, isDoji, isHammer, isShootingStar, isEngulfing,
  };
}

// ── FULL INDICATOR SNAPSHOT ───────────────────────────────────
// Call this after each new candle to get full indicator state
function getIndicators(candles5m, candles15m, candles30m, vwap) {
  if (!candles5m || candles5m.length < 5) return null;

  const c5  = candles5m;
  const c15 = candles15m || [];
  const c30 = candles30m || [];

  // EMAs on 5m
  const ema5   = calcEMA(c5, 5);
  const ema9   = calcEMA(c5, 9);
  const ema15  = calcEMA(c5, 15);
  const ema50  = calcEMA(c5, 50);
  const ema200 = calcEMA(c5, 200);

  // EMAs on 15m for HTF bias
  const ema9_15m  = calcEMA(c15, 9);
  const ema15_15m = calcEMA(c15, 15);

  // EMAs on 30m for bias
  const ema9_30m  = calcEMA(c30, 9);

  // Bollinger on 5m
  const bb5  = calcBollingerBands(c5, 9, 2);;
  const bb15 = calcBollingerBands(c15, 15, 2);

  // VWAP
  const vwapData = vwap?.get() || null;

  // Current price
  const price = c5[c5.length - 1]?.close;

  // EMA alignment
  const bullishEMA = ema5 && ema9 && ema15 && ema5 > ema9 && ema9 > ema15;
  const bearishEMA = ema5 && ema9 && ema15 && ema5 < ema9 && ema9 < ema15;

  // VWAP bias
  const aboveVWAP = vwapData?.vwap && price > vwapData.vwap;
  const belowVWAP = vwapData?.vwap && price < vwapData.vwap;

  // HTF bias (15m)
  const htfBullish = ema9_15m && ema15_15m && ema9_15m > ema15_15m;
  const htfBearish = ema9_15m && ema15_15m && ema9_15m < ema15_15m;

  // Last 3 candles analysis
  const lastCandle  = analyzeCandle(c5[c5.length - 1]);
  const prev1Candle = analyzeCandle(c5[c5.length - 2]);
  const prev2Candle = analyzeCandle(c5[c5.length - 3]);

  // Momentum — last 3 candles same direction
  const bullMomentum = lastCandle?.bullish && prev1Candle?.bullish;
  const bearMomentum = lastCandle?.bearish && prev1Candle?.bearish;

  // Price vs BB
  const priceAboveBB = bb5 && price > bb5.upper;
  const priceBelowBB = bb5 && price < bb5.lower;

  return {
    price,
    ema: { ema5, ema9, ema15, ema50, ema200, ema9_15m, ema15_15m, ema9_30m },
    bb: { '5m': bb5, '15m': bb15 },
    vwap: vwapData,
    bias: { bullishEMA, bearishEMA, aboveVWAP, belowVWAP, htfBullish, htfBearish },
    momentum: { bullMomentum, bearMomentum },
    candle: { last: lastCandle, prev1: prev1Candle, prev2: prev2Candle },
    breakout: { priceAboveBB, priceBelowBB },
  };
}

module.exports = { calcEMA, calcEMAArray, calcBollingerBands, VWAPCalculator, analyzeCandle, getIndicators };
