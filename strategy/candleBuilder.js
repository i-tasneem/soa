// ============================================================
// CANDLE BUILDER
// Converts real-time ticks into OHLCV candles
// Timeframes: 3m, 5m, 15m, 30m
// ============================================================

const EventEmitter = require('events');

class CandleBuilder extends EventEmitter {
  constructor() {
    super();
    // Candle storage — last 200 candles per timeframe
    this.candles = { 3: [], 5: [], 15: [], 30: [] };
    // Current forming candle per timeframe
    this.current = { 3: null, 5: null, 15: null, 30: null };
    // Timeframes in minutes
    this.timeframes = [3, 5, 15, 30];
  }

  // Feed a tick — call this on every LTP update
  tick(ltp, timestamp = Date.now()) {
    const ts = new Date(timestamp);
    for (const tf of this.timeframes) {
      this._processTick(tf, ltp, ts);
    }
  }

  // Add method to pre-load historical candles
  preload(historicalCandles, tf) {
    if (!historicalCandles || historicalCandles.length === 0) return;
    this.candles[tf] = historicalCandles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume || 0,
      ticks: 1,
    }));
    // Keep last 200
    if (this.candles[tf].length > 200) {
      this.candles[tf] = this.candles[tf].slice(-200);
    }
    console.log(`📦 Preloaded ${this.candles[tf].length} candles for ${tf}m`);
  }

  _processTick(tf, ltp, ts) {
    const slotStart = this._getSlotStart(tf, ts);
    const cur = this.current[tf];

    if (!cur || cur.time !== slotStart) {
      // Close previous candle
      if (cur) {
        this.candles[tf].push({ ...cur });
        if (this.candles[tf].length > 200) this.candles[tf].shift();
        this.emit('candle', { tf, candle: { ...cur }, closed: true });
      }
      // Open new candle
      this.current[tf] = {
        time: slotStart,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        volume: 0,
        ticks: 1,
      };
      this.emit('candle', { tf, candle: { ...this.current[tf] }, closed: false });
    } else {
      // Update current candle
      cur.high = Math.max(cur.high, ltp);
      cur.low = Math.min(cur.low, ltp);
      cur.close = ltp;
      cur.ticks++;
      this.emit('candle', { tf, candle: { ...cur }, closed: false });
    }
  }

  _getSlotStart(tf, ts) {
    const mins = ts.getHours() * 60 + ts.getMinutes();
    const slot = Math.floor(mins / tf) * tf;
    const h = Math.floor(slot / 60);
    const m = slot % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  // Get closed candles for a timeframe
  getCandles(tf, count = 50) {
    return this.candles[tf].slice(-count);
  }

  // Get current forming candle
  getCurrent(tf) {
    return this.current[tf];
  }

  // Get all candles including current forming
  getAllCandles(tf, count = 50) {
    const closed = this.candles[tf].slice(-count);
    const cur = this.current[tf];
    return cur ? [...closed, cur] : closed;
  }

  // Reset at market open (9:15 AM)
  reset() {
    this.candles = { 3: [], 5: [], 15: [], 30: [] };
    this.current = { 3: null, 5: null, 15: null, 30: null };
    console.log('🕯️ Candle builder reset for new session');
  }
}

const candleBuilder = new CandleBuilder();
module.exports = candleBuilder;
module.exports.CandleBuilder = CandleBuilder;
