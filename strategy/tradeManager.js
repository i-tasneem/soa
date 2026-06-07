// ============================================================
// TRADE MANAGER — Institutional Grade A
// Dynamic target/SL from signal DNA
// Trailing SL at 60% of target profit
// ============================================================

class TradeManager {
  constructor() {
    this.activeTrade = null;
    this.confirmedToday = 0;
    this.maxConfirmed = 3;
    this.closedTrades = [];
    this.dailyPnL = 0;
    this.lots = 15;
    this.lotSize = 20; // default fallback
  }

  setLots(n) { this.lots = n; }

  canOpenNewTrade() {
    if (this.activeTrade) {
      return { allowed: false, reason: 'Active trade exists' };
    }
    if (this.confirmedToday >= this.maxConfirmed) {
      return { allowed: false, reason: 'Daily CONFIRMED limit reached' };
    }
    return { allowed: true };
  }

  openTrade(signal, premium, contract, opts = {}, dna = null) {
    const check = this.canOpenNewTrade();
    if (!check.allowed) return null;
    if (!Number.isFinite(premium)) return null;

    const lotSize = dna?.lotSize || this.lotSize || 20;
    const targetPts = signal.targetPts || 25;
    const slPts = signal.slPts || 20;

    this.activeTrade = {
      id: `TRADE_${Date.now()}`,
      signalId: signal.id,
      type: signal.type,
      entryPrice: signal.price ?? null,
      entryPremium: premium,
      currentPremium: premium,
      entryTime: Date.now(),
      strike: contract?.strike ?? signal.strike ?? null,
      optionToken: contract?.token ?? signal.optionToken ?? null,
      expiry: contract?.expiry ?? signal.expiry ?? null,
      target: parseFloat((premium + targetPts).toFixed(2)),
      sl: parseFloat((premium - slPts).toFixed(2)),
      trailSL: parseFloat((premium - slPts).toFixed(2)),
      trailing: false,
      maxProfit: 0,
      lots: opts.lots || this.lots || 15,
      lotSize,
      targetPts,
      slPts,
      isEarlyEntry: opts.early || false,
      earlyEntryReason: opts.reason || null,
      status: 'OPEN'
    };

    this.confirmedToday++;
    return this.activeTrade;
  }

  update(currentPremium) {
    if (!this.activeTrade || this.activeTrade.status !== 'OPEN') return null;
    const trade = this.activeTrade;
    trade.currentPremium = currentPremium;

    const profit = currentPremium - trade.entryPremium;
    trade.maxProfit = Math.max(trade.maxProfit, profit);
    trade.unrealisedPnL = parseFloat((profit * trade.lotSize * trade.lots).toFixed(2));

    // Trailing SL activates at 60% of target
    const trailTrigger = trade.targetPts * 0.6;
    if (profit >= trailTrigger && !trade.trailing) {
      trade.trailing = true;
      trade.trailSL = trade.entryPremium;
      console.log(`🔒 Trailing SL activated at 60% target — SL moved to breakeven ₹${trade.trailSL}`);
    }

    if (trade.trailing) {
      const trailAmount = trade.targetPts * 0.4;
      const newTrailSL = currentPremium - trailAmount;
      if (newTrailSL > trade.trailSL) {
        trade.trailSL = parseFloat(newTrailSL.toFixed(2));
      }
    }

    const effectiveSL = trade.trailing ? trade.trailSL : trade.sl;
    if (currentPremium <= effectiveSL) {
      return this._closeTrade('SL_HIT', currentPremium, effectiveSL);
    }
    if (currentPremium >= trade.target) {
      return this._closeTrade('TARGET_HIT', currentPremium, trade.target);
    }
    return null;
  }

  manualExit(reason = 'MANUAL', currentPremium) {
    if (!this.activeTrade) return null;
    return this._closeTrade(reason, currentPremium || this.activeTrade.currentPremium);
  }

  _closeTrade(reason, exitPremium, exitRef) {
    const trade = this.activeTrade;
    const profit = exitPremium - trade.entryPremium;
    const pnl = parseFloat((profit * trade.lotSize * trade.lots).toFixed(2));

    const closed = {
      ...trade,
      exitPremium,
      exitTime: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      reason,
      profit: parseFloat(profit.toFixed(2)),
      pnl,
      status: pnl >= 0 ? 'WIN' : 'LOSS',
    };

    this.closedTrades.push(closed);
    this.dailyPnL += pnl;
    this.activeTrade = null;

    const emoji = pnl >= 0 ? '✅' : '❌';
    console.log(`${emoji} Trade closed: ${reason} Premium: ₹${exitPremium} P&L: ₹${pnl}`);

    return closed;
  }

  resetDay() {
    this.activeTrade = null;
    this.closedTrades = [];
    this.dailyPnL = 0;
    this.confirmedToday = 0;
    console.log('📅 Trade manager reset for new day');
  }

  getState() {
    const wins = this.closedTrades.filter(t => t.status === 'WIN').length;
    const losses = this.closedTrades.filter(t => t.status === 'LOSS').length;

    return {
      activeTrade: this.activeTrade,
      closedTrades: this.closedTrades,
      dailyPnL: parseFloat(this.dailyPnL.toFixed(2)),
      totalTrades: this.closedTrades.length,
      wins,
      losses,
      winRate: this.closedTrades.length > 0
        ? Math.round((wins / this.closedTrades.length) * 100)
        : 0,
    };
  }
}

module.exports = new TradeManager();
