// ============================================================
// TRADE MANAGER
// Manages open trades: entry, SL, target, trailing, exit
// FIXES: Trailing stop logic tightened (never loosens below original SL).
//        Daily loss circuit breaker added.
//        IST day reset.
// ============================================================

class TradeManager {
  constructor() {
    this.activeTrade = null;
    this.trades = [];
    this.dailyPnL = 0;
    this.wins = 0;
    this.losses = 0;
    this._lastResetDate = null;
    this.tradingHalted = false;
    this.maxDailyLoss = 10000; // default, overridden by profile
  }

  openTrade(signal, premium, lots, profile) {
    this._checkDayReset();

    // FIX: Daily loss circuit breaker
    this.maxDailyLoss = profile?.maxDailyLoss || 10000;
    if (this.tradingHalted) {
      logger?.warn?.('Trade rejected: daily loss limit reached');
      return null;
    }

    if (this.activeTrade) return null;

    const atr = signal.indicators?.atr || signal.atr || 0;
    const price = signal.price || 0;
    const atrMult = profile?.atrMultiplier || { target: 0.8, sl: 0.6 };

    const target = premium + (atr * atrMult.target);
    const sl = premium - (atr * atrMult.sl);
    const trailSL = sl;

    const trade = {
      id: `TRADE_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      signalId: signal.id,
      type: signal.type,
      entryPrice: signal.price,
      entryPremium: premium,
      currentPremium: premium,
      target: Math.round(target * 100) / 100,
      sl: Math.round(sl * 100) / 100,
      trailSL: Math.round(trailSL * 100) / 100,
      trailing: false,
      lots: lots || profile?.lotSize || 15,
      entryTime: Date.now(),
      entryTimeStr: this._formatTime(Date.now()),
      unrealisedPnL: 0,
      status: 'OPEN',
      exitPrice: null,
      exitPremium: null,
      exitTime: null,
      exitReason: null,
      pnl: 0,
      targetPts: Math.round(atr * atrMult.target * 100) / 100,
      slPts: Math.round(atr * atrMult.sl * 100) / 100,
    };

    this.activeTrade = trade;
    this.trades.push(trade);

    return trade;
  }

  updateTrade(premium, price) {
    if (!this.activeTrade) return null;

    const trade = this.activeTrade;
    trade.currentPremium = premium;

    const lotSize = trade.lots;
    const entryPrem = trade.entryPremium;
    const pnl = (premium - entryPrem) * lotSize;
    trade.unrealisedPnL = Math.round(pnl * 100) / 100;

    // FIX: Trailing stop logic — tightened, never loosened below original SL
    const targetPts = trade.targetPts;
    const slPts = trade.slPts;
    const trailTrigger = entryPrem + (targetPts * 0.5); // 50% of target distance
    const trailAmount = targetPts * 0.4;

    if (premium >= trailTrigger && !trade.trailing) {
      trade.trailing = true;
      // First trail: set to max(originalSL, current - trailAmount)
      const firstTrail = Math.max(trade.sl, premium - trailAmount);
      trade.trailSL = Math.round(firstTrail * 100) / 100;
    }

    if (trade.trailing) {
      const newTrail = Math.max(trade.sl, premium - trailAmount);
      // Never let trailSL move downward
      if (newTrail > trade.trailSL) {
        trade.trailSL = Math.round(newTrail * 100) / 100;
      }
    }

    // Check exit conditions
    if (premium >= trade.target) {
      return this.closeTrade(premium, price, 'TARGET_HIT');
    }

    const effectiveSL = trade.trailing ? trade.trailSL : trade.sl;
    if (premium <= effectiveSL) {
      return this.closeTrade(premium, price, trade.trailing ? 'TRAIL_SL_HIT' : 'SL_HIT');
    }

    return { ...trade, updated: true };
  }

  closeTrade(premium, price, reason) {
    if (!this.activeTrade) return null;

    const trade = this.activeTrade;
    trade.currentPremium = premium;
    trade.exitPrice = price;
    trade.exitPremium = premium;
    trade.exitTime = Date.now();
    trade.exitTimeStr = this._formatTime(Date.now());
    trade.exitReason = reason;
    trade.status = reason === 'TARGET_HIT' ? 'WIN' : 'LOSS';

    const lotSize = trade.lots;
    const pnl = (premium - trade.entryPremium) * lotSize;
    trade.pnl = Math.round(pnl * 100) / 100;
    trade.unrealisedPnL = trade.pnl;

    this.dailyPnL += trade.pnl;
    if (trade.status === 'WIN') this.wins++;
    else this.losses++;

    // FIX: Check daily loss circuit breaker
    if (this.dailyPnL <= -this.maxDailyLoss) {
      this.tradingHalted = true;
    }

    const result = { ...trade };
    this.activeTrade = null;

    return result;
  }

  forceClose(premium, price, reason) {
    return this.closeTrade(premium, price, reason || 'MANUAL_CLOSE');
  }

  getActiveTrade() {
    return this.activeTrade ? { ...this.activeTrade } : null;
  }

  getStats() {
    return {
      dailyPnL: this.dailyPnL,
      wins: this.wins,
      losses: this.losses,
      totalTrades: this.trades.length,
      activeTrade: this.activeTrade ? { ...this.activeTrade } : null,
      tradingHalted: this.tradingHalted,
    };
  }

  _checkDayReset() {
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      this.activeTrade = null;
      this.trades = [];
      this.dailyPnL = 0;
      this.wins = 0;
      this.losses = 0;
      this.tradingHalted = false;
      console.log('🔄 Trade manager reset for new day');
    }
  }

  _formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  reset() {
    this.activeTrade = null;
    this.trades = [];
    this.dailyPnL = 0;
    this.wins = 0;
    this.losses = 0;
    this._lastResetDate = null;
    this.tradingHalted = false;
    console.log('🔄 Trade manager reset');
  }
}

module.exports = new TradeManager();
module.exports.TradeManager = TradeManager;
