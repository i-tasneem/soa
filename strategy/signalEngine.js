		// ============================================================
// SIGNAL ENGINE (PHASE A + Phase 2 + Phase 3)
// Fixes:
// - entryPremium selected by signal type (CE uses cePremium, PE uses pePremium)
// - signal includes contract metadata (strike/token/expiry) when provided
//
// Phase 2:
// - SETUP (near-miss) signals for confidence 55–69 OR strong OI signals
// - OI dynamics boosts: PCR trend, buildup/covering/unwinding
//
// Phase 3:
// - Wall pressure (weakening/strengthening) based proactive setups
// - +20 boost when breakout aligns with wall weakening
// ============================================================

const { STATES } = require('./marketStateEngine');
const config = require('../config');
class SignalEngine {
  constructor() {
    this.todaySignals = [];
    this.maxPerDay = 5;
    this.lastSignal = null;
    this.cooldownMs = 5 * 60 * 1000;
    this.lastDate = null;
	this.setupsInProgress = new Map();

  }
	
 
   _ensureDay() {
     const today = new Date().toDateString();
     if (this.lastDate !== today) {
       this.lastDate = today;
       this.resetDay();
     }
   }
 
	_convertSetupToConfirmed(setup, indicators) {
  const confirmed = {
    ...setup,
    signalStage: 'CONFIRMED',
    confidence: Math.min(100, setup.confidence + 15),
    escalatedFrom: setup.id,
    escalatedAt: Date.now()
  };

  this.todaySignals.push(confirmed);
  this.lastSignal = confirmed;

  return confirmed;
}
 
	_checkSetupEscalation(setupData, indicators, oiAnalysis) {
  const setup = setupData.setup;

  if (setup.setupType === 'BULLISH_BUILDUP') {
    const res = oiAnalysis?.walls?.resistanceNearest;

    if (
      indicators.price > res?.center &&
      oiAnalysis?.wallPressure?.resistanceWeakening &&
      Date.now() - setup.time < 300000
    ) {
      return this._convertSetupToConfirmed(setup, indicators);
    }
  }

  if (setup.setupType === 'BEARISH_BUILDUP') {
    const sup = oiAnalysis?.walls?.supportNearest;

    if (
      indicators.price < sup?.center &&
      oiAnalysis?.wallPressure?.supportWeakening &&
      Date.now() - setup.time < 300000
    ) {
      return this._convertSetupToConfirmed(setup, indicators);
    }
  }

  return null;
}
 
   _selectBestSignal(indicators, marketState, oiAnalysis, premiums, meta = null) {
     if (!indicators || !marketState) return null;
 
     // Only tradeable states (unchanged behavior)
     if (!['TRENDING_BULLISH', 'TRENDING_BEARISH', 'BREAKOUT'].includes(marketState.state)) {
       return null;
     }
 
     // Existing staleness / noise guardrails (unchanged behavior)
     if (oiAnalysis?.stale || oiAnalysis?.premiumsStale) return null;
 
     const velThr = config?.strategy?.oiVelocityThreshold ?? 0;
     if (velThr > 0 && oiAnalysis?.oiVelocity) {
       const ceV = Math.abs(Number(oiAnalysis.oiVelocity.cePerMin) || 0);
       const peV = Math.abs(Number(oiAnalysis.oiVelocity.pePerMin) || 0);
       if (Math.max(ceV, peV) < velThr) return null;
     }
 
     const ceSignal = this._evaluateCE(indicators, marketState, oiAnalysis);
     const peSignal = this._evaluatePE(indicators, marketState, oiAnalysis);
 
     const threshold = config?.strategy?.signalThreshold ?? 70;
     const candidates = [ceSignal, peSignal]
       .filter(s => s && s.confidence >= threshold)
       .sort((a, b) => b.confidence - a.confidence);
 
     if (candidates.length > 0) {
       const winner = candidates[0];
       const cePrem = premiums && typeof premiums === 'object' ? premiums.ce : premiums;
       const pePrem = premiums && typeof premiums === 'object' ? premiums.pe : premiums;
       const entryPremium = winner.type === 'BUY_CE' ? cePrem : pePrem;
       const contract = meta?.exec ? (winner.type === 'BUY_CE' ? meta.exec.ce : meta.exec.pe) : null;
       return {
         kind: 'CONFIRMED',
         signal: winner,
         entryPremium,
         contract
       };
     }
 
     const best = [ceSignal, peSignal]
       .filter(Boolean)
       .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
 
     if (this._shouldEmitSetup(best, oiAnalysis)) {
       const setup = this._buildSetupSignal(best, oiAnalysis);
       if (setup) {
         return {
           kind: 'SETUP',
           signal: setup,
           entryPremium: null,
           contract: null
         };
       }
     }
 
     return null;
   }
 
