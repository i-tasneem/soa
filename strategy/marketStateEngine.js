// ============================================================
//  MARKET STATE ENGINE
//  Classifies: TRENDING_BULLISH | TRENDING_BEARISH |
//              SIDEWAYS | VOLATILE | BREAKOUT | REVERSAL
// ============================================================

const STATES = {
  TRENDING_BULLISH: 'TRENDING_BULLISH',
  TRENDING_BEARISH: 'TRENDING_BEARISH',
  SIDEWAYS:         'SIDEWAYS',
  VOLATILE:         'VOLATILE',
  BREAKOUT:         'BREAKOUT',
  REVERSAL:         'REVERSAL',
  UNKNOWN:          'UNKNOWN',
};

class MarketStateEngine {
  constructor() {
    this.state        = STATES.UNKNOWN;
    this.history      = [];
    this.maxHistory   = 10;
    this.lastPrice    = null;
    this.priceHistory = []; // last 20 prices for ranging detection
  }

  // Main classification — call after each indicator update
  classify(indicators, oiAnalysis) {
    if (!indicators) return { state: STATES.UNKNOWN, reasons: [], score: 0 };

    const { bias, bb, momentum, candle, breakout, price } = indicators;
    const reasons = [];
    let bullScore = 0;
    let bearScore = 0;

    // Track price history for ranging detection
    this.priceHistory.push(price);
    if (this.priceHistory.length > 20) this.priceHistory.shift();

    // ── EMA ALIGNMENT ────────────────────────────────────────
    if (bias.bullishEMA) { bullScore += 2; reasons.push('EMA_BULL_ALIGNED'); }
    if (bias.bearishEMA) { bearScore += 2; reasons.push('EMA_BEAR_ALIGNED'); }

    // ── VWAP POSITION ────────────────────────────────────────
    if (bias.aboveVWAP) { bullScore += 1; reasons.push('ABOVE_VWAP'); }
    if (bias.belowVWAP) { bearScore += 1; reasons.push('BELOW_VWAP'); }

    // ── HTF BIAS (15m) ───────────────────────────────────────
    if (bias.htfBullish) { bullScore += 2; reasons.push('HTF_BULL'); }
    if (bias.htfBearish) { bearScore += 2; reasons.push('HTF_BEAR'); }

    // ── MOMENTUM ─────────────────────────────────────────────
    if (momentum.bullMomentum) { bullScore += 1; reasons.push('BULL_MOMENTUM'); }
    if (momentum.bearMomentum) { bearScore += 1; reasons.push('BEAR_MOMENTUM'); }

    // ── CANDLE STRENGTH ──────────────────────────────────────
    if (candle.last?.isStrong && candle.last?.bullish) { bullScore += 1; reasons.push('STRONG_BULL_CANDLE'); }
    if (candle.last?.isStrong && candle.last?.bearish) { bearScore += 1; reasons.push('STRONG_BEAR_CANDLE'); }

    // ── BOLLINGER ────────────────────────────────────────────
    const bb5 = bb['5m'];
    const isSqueeze   = bb5?.squeeze;
    const isExpanding = bb5?.expanding || (!isSqueeze && bb5?.bandwidth > 2);
    const isVolatile  = bb5?.bandwidth > 4;

    if (breakout.priceAboveBB) { bullScore += 2; reasons.push('PRICE_ABOVE_BB'); }
    if (breakout.priceBelowBB) { bearScore += 2; reasons.push('PRICE_BELOW_BB'); }

    // ── OI CONFIRMATION ──────────────────────────────────────
    if (oiAnalysis?.ceBuyConfirmed) { bullScore += 1; reasons.push('OI_BULL'); }
    if (oiAnalysis?.peBuyConfirmed) { bearScore += 1; reasons.push('OI_BEAR'); }

    // ── RANGING DETECTION ────────────────────────────────────
    const isRanging = this._detectRanging();

    // ── CLASSIFY STATE ───────────────────────────────────────
    let state;

    if (isVolatile && !bias.bullishEMA && !bias.bearishEMA) {
      state = STATES.VOLATILE;
    } else if (isSqueeze && !isExpanding) {
      state = STATES.SIDEWAYS;
      reasons.push('BB_SQUEEZE');
    } else if (isRanging && Math.abs(bullScore - bearScore) < 2) {
      state = STATES.SIDEWAYS;
      reasons.push('PRICE_RANGING');
    } else if (breakout.priceAboveBB && bias.bullishEMA && momentum.bullMomentum) {
      state = STATES.BREAKOUT;
      reasons.push('BULL_BREAKOUT');
    } else if (breakout.priceBelowBB && bias.bearishEMA && momentum.bearMomentum) {
      state = STATES.BREAKOUT;
      reasons.push('BEAR_BREAKOUT');
    } else if (candle.last?.isHammer && bias.bearishEMA) {
      state = STATES.REVERSAL;
      reasons.push('HAMMER_REVERSAL');
    } else if (candle.last?.isShootingStar && bias.bullishEMA) {
      state = STATES.REVERSAL;
      reasons.push('SHOOTING_STAR_REVERSAL');
    } else if (bullScore > bearScore + 2) {
      state = STATES.TRENDING_BULLISH;
    } else if (bearScore > bullScore + 2) {
      state = STATES.TRENDING_BEARISH;
    } else {
      state = STATES.SIDEWAYS;
    }

    const result = {
      state,
      bullScore,
      bearScore,
      reasons,
      isSqueeze,
      isExpanding,
      isVolatile,
      isRanging,
      timestamp: Date.now(),
    };

    this.state = state;
    this.history.push(result);
    if (this.history.length > this.maxHistory) this.history.shift();

    return result;
  }

  _detectRanging() {
    if (this.priceHistory.length < 10) return false;
    const recent = this.priceHistory.slice(-10);
    const max = Math.max(...recent);
    const min = Math.min(...recent);
    const range = max - min;
    // If price is oscillating in a narrow 150-point range = ranging
    return range < 150;
  }

  // Check if state is tradeable (not sideways/volatile)
  isTradeable() {
    return [
      STATES.TRENDING_BULLISH,
      STATES.TRENDING_BEARISH,
      STATES.BREAKOUT,
    ].includes(this.state);
  }

  // Is bullish state
  isBullish() {
    return this.state === STATES.TRENDING_BULLISH || this.state === STATES.BREAKOUT;
  }

  // Is bearish state
  isBearish() {
    return this.state === STATES.TRENDING_BEARISH;
  }

  getState() { return this.state; }
}

module.exports = { MarketStateEngine: new MarketStateEngine(), STATES };
