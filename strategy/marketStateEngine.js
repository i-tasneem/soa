// ============================================================
// MARKET STATE ENGINE
// Detects market regime: TRENDING, SIDEWAYS, VOLATILE, REVERSAL, BREAKOUT
// FIX: Updated indicator property access for nested vwap/volume objects,
//      IST day reset
// ============================================================

const STATES = {
  TRENDING_BULLISH: 'TRENDING_BULLISH',
  TRENDING_BEARISH: 'TRENDING_BEARISH',
  SIDEWAYS: 'SIDEWAYS',
  VOLATILE: 'VOLATILE',
  BREAKOUT: 'BREAKOUT',
  REVERSAL: 'REVERSAL',
  UNKNOWN: 'UNKNOWN',
};

class MarketStateEngine {
  constructor() {
    this.state = STATES.UNKNOWN;
    this.confidence = 0;
    this.history = [];
    this.maxHistory = 50;
    this._lastPrice = null;
    this._lastPriceTs = 0;
  }

  update(indicators, candles) {
    if (!indicators || !candles || candles.length < 3) {
      return { state: this.state, confidence: this.confidence };
    }

    // FIX: Destructure from nested indicator structure
    const ema5 = indicators.ema5;
    const ema9 = indicators.ema9;
    const ema21 = indicators.ema21;
    const vwapObj = indicators.vwap;
    const vwap = vwapObj?.vwap || null;
    const bb = indicators.bb;  // 5m object
    const rsi = indicators.rsi;
    const atr = indicators.atr || indicators.atr14;
    const volume = indicators.volume;  // {current, avg20}

    const last3 = candles.slice(-3);
    const lastCandle = last3[last3.length - 1];
    const prevCandle = last3[last3.length - 2];
    const price = lastCandle?.close || indicators.price;

    let state = STATES.UNKNOWN;
    let confidence = 0;
    let reasons = [];

    // Trend detection via EMA alignment
    const bullishEMA = ema5 > ema9 && ema9 > ema21;
    const bearishEMA = ema5 < ema9 && ema9 < ema21;
    const emaSpread = Math.abs(ema5 - ema21) / (ema21 || 1);

    // VWAP position
    const aboveVWAP = price > vwap;
    const belowVWAP = price < vwap;

    // Bollinger Band squeeze
    const bbSqueeze = bb?.squeeze || false;
    const bbWidth = bb?.bandwidth || 0;

    // RSI
    const rsiVal = rsi || 50;
    const rsiOverbought = rsiVal > 70;
    const rsiOversold = rsiVal < 30;

    // ATR volatility
    const atrHigh = atr && atr > (ema21 * 0.002); // ATR > 0.2% of price

    // Volume
    const volSpike = volume && volume.avg20 > 0 && volume.current > volume.avg20 * 1.5;

    // Candle structure
    const bullishCandle = lastCandle?.close > lastCandle?.open;
    const bearishCandle = lastCandle?.close < lastCandle?.open;
    const bodySize = Math.abs(lastCandle?.close - lastCandle?.open) || 0;
    const range = lastCandle?.high - lastCandle?.low || 1;
    const bodyRatio = range > 0 ? bodySize / range : 0;

    // Breakout detection
    const prevHigh = prevCandle?.high || 0;
    const prevLow = prevCandle?.low || 0;
    const breakoutUp = lastCandle?.high > prevHigh && bullishCandle && bodyRatio > 0.6;
    const breakoutDown = lastCandle?.low < prevLow && bearishCandle && bodyRatio > 0.6;

    // Reversal detection
    const prevBullish = prevCandle?.close > prevCandle?.open;
    const prevBearish = prevCandle?.close < prevCandle?.open;
    const reversalUp = prevBearish && bullishCandle && bodyRatio > 0.5 && rsiOversold;
    const reversalDown = prevBullish && bearishCandle && bodyRatio > 0.5 && rsiOverbought;

    // Score-based state determination
    let trendScore = 0;
    let volScore = 0;

    if (bullishEMA) {
      trendScore += 2;
      reasons.push('Bullish EMA alignment');
    }
    if (bearishEMA) {
      trendScore -= 2;
      reasons.push('Bearish EMA alignment');
    }
    if (aboveVWAP) {
      trendScore += 1;
      reasons.push('Above VWAP');
    }
    if (belowVWAP) {
      trendScore -= 1;
      reasons.push('Below VWAP');
    }
    if (volSpike) {
      volScore += 2;
      reasons.push('Volume spike');
    }
    if (atrHigh) {
      volScore += 1;
      reasons.push('High volatility (ATR)');
    }
    if (bbSqueeze) {
      volScore += 1;
      reasons.push('BB squeeze');
    }

    if (breakoutUp && volSpike) {
      state = STATES.BREAKOUT;
      confidence = 85;
      reasons.push('Breakout up with volume');
    } else if (breakoutDown && volSpike) {
      state = STATES.BREAKOUT;
      confidence = 85;
      reasons.push('Breakout down with volume');
    } else if (reversalUp && volSpike) {
      state = STATES.REVERSAL;
      confidence = 75;
      reasons.push('Bullish reversal');
    } else if (reversalDown && volSpike) {
      state = STATES.REVERSAL;
      confidence = 75;
      reasons.push('Bearish reversal');
    } else if (bbSqueeze && Math.abs(trendScore) < 2) {
      state = STATES.SIDEWAYS;
      confidence = 70;
      reasons.push('BB squeeze + no trend');
    } else if (volScore >= 3 && Math.abs(trendScore) < 2) {
      state = STATES.VOLATILE;
      confidence = 65;
      reasons.push('High volatility, no clear trend');
    } else if (trendScore >= 2) {
      state = STATES.TRENDING_BULLISH;
      confidence = Math.min(90, 60 + trendScore * 10 + (volSpike ? 10 : 0));
      reasons.push('Strong bullish trend');
    } else if (trendScore <= -2) {
      state = STATES.TRENDING_BEARISH;
      confidence = Math.min(90, 60 + Math.abs(trendScore) * 10 + (volSpike ? 10 : 0));
      reasons.push('Strong bearish trend');
    } else {
      state = STATES.SIDEWAYS;
      confidence = 50;
      reasons.push('No clear trend');
    }

    // Smooth state transitions
    if (this.state !== state && this.confidence > 70) {
      const recent = this.history.slice(-2);
      const allSame = recent.every(h => h.state === state);
      if (!allSame) {
        state = this.state;
        confidence = Math.max(confidence - 20, 30);
      }
    }

    this.state = state;
    this.confidence = confidence;

    const result = {
      state,
      confidence,
      reasons,
      indicators: {
        bullishEMA,
        bearishEMA,
        aboveVWAP,
        belowVWAP,
        bbSqueeze,
        rsiOverbought,
        rsiOversold,
        atrHigh,
        volSpike,
        breakoutUp,
        breakoutDown,
        reversalUp,
        reversalDown,
      },
      timestamp: Date.now(),
    };

    this.history.push(result);
    if (this.history.length > this.maxHistory) this.history.shift();

    return result;
  }

  getState() {
    return { state: this.state, confidence: this.confidence, history: this.history };
  }

  reset() {
    this.state = STATES.UNKNOWN;
    this.confidence = 0;
    this.history = [];
    this._lastPrice = null;
    this._lastPriceTs = 0;
    console.log('🔄 Market state engine reset');
  }
}

module.exports = { MarketStateEngine: new MarketStateEngine(), STATES, MarketStateEngineClass: MarketStateEngine };