   preview(indicators, marketState, oiAnalysis, currentTime, premiums, meta = null) {
     this._ensureDay();
     if (this.todaySignals.length >= this.maxPerDay) return null;
     if (!this._isEntryTime(currentTime)) return null;
 
     const picked = this._selectBestSignal(indicators, marketState, oiAnalysis, premiums, meta);
     if (!picked) return null;
 
     // Do NOT mutate lastSignal/todaySignals here.
     const preview = {
       ...picked.signal,
       id: `CAND_${picked.signal.type}_${Math.floor(Date.now() / 10000)}`,
       time: Date.now(),
       timeStr: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
       price: indicators.price,
       vwap: indicators.vwap?.vwap,
       ema5: indicators.ema.ema5,
       ema9: indicators.ema.ema9,
       ema15: indicators.ema.ema15,
       entryPremium: picked.entryPremium,
       strike: picked.contract?.strike ?? null,
       optionToken: picked.contract?.token ?? null,
       expiry: picked.contract?.expiry ?? null,
       target: picked.entryPremium ? parseFloat((picked.entryPremium + 25).toFixed(2)) : null,
       sl: picked.entryPremium ? parseFloat((picked.entryPremium - 20).toFixed(2)) : null,
       tradeStatus: 'PENDING_CONFIRMATION',
       signalStage: 'CANDIDATE'
     };
 
     return preview;
   }	
	
resetDay() {
    this.todaySignals = [];
    this.lastSignal = null;
    this.setupsInProgress.clear();
    console.log('📅 Signal engine reset for new day');
  }

  // ---------------- PHASE 2/3: SETUP (near-miss) helpers ----------------

  _isRising(pcrTrend) {
    return pcrTrend === 'RISING' || pcrTrend === 'RISING_FAST';
  }

  _isFalling(pcrTrend) {
    return pcrTrend === 'FALLING' || pcrTrend === 'FALLING_FAST';
  }
  
  _getImbalanceBoost(type, oiAnalysis) {
    const score = Number(oiAnalysis?.imbalance?.score ?? oiAnalysis?.imbalanceScore ?? 0);
    const bias = oiAnalysis?.imbalance?.bias ?? oiAnalysis?.imbalanceBias ?? 'NEUTRAL';

    if (!Number.isFinite(score) || !bias || bias === 'NEUTRAL') {
      return { boost: 0, aligned: false, bias: 'NEUTRAL', score: 0 };
    }

    const aligned =
      (type === 'BUY_CE' && bias === 'BULLISH') ||
      (type === 'BUY_PE' && bias === 'BEARISH');

    if (!aligned) {
      return { boost: 0, aligned: false, bias, score };
    }

    const absScore = Math.abs(score);
    const weakBoost = Number(config?.oi?.imbalanceWeakBoost ?? 5);
    const strongBoost = Number(config?.oi?.imbalanceStrongBoost ?? 8);
    const maxBoost = Number(config?.oi?.imbalanceMaxBoost ?? 10);

    let boost = weakBoost;
    if (absScore >= 0.16) boost = strongBoost;
    if (absScore >= 0.22) boost = maxBoost;

    boost = Math.max(0, Math.min(maxBoost, Number(boost) || 0));

    return { boost, aligned: true, bias, score };
  }

  _buildImbalanceMeta(type, oiAnalysis, appliedBoost = 0) {
    const score = Number(oiAnalysis?.imbalance?.score ?? oiAnalysis?.imbalanceScore ?? 0);
    const bias = oiAnalysis?.imbalance?.bias ?? oiAnalysis?.imbalanceBias ?? 'NEUTRAL';

    return {
      score: Number.isFinite(score) ? Number(score.toFixed(4)) : 0,
      bias,
      appliedBoost: Number(appliedBoost || 0),
      totalCEoi: Number(oiAnalysis?.imbalance?.totalCEoi ?? oiAnalysis?.totalCEoi ?? 0),
      totalPEoi: Number(oiAnalysis?.imbalance?.totalPEoi ?? oiAnalysis?.totalPEoi ?? 0),
      aligned:
        (type === 'BUY_CE' && bias === 'BULLISH') ||
        (type === 'BUY_PE' && bias === 'BEARISH')
    };
  }

