// ============================================================
// TRADE MANAGER v7 — Minimal EventEmitter addition for audit hooks
// Changes from repo v6:
// 1. Extends EventEmitter
// 2. Emits tradeOpened, tradeClosed, tradeUpdated events
// 3. All existing logic preserved unchanged
// ============================================================

const EventEmitter = require('events');
const logger = require('../logger');

class TradeManager extends EventEmitter {
  constructor() {
    super();  // ADDED: EventEmitter initialization
    this.activeTrade = null;
    this.tradeHistory = [];
    this.stats = { total: 0, wins: 0, losses: 0, pnl: 0 };
    this._lastResetDate = null;
  }

  openTrade(signal, premium, lots, profile) {
    if (this.activeTrade) {
      logger.warn(`[TradeManager] Cannot open trade: already active ${this.activeTrade.id}`);
      return null;
    }

    const id = `TRADE_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const targetPts = Math.round((profile.targetMultiplier || 1.0) * (signal.targetPts || profile.defaultTarget || 20));
    const slPts = Math.round((profile.slMultiplier || 1.0) * (signal.slPts || profile.defaultSL || 15));
    const targetPremium = premium + targetPts;
    const slPremium = premium - slPts;
    const trailTrigger = premium + Math.round(targetPts * 0.5);
    const trailAmount = Math.round(targetPts * 0.4);

    const trade = {
      id,
      signalId: signal.id,
      instrument: signal.instrument,
      type: signal.type,
      entryPremium: premium,
      entryPrice: signal.entryPrice || 0,
      currentPremium: premium,
      currentPrice: signal.entryPrice || 0,
      lots,
      targetPts,
      slPts,
      targetPremium,
      slPremium,
      trailTrigger,
      trailAmount,
      trailSL: null,
      status: 'OPEN',
      openedAt: now,
      updatedAt: now,
      closedAt: null,
      exitReason: null,
      pnl: 0,
      maxProfit: 0,
      maxDrawdown: 0,
    };

    this.activeTrade = trade;
    this.stats.total++;
    logger.info(`[TradeManager] Trade opened: ${id} ${signal.type} @ ${premium} target=${targetPremium} SL=${slPremium}`);

    this.emit('tradeOpened', trade);  // ADDED: EventEmitter
    return trade;
  }

  updateTrade(premium, price) {
    if (!this.activeTrade) return null;
    const trade = this.activeTrade;
    trade.currentPremium = premium;
    trade.currentPrice = price;
    trade.updatedAt = Date.now();

    const pnl = (premium - trade.entryPremium) * trade.lots;
    trade.pnl = pnl;
    if (pnl > trade.maxProfit) trade.maxProfit = pnl;
    if (pnl < trade.maxDrawdown) trade.maxDrawdown = pnl;

    // Check target
    if (premium >= trade.targetPremium) {
      return this.closeTrade(premium, price, 'TARGET_HIT');
    }

    // Check SL
    if (premium <= trade.slPremium) {
      return this.closeTrade(premium, price, 'SL_HIT');
    }

    // Check trailing stop
    if (!trade.trailSL && premium >= trade.trailTrigger) {
      trade.trailSL = premium - trade.trailAmount;
      this.emit('trailingStopActivated', trade);  // ADDED: EventEmitter
      logger.info(`[TradeManager] Trailing stop activated: ${trade.id} trailSL=${trade.trailSL}`);
    }
    if (trade.trailSL && premium <= trade.trailSL) {
      return this.closeTrade(premium, price, 'TRAIL_SL_HIT');
    }

    this.emit('tradeUpdated', trade);  // ADDED: EventEmitter
    return trade;
  }

  closeTrade(premium, price, reason) {
    if (!this.activeTrade) return null;
    const trade = this.activeTrade;
    trade.currentPremium = premium;
    trade.currentPrice = price;
    trade.status = 'CLOSED';
    trade.closedAt = Date.now();
    trade.exitReason = reason;
    trade.pnl = (premium - trade.entryPremium) * trade.lots;
    trade.durationMs = trade.closedAt - trade.openedAt;

    if (trade.pnl >= 0) {
      this.stats.wins++;
      logger.info(`[TradeManager] Trade WIN: ${trade.id} ${reason} P&L=${trade.pnl.toFixed(2)}`);
    } else {
      this.stats.losses++;
      logger.info(`[TradeManager] Trade LOSS: ${trade.id} ${reason} P&L=${trade.pnl.toFixed(2)}`);
    }
    this.stats.pnl += trade.pnl;

    this.tradeHistory.push({ ...trade });
    this.activeTrade = null;

    this.emit('tradeClosed', trade);  // ADDED: EventEmitter
    return trade;
  }

  forceClose(premium, price, reason) {
    return this.closeTrade(premium, price, reason);
  }

  getActiveTrade() {
    return this.activeTrade;
  }

  getStats() {
    return { ...this.stats, winRate: this.stats.total > 0 ? (this.stats.wins / this.stats.total * 100).toFixed(2) : 0 };
  }

  reset() {
    this.activeTrade = null;
    this.tradeHistory = [];
    this.stats = { total: 0, wins: 0, losses: 0, pnl: 0 };
    this._lastResetDate = null;
    logger.info('[TradeManager] Reset');
  }
}

const tradeManager = new TradeManager();
module.exports = tradeManager;
module.exports.TradeManager = TradeManager;
