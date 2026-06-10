// ============================================================
// DATABASE v7 — Signal Audit Schema Added
// Changes from v6:
// 1. signal_audit table (full signal context logging)
// 2. signal_outcomes table (trade outcome tracking)
// 3. Indexes for fast reporting queries
// 4. All existing tables preserved
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const logger = require('./logger');

class DatabaseManager {
  constructor(dbPath = path.join(process.cwd(), 'data', 'trading.db')) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.writeQueue = [];
    this.flushInterval = 5000;
    this._initSchema();
    this._startFlushLoop();
  }

  _initSchema() {
    // Existing tables (preserved)
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        target REAL NOT NULL,
        stopLoss REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT DEFAULT 'ACTIVE',
        outcome TEXT,
        pnl REAL,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument TEXT NOT NULL,
        signal_id INTEGER,
        entry REAL NOT NULL,
        exit REAL,
        pnl REAL,
        status TEXT DEFAULT 'OPEN',
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        total_trades INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        losing_trades INTEGER DEFAULT 0,
        total_pnl REAL DEFAULT 0,
        max_drawdown REAL DEFAULT 0,
        win_rate REAL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        instrument TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS feed_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        instrument TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        error TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    // NEW: Signal Audit Tables
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS signal_audit (
        audit_id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        date TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL,
        entry_premium REAL,
        atm_strike INTEGER,
        target_pts REAL,
        sl_pts REAL,
        target_premium REAL,
        sl_premium REAL,
        planned_rr REAL,
        score INTEGER,
        confidence INTEGER,
        strength TEXT,
        factors_json TEXT,
        context_json TEXT,
        execution_json TEXT,
        outcome_json TEXT,
        performance_json TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS signal_outcomes (
        audit_id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        status TEXT DEFAULT 'OPEN',
        exit_timestamp INTEGER,
        exit_price REAL,
        exit_premium REAL,
        exit_reason TEXT,
        pnl REAL,
        duration_ms INTEGER,
        max_profit REAL,
        max_drawdown REAL,
        actual_rr REAL,
        updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )
    `).run();

    // Indexes
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_instrument ON signals(instrument)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades(instrument)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_performance(date)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_metrics_instrument ON metrics(instrument)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_feed_health_timestamp ON feed_health(timestamp)`).run();

    // NEW: Audit indexes
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_instrument_date ON signal_audit(instrument, date)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON signal_audit(timestamp)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_outcome_status ON signal_outcomes(status)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_outcome_instrument ON signal_outcomes(instrument)`).run();

    logger.info('Database schema initialized with audit tables');
  }

  _startFlushLoop() {
    this.flushTimer = setInterval(() => this._flushQueue(), this.flushInterval);
  }

  _flushQueue() {
    if (this.writeQueue.length === 0) return;
    const batch = this.writeQueue.splice(0, this.writeQueue.length);
    const db = this.db;
    try {
      db.transaction(() => {
        for (const item of batch) {
          try {
            if (item.type === 'signal') {
              db.prepare(`
                INSERT INTO signals (instrument, type, direction, entry, target, stopLoss, timestamp, status)
                VALUES (@instrument, @type, @direction, @entry, @target, @stopLoss, @timestamp, @status)
              `).run(item.data);
            } else if (item.type === 'trade') {
              db.prepare(`
                INSERT INTO trades (instrument, signal_id, entry, exit, pnl, status, timestamp)
                VALUES (@instrument, @signal_id, @entry, @exit, @pnl, @status, @timestamp)
              `).run(item.data);
            } else if (item.type === 'metric') {
              db.prepare(`
                INSERT INTO metrics (timestamp, instrument, metric_type, value)
                VALUES (@timestamp, @instrument, @metric_type, @value)
              `).run(item.data);
            } else if (item.type === 'feed_health') {
              db.prepare(`
                INSERT INTO feed_health (timestamp, instrument, status, latency_ms, error)
                VALUES (@timestamp, @instrument, @status, @latency_ms, @error)
              `).run(item.data);
            }
          } catch (err) {
            logger.error(`Database write error: ${err.message}`);
          }
        }
      })();
      logger.info(`Flushed ${batch.length} database writes`);
    } catch (err) {
      logger.error(`Database flush error: ${err.message}`);
      this.writeQueue.unshift(...batch);
    }
  }

  queueWrite(type, data) {
    this.writeQueue.push({ type, data });
  }

  getSignals(instrument, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM signals WHERE instrument = ? ORDER BY timestamp DESC LIMIT ?
    `).all(instrument, limit);
  }

  getTrades(instrument, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM trades WHERE instrument = ? ORDER BY timestamp DESC LIMIT ?
    `).all(instrument, limit);
  }

  getDailyPerformance(date) {
    return this.db.prepare(`
      SELECT * FROM daily_performance WHERE date = ?
    `).get(date);
  }

  updateDailyPerformance(date, data) {
    const existing = this.getDailyPerformance(date);
    if (existing) {
      this.db.prepare(`
        UPDATE daily_performance SET
          total_trades = total_trades + @total_trades,
          winning_trades = winning_trades + @winning_trades,
          losing_trades = losing_trades + @losing_trades,
          total_pnl = total_pnl + @total_pnl,
          max_drawdown = CASE WHEN @max_drawdown < max_drawdown THEN @max_drawdown ELSE max_drawdown END,
          win_rate = CASE WHEN (total_trades + @total_trades) > 0 THEN (winning_trades + @winning_trades) * 100.0 / (total_trades + @total_trades) ELSE 0 END
        WHERE date = @date
      `).run({ ...data, date });
    } else {
      this.db.prepare(`
        INSERT INTO daily_performance (date, total_trades, winning_trades, losing_trades, total_pnl, max_drawdown, win_rate)
        VALUES (@date, @total_trades, @winning_trades, @losing_trades, @total_pnl, @max_drawdown, @win_rate)
      `).run({ ...data, date });
    }
  }

  getMetrics(instrument, metricType, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM metrics WHERE instrument = ? AND metric_type = ? ORDER BY timestamp DESC LIMIT ?
    `).all(instrument, metricType, limit);
  }

  getFeedHealth(instrument, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM feed_health WHERE instrument = ? ORDER BY timestamp DESC LIMIT ?
    `).all(instrument, limit);
  }

  close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this._flushQueue();
    }
    this.db.close();
  }
}

module.exports = new DatabaseManager();