  // Determine what setupType/triggerHint we should emit for a given side.
  // PHASE 3 priority: Wall weakening setups first (most actionable)
  _getSetupMeta(type, oiAnalysis) {
    const flags = oiAnalysis?.flowFlags || {};
    const trend = oiAnalysis?.pcrTrend || null;

    if (type === 'BUY_CE') {
      // PHASE 3: wall-based proactive setup (priority)
      if (oiAnalysis?.proximity?.nearResistance && oiAnalysis?.wallPressure?.resistanceWeakening) {
        return { setupType: 'BULLISH_BUILDUP', triggerHint: 'watch resistance break' };
      }

      if (flags.shortCovering) return { setupType: 'SHORT_COVERING', triggerHint: 'watch resistance break' };
      if (flags.longBuildup || this._isRising(trend)) return { setupType: 'BULLISH_BUILDUP', triggerHint: 'wait for breakout' };
    }

    if (type === 'BUY_PE') {
      // PHASE 3: wall-based proactive setup (priority)
      if (oiAnalysis?.proximity?.nearSupport && oiAnalysis?.wallPressure?.supportWeakening) {
        return { setupType: 'BEARISH_BUILDUP', triggerHint: 'watch support break' };
      }

      if (flags.longUnwinding) return { setupType: 'LONG_UNWINDING', triggerHint: 'watch support break' };
      if (flags.shortBuildup || this._isFalling(trend)) return { setupType: 'BEARISH_BUILDUP', triggerHint: 'wait for breakout' };
    }

    return null;
  }

  _shouldEmitSetup(signal, oiAnalysis) {
    if (!signal) return false;

    const score = signal.confidence || 0;

    // Setup confidence window
    
	const setupMin = config?.strategy?.setupThreshold ?? 55;
	const setupMax = (config?.strategy?.signalThreshold ?? 70) - 1;


    // Strong OI can justify an early setup even if score is slightly below setupMin
    const strongMin = 45;

    const meta = this._getSetupMeta(signal.type, oiAnalysis);
    if (!meta) return false;

    // PHASE 3: always allow setup when wall weakening + proximity aligns
    const wallSetup =
      (signal.type === 'BUY_CE' && oiAnalysis?.proximity?.nearResistance && oiAnalysis?.wallPressure?.resistanceWeakening) ||
      (signal.type === 'BUY_PE' && oiAnalysis?.proximity?.nearSupport && oiAnalysis?.wallPressure?.supportWeakening);

    if (wallSetup) return true;

    if (score >= setupMin && score <= setupMax) return true;
    if (score >= strongMin) return true; // strong OI path

    return false;
  }

  _buildSetupSignal(best, oiAnalysis) {
    const meta = this._getSetupMeta(best.type, oiAnalysis);
    if (!meta) return null;

    return {
      ...best,
      nearMiss: true,
      setupType: meta.setupType,
      triggerHint: meta.triggerHint,
      strength: 'SETUP',
    };
  }

  // evaluate(indicators, marketState, oiAnalysis, currentTime, premiums, meta)
  // premiums: { ce:number|null, pe:number|null }
  // meta: { exec:{ce:{strike,token,expiry}, pe:{...}}, atm:{strike,call,put} }
evaluate(indicators, marketState, oiAnalysis, currentTime, premiums, meta = null) {
    if (!indicators || !marketState) return null;

    this._ensureDay();

    if (this.todaySignals.length >= this.maxPerDay) return null;
    if (!this._isEntryTime(currentTime)) return null;

    for (const [id, setupData] of this.setupsInProgress) {
      const escalated = this._checkSetupEscalation(setupData, indicators, oiAnalysis);
      if (escalated) {
        this.setupsInProgress.delete(id);
        escalated.signalStage = 'CONFIRMED';
        return escalated;
      }
    }

    if (this.lastSignal && Date.now() - this.lastSignal.time < this.cooldownMs) return null;

    const picked = this._selectBestSignal(indicators, marketState, oiAnalysis, premiums, meta);
    if (!picked) return null;

    if (picked.kind === 'SETUP') {
      const setup = this._fireSignal(picked.signal, indicators, null, null);
      setup.signalStage = 'SETUP';
      this.setupsInProgress.set(setup.id, { setup });
      return setup;
    }

    const committed = this._fireSignal(picked.signal, indicators, picked.entryPremium, picked.contract);
    committed.signalStage = 'CONFIRMED';
    return committed;
  }

