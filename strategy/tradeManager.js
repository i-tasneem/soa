// ============================================================
// TRADE MANAGER (PHASE A)
// Fixes:
// - trade now carries contract metadata (strike/token/expiry)
// - currentPremium updates are accurate when server feeds actual LTP
// ============================================================
const LOT_SIZE = 20;
const TARGET_PTS = 25;
const SL_PTS = 20;
const TRAIL_AFTER = 15;

class TradeManager {
  constructor() {
    this.activeTrade = null;
	this.confirmedToday = 0;
	this.maxConfirmed = 3;
    this.closedTrades = [];
    this.dailyPnL = 0;
    this.lots = 15;
  }

  setLots(n) { this.lots = n; }
  
  
  canOpenNewTrade() {
  if (this.activeTrade) {
    return {
      allowed: false,
      reason: 'Active trade exists'
    };
  }

  if (this.confirmedToday >= this.maxConfirmed) {
    return {
      allowed: false,
      reason: 'Daily CONFIRMED limit reached'
    };
  }

  return { allowed: true };
}

  // Open a trade on signal
  // contract = { strike, token, expiry }
openTrade(signal, premium, contract, opts = {}) {
    const check = this.canOpenNewTrade();
    if (!check.allowed) return null;
    if (!Number.isFinite(premium)) return null;

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
      target: parseFloat((premium + TARGET_PTS).toFixed(2)),
      sl: parseFloat((premium - SL_PTS).toFixed(2)),
      trailSL: parseFloat((premium - SL_PTS).toFixed(2)),
      trailing: false,
      maxProfit: 0,
      lots: this.lots,
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

    trade.unrealisedPnL = parseFloat((profit * LOT_SIZE * trade.lots).toFixed(2));

    if (profit >= TRAIL_AFTER && !trade.trailing) {
      trade.trailing = true;
      trade.trailSL = trade.entryPremium;
      console.log(`🔒 Trailing SL activated — SL moved to breakeven ₹${trade.trailSL}`);
    }

    if (trade.trailing) {
      const newTrailSL = currentPremium - SL_PTS;
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
    const pnl = parseFloat((profit * LOT_SIZE * trade.lots).toFixed(2));

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
    console.log(`${emoji} Trade closed: ${reason}  Premium: ₹${exitPremium}  P&L: ₹${pnl}`);

    return closed;
  }

  resetDay() {
    this.activeTrade = null;
    this.closedTrades = [];
    this.dailyPnL = 0;
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
