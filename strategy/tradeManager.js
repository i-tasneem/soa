// ============================================================
// TRADE MANAGER
// Manages open trades: entry, SL, target, trailing, exit
// ============================================================

class TradeManager {
  constructor() {
    this.activeTrade = null;
    this.trades = [];
    this.dailyPnL = 0;
    this.wins = 0;
    this.losses = 0;
    this._lastResetDate = null;
  }

  openTrade(signal, premium, lots, profile) {
    this._checkDayReset();

    if (this.activeTrade) return null;

    const atr = signal.indicators?.atr || 0;
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

    // Trailing stop logic
    if (premium >= trade.target * 0.5 && !trade.trailing) {
      trade.trailing = true;
      trade.trailSL = Math.round((entryPrem + (premium - entryPrem) * 0.3) * 100) / 100;
    }

    if (trade.trailing) {
      const newTrail = Math.round((entryPrem + (premium - entryPrem) * 0.3) * 100) / 100;
      if (newTrail > trade.trailSL) {
        trade.trailSL = newTrail;
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
    };
  }

  _checkDayReset() {
    const now = new Date();
    const today = now.toDateString();
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      this.activeTrade = null;
      this.trades = [];
      this.dailyPnL = 0;
      this.wins = 0;
      this.losses = 0;
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
    console.log('🔄 Trade manager reset');
  }
}

module.exports = new TradeManager();
module.exports.TradeManager = TradeManager;