  _evaluateCE(indicators, marketState, oiAnalysis) {
    // PHASE 3: Avoid signals if nearPin
    if (oiAnalysis?.nearPin) {
      console.log('🚫 CE blocked — OI pin zone');
      return null;
    }

    if (indicators.candle.last?.body < 8) {
      console.log('🚫 CE blocked — insufficient momentum');
      return null;
    }

    if (indicators.bias.bearishEMA) return null;
    if (marketState.state === STATES.TRENDING_BEARISH) return null;

    const { bias, bb, momentum, candle, breakout } = indicators;
    const bb5 = bb['5m'];

    let score = 0;
    const factors = [];

    // ---- Existing scoring (keep intact) ----
    if (bias.bullishEMA) {
      score += 25;
      factors.push({ name: 'EMA Bullish Aligned', score: 25 });
    } else if (indicators.ema.ema5 > indicators.ema.ema9) {
      score += 10;
      factors.push({ name: 'EMA Partial Bull', score: 10 });
    }

    if (bias.aboveVWAP) {
      score += 20;
      factors.push({ name: 'Above VWAP', score: 20 });
    }

    if (bias.htfBullish) {
      score += 15;
      factors.push({ name: 'HTF Bullish (15m)', score: 15 });
    }

    const realExpansion = !bb5?.squeeze && bb5?.bandwidth > 2;

    if (bb5?.squeeze && breakout.priceAboveBB) {
      score += 20;
      factors.push({ name: 'BB Squeeze Breakout', score: 20 });
    } else if (breakout.priceAboveBB) {
      score += 15;
      factors.push({ name: 'BB Breakout Up', score: 15 });
    } else if (realExpansion) {
      score += 8;
      factors.push({ name: 'BB Expanding', score: 8 });
    } else if (bb5?.squeeze && !breakout.priceAboveBB) {
      score -= 5;
      factors.push({ name: 'BB Squeeze No Breakout', score: -5 });
    }

    // PHASE 3: +20 if breakout aligns with resistance wall weakening
    if (breakout.priceAboveBB && oiAnalysis?.proximity?.nearResistance && oiAnalysis?.wallPressure?.resistanceWeakening) {
      score += 20;
      factors.push({ name: 'Wall Weakening + Breakout (CE)', score: 20 });
    }

    if (candle.last?.isStrong && candle.last?.bullish) {
      score += 15;
      factors.push({ name: 'Strong Bull Candle', score: 15 });
    } else if (candle.last?.bullish && !candle.last?.isDoji) {
      score += 7;
      factors.push({ name: 'Bullish Candle', score: 7 });
    }

    if (oiAnalysis?.ceBuyConfirmed) {
      score += 10;
      factors.push({ name: 'OI PCR Bullish', score: 10 });
    }

    if (oiAnalysis?.oiBullish) {
      score += 5;
      factors.push({ name: 'PE Writers Active', score: 5 });
    }

    // PHASE 2: OI dynamics boosts (must NOT be inside oiBullish)
    const trend = oiAnalysis?.pcrTrend;
    const flags = oiAnalysis?.flowFlags;

    if (flags?.longBuildup) {
      score += 15;
      factors.push({ name: 'OI Long Buildup', score: 15 });
    }

    if (flags?.shortCovering) {
      score += 20;
      factors.push({ name: 'OI Short Covering', score: 20 });
    }

    if (trend === 'RISING' || trend === 'RISING_FAST') {
      score += 10;
      factors.push({ name: 'PCR Trend Rising', score: 10 });
    }

    if (momentum.bullMomentum) {
      score += 5;
      factors.push({ name: 'Bull Momentum', score: 5 });
    }

    // Penalty near resistance stays (requirement)
    if (oiAnalysis?.proximity?.nearResistance) {
      score -= 20;
      factors.push({ name: 'Near CE Resistance ⚠️', score: -20 });
    }

    if (candle.last?.isDoji) {
      score -= 10;
      factors.push({ name: 'Doji Candle ⚠️', score: -10 });
    }

    if (candle.last?.isShootingStar) {
      score -= 20;
      factors.push({ name: 'Shooting Star ⚠️', score: -20 });
    }

    if (marketState.state === STATES.SIDEWAYS) {
      score -= 25;
      factors.push({ name: 'Sideways Market ⚠️', score: -25 });
    }
	
	const ceImbalance = this._getImbalanceBoost('BUY_CE', oiAnalysis);
    if (ceImbalance.boost > 0) {
      score += ceImbalance.boost;
      factors.push({ name: `OI Imbalance ${ceImbalance.bias}`, score: ceImbalance.boost });
    }
	
   score = Math.max(0, Math.min(100, score));
    return {
      type: 'BUY_CE',
      confidence: score,
      rawConfidence: score,
      factors,
      imbalance: this._buildImbalanceMeta('BUY_CE', oiAnalysis, ceImbalance.boost),
      strength: score >= 85 ? 'STRONG' : score >= 70 ? 'MODERATE' : 'WEAK',
    };
  }

