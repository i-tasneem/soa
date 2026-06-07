// ============================================================
// INDICATORS
// EMA, Bollinger Bands, VWAP, Candle Analysis
// Grade A: Added ATR(14) + ATR_MA20 + Volume analysis
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

// ── ATR ──────────────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return parseFloat(atr.toFixed(2));
}

// ── BOLLINGER BANDS ──────────────────────────────────────────
function calcBollingerBands(candles, period = 15, stdDev = 2) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);
  const upper = parseFloat((mean + stdDev * sd).toFixed(2));
  const lower = parseFloat((mean - stdDev * sd).toFixed(2));
  const middle = parseFloat(mean.toFixed(2));
  const bw = parseFloat(((upper - lower) / middle * 100).toFixed(4));
  const squeeze = bw < 1.5;
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
    this.cumTPV = 0;
    this.cumVol = 0;
    this.vwap = null;
    this.bands = { upper1: null, lower1: null, upper2: null, lower2: null };
    this.tpSq = 0;
    this.count = 0;
  }

  update(candle) {
    const tp = (candle.high + candle.low + candle.close) / 3;
    const vol = candle.ticks || 1;
    this.cumTPV += tp * vol;
    this.cumVol += vol;
    this.tpSq += tp * tp * vol;
    this.count++;
    if (this.cumVol === 0) return;
    this.vwap = parseFloat((this.cumTPV / this.cumVol).toFixed(2));
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
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const bodyPct = range > 0 ? (body / range) * 100 : 0;
  const bullish = candle.close > candle.open;
  const bearish = candle.close < candle.open;
  const upperWick = bullish ? candle.high - candle.close : candle.high - candle.open;
  const lowerWick = bullish ? candle.open - candle.low : candle.close - candle.low;
  const isStrong = bodyPct > 60;
  const isDoji = bodyPct < 10;
  const isHammer = lowerWick > body * 2 && upperWick < body * 0.5;
  const isShootingStar = upperWick > body * 2 && lowerWick < body * 0.5;
  const isEngulfing = body > 15;
  return {
    body, range, bodyPct, bullish, bearish,
    upperWick, lowerWick,
    isStrong, isDoji, isHammer, isShootingStar, isEngulfing,
  };
}

// ── FULL INDICATOR SNAPSHOT ───────────────────────────────────
function getIndicators(candles5m, candles15m, candles30m, vwap) {
  if (!candles5m || candles5m.length < 5) return null;

  const c5 = candles5m;
  const c15 = candles15m || [];
  const c30 = candles30m || [];

  // EMAs on 5m
  const ema5 = calcEMA(c5, 5);
  const ema9 = calcEMA(c5, 9);
  const ema15 = calcEMA(c5, 15);
  const ema50 = calcEMA(c5, 50);
  const ema200 = calcEMA(c5, 200);

  // EMAs on 15m for HTF bias
  const ema9_15m = calcEMA(c15, 9);
  const ema15_15m = calcEMA(c15, 15);
  const ema9_30m = calcEMA(c30, 9);

  // Bollinger on 5m
  const bb5 = calcBollingerBands(c5, 9, 2);
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
  const lastCandle = analyzeCandle(c5[c5.length - 1]);
  const prev1Candle = analyzeCandle(c5[c5.length - 2]);
  const prev2Candle = analyzeCandle(c5[c5.length - 3]);

  // Momentum
  const bullMomentum = lastCandle?.bullish && prev1Candle?.bullish;
  const bearMomentum = lastCandle?.bearish && prev1Candle?.bearish;

  // Price vs BB
  const priceAboveBB = bb5 && price > bb5.upper;
  const priceBelowBB = bb5 && price < bb5.lower;

  // ---- Grade A: ATR calculation ----
  const atr14 = calcATR(c5, 14);
  const atr14_MA20 = (() => {
    if (c5.length < 20) return null;
    const atrs = [];
    for (let i = 14; i < c5.length; i++) {
      const slice = c5.slice(Math.max(0, i - 14), i + 1);
      const a = calcATR(slice, 14);
      if (a !== null) atrs.push(a);
    }
    if (atrs.length < 20) return null;
    return parseFloat((atrs.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2));
  })();

  // ---- Grade A: Volume analysis ----
  const volumes = c5.slice(-20).map(c => c.volume || c.ticks || 0);
  const avgVolume = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const currentVolume = c5[c5.length - 1]?.volume || c5[c5.length - 1]?.ticks || 0;

  return {
    price,
    ema: { ema5, ema9, ema15, ema50, ema200, ema9_15m, ema15_15m, ema9_30m },
    bb: { '5m': bb5, '15m': bb15 },
    vwap: vwapData,
    bias: { bullishEMA, bearishEMA, aboveVWAP, belowVWAP, htfBullish, htfBearish },
    momentum: { bullMomentum, bearMomentum },
    candle: { last: lastCandle, prev1: prev1Candle, prev2: prev2Candle },
    breakout: { priceAboveBB, priceBelowBB },
    atr14,
    atr14_MA20,
    volume: { current: currentVolume, avg20: avgVolume },
  };
}

module.exports = { calcEMA, calcEMAArray, calcBollingerBands, calcATR, VWAPCalculator, analyzeCandle, getIndicators };