  _evaluatePE(indicators, marketState, oiAnalysis) {
    // PHASE 3: Avoid signals if nearPin
    if (oiAnalysis?.nearPin) {
      console.log('🚫 PE blocked — OI pin zone');
      return null;
    }

    if (indicators.candle.last?.body < 8) {
      console.log('🚫 PE blocked — insufficient momentum');
      return null;
    }

    if (indicators.bias.bullishEMA) return null;
    if (marketState.state === STATES.TRENDING_BULLISH) return null;

    const { bias, bb, momentum, candle, breakout } = indicators;
    const bb5 = bb['5m'];

    let score = 0;
    const factors = [];

    // ---- Existing scoring (keep intact) ----
    if (bias.bearishEMA) {
      score += 25;
      factors.push({ name: 'EMA Bearish Aligned', score: 25 });
    } else if (indicators.ema.ema5 < indicators.ema.ema9) {
      score += 10;
      factors.push({ name: 'EMA Partial Bear', score: 10 });
    }

    if (bias.belowVWAP) {
      score += 20;
      factors.push({ name: 'Below VWAP', score: 20 });
    }

    if (bias.htfBearish) {
      score += 15;
      factors.push({ name: 'HTF Bearish (15m)', score: 15 });
    }

    const realExpansion = !bb5?.squeeze && bb5?.bandwidth > 2;

    if (bb5?.squeeze && breakout.priceBelowBB) {
      score += 20;
      factors.push({ name: 'BB Squeeze Breakdown', score: 20 });
    } else if (breakout.priceBelowBB) {
      score += 15;
      factors.push({ name: 'BB Breakdown', score: 15 });
    } else if (realExpansion) {
      score += 8;
      factors.push({ name: 'BB Expanding', score: 8 });
    } else if (bb5?.squeeze && !breakout.priceBelowBB) {
      score -= 5;
      factors.push({ name: 'BB Squeeze No Breakout', score: -5 });
    }

    // PHASE 3: +20 if breakdown aligns with support wall weakening
    if (breakout.priceBelowBB && oiAnalysis?.proximity?.nearSupport && oiAnalysis?.wallPressure?.supportWeakening) {
      score += 20;
      factors.push({ name: 'Wall Weakening + Breakdown (PE)', score: 20 });
    }

    if (candle.last?.isStrong && candle.last?.bearish) {
      score += 15;
      factors.push({ name: 'Strong Bear Candle', score: 15 });
    } else if (candle.last?.bearish && !candle.last?.isDoji) {
      score += 7;
      factors.push({ name: 'Bearish Candle', score: 7 });
    }

    if (oiAnalysis?.peBuyConfirmed) {
      score += 10;
      factors.push({ name: 'OI PCR Bearish', score: 10 });
    }

    if (oiAnalysis?.oiBearish) {
      score += 5;
      factors.push({ name: 'CE Writers Active', score: 5 });
    }

    // PHASE 2: OI dynamics boosts (must NOT be inside oiBearish)
    const trend = oiAnalysis?.pcrTrend;
    const flags = oiAnalysis?.flowFlags;

    if (flags?.shortBuildup) {
      score += 15;
      factors.push({ name: 'OI Short Buildup', score: 15 });
    }

    if (flags?.longUnwinding) {
      score += 20;
      factors.push({ name: 'OI Long Unwinding', score: 20 });
    }

    if (trend === 'FALLING' || trend === 'FALLING_FAST') {
      score += 10;
      factors.push({ name: 'PCR Trend Falling', score: 10 });
    }

    if (momentum.bearMomentum) {
      score += 5;
      factors.push({ name: 'Bear Momentum', score: 5 });
    }

    // Penalty near support stays (requirement)
    if (oiAnalysis?.proximity?.nearSupport) {
      score -= 20;
      factors.push({ name: 'Near PE Support ⚠️', score: -20 });
    }

    if (candle.last?.isDoji) {
      score -= 10;
      factors.push({ name: 'Doji Candle ⚠️', score: -10 });
    }

    if (candle.last?.isHammer) {
      score -= 20;
      factors.push({ name: 'Hammer Candle ⚠️', score: -20 });
    }

    if (marketState.state === STATES.SIDEWAYS) {
      score -= 25;
      factors.push({ name: 'Sideways Market ⚠️', score: -25 });
    }
	
	const peImbalance = this._getImbalanceBoost('BUY_PE', oiAnalysis);
    if (peImbalance.boost > 0) {
      score += peImbalance.boost;
      factors.push({ name: `OI Imbalance ${peImbalance.bias}`, score: peImbalance.boost });
    }

    score = Math.max(0, Math.min(100, score));
    return {
      type: 'BUY_PE',
      confidence: score,
      rawConfidence: score,
      factors,
      imbalance: this._buildImbalanceMeta('BUY_PE', oiAnalysis, peImbalance.boost),
      strength: score >= 85 ? 'STRONG' : score >= 70 ? 'MODERATE' : 'WEAK',
    };
  }

  _fireSignal(signal, indicators, entryPremium = null, contract = null) {
    const TARGET_PTS = 25;
    const SL_PTS = 20;

    const full = {
      ...signal,
      rawConfidence: Number(signal.rawConfidence ?? signal.confidence ?? 0),
      calibration: signal.calibration || null,
      imbalance: signal.imbalance || null,
      id: `SIG_${Date.now()}`,
      time: Date.now(),
      timeStr: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      price: indicators.price,
      vwap: indicators.vwap?.vwap,
      ema5: indicators.ema.ema5,
      ema9: indicators.ema.ema9,
      ema15: indicators.ema.ema15,
      signalNum: this.todaySignals.length + 1,
      entryPremium: entryPremium,
      strike: contract?.strike ?? null,
      optionToken: contract?.token ?? null,
      expiry: contract?.expiry ?? null,
      target: entryPremium ? parseFloat((entryPremium + TARGET_PTS).toFixed(2)) : null,
      sl: entryPremium ? parseFloat((entryPremium - SL_PTS).toFixed(2)) : null,
      tradeStatus: entryPremium ? 'OPEN' : 'NO_TRADE',
    };

    this.todaySignals.push(full);
    this.lastSignal = full;

    console.log(
      `🚨 SIGNAL #${full.signalNum}: ${full.type} Confidence: ${full.confidence}% Price: ${full.price} Premium: ${entryPremium ?? 'N/A'} Strike: ${full.strike ?? 'N/A'}`
    );

    return full;
  }

  updateSignalOutcome(signalId, outcome, pnl) {
    const sig = this.todaySignals.find(s => s.id === signalId);
    if (sig) {
      sig.tradeStatus = outcome;
      sig.pnl = pnl;
    }
  }

  _isEntryTime() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const mins = ist.getHours() * 60 + ist.getMinutes();

    if (mins < 570) return false; // before 9:30am
    if (mins > 930) return false; // after 3:30pm
    if (mins >= 720 && mins < 810) return false; // lunch 12:00–1:30
    return true;
  }

  getStats() {
    return {
      totalToday: this.todaySignals.length,
      remaining: this.maxPerDay - this.todaySignals.length,
      lastSignal: this.lastSignal,
      signals: this.todaySignals,
    };
  }
}

module.exports = new SignalEngine();