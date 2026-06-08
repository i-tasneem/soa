// ============================================================
// DATABASE — SQLite Setup & Schema
// Phase 1: server timestamps, session query, feed health
// FIX: Async write queue to prevent event-loop blocking under
// multi-instrument load. Batches writes every 5 seconds.
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'soa-trader.db');
console.log('📦 Using DB at:', dbPath);
let db;
try { db = new Database(dbPath); db.pragma('journal_mode = WAL'); logger.info('✅ Database connected', { path: dbPath }); }
catch (err) { logger.error('❌ Database connection failed', { error: err.message }); throw err; }

function columnExists(table, column) { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column); }
function addColumnIfMissing(table, column, definition) { try { if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch (err) { logger.warn?.(`Could not add ${table}.${column}`, { error: err.message }); } }
function getTodayIST() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toISOString().split('T')[0]; }

function initializeTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, date DATE, type TEXT NOT NULL, confidence INTEGER, entry_price REAL, entry_premium REAL, target_premium REAL, sl_premium REAL, vwap REAL, ema5 REAL, ema9 REAL, ema15 REAL, factors TEXT, outcome TEXT, pnl REAL, status TEXT DEFAULT 'OPEN', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(date);
    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, signal_id TEXT, open_time DATETIME DEFAULT CURRENT_TIMESTAMP, close_time DATETIME, entry_sensex_price REAL, exit_sensex_price REAL, entry_premium REAL, exit_premium REAL, type TEXT, status TEXT DEFAULT 'OPEN', pnl REAL, pnl_percentage REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (signal_id) REFERENCES signals(id));
    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(open_time);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_signal ON trades(signal_id);
    CREATE TABLE IF NOT EXISTS daily_performance (date DATE PRIMARY KEY, total_signals INTEGER DEFAULT 0, total_trades INTEGER DEFAULT 0, winning_trades INTEGER DEFAULT 0, losing_trades INTEGER DEFAULT 0, win_rate REAL, total_pnl REAL DEFAULT 0, avg_pnl REAL, max_win REAL, max_loss REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS monthly_performance (month TEXT PRIMARY KEY, total_signals INTEGER DEFAULT 0, total_trades INTEGER DEFAULT 0, winning_trades INTEGER DEFAULT 0, losing_trades INTEGER DEFAULT 0, win_rate REAL, total_pnl REAL DEFAULT 0, avg_pnl REAL, max_drawdown REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS metrics (timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, metric_type TEXT, metric_name TEXT, value REAL, metadata TEXT);
    CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(metric_type);
    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
    CREATE TABLE IF NOT EXISTS feed_health (timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, feed_name TEXT, age_ms INTEGER, is_stale BOOLEAN, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_feed_health_timestamp ON feed_health(timestamp);
    CREATE INDEX IF NOT EXISTS idx_feed_health_name ON feed_health(feed_name);
  `);

  db.exec(`
  CREATE TABLE IF NOT EXISTS setup_escalations (
    id TEXT PRIMARY KEY,
    setup_id TEXT,
    escalated_to_signal_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  `);

  addColumnIfMissing('trades', 'is_early_entry', 'BOOLEAN DEFAULT FALSE');
  addColumnIfMissing('trades', 'early_entry_reason', 'TEXT');
  addColumnIfMissing('signals', 'strike_value', 'INTEGER');

  addColumnIfMissing('signals', 'server_timestamp', 'BIGINT');
  addColumnIfMissing('signals', 'session_id', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);`);
  logger.info('✅ Database tables initialized');
}

// ── ASYNC WRITE QUEUE ──────────────────────────────────────
// FIX: better-sqlite3 is synchronous. To prevent event-loop blocking
// under multi-instrument load, we batch writes and flush every 5s.
const writeQueue = [];
let flushTimer = null;

function enqueue(sql, params) {
  writeQueue.push({ sql, params });
  if (!flushTimer) {
    flushTimer = setTimeout(flushQueue, 5000);
  }
}

function flushQueue() {
  flushTimer = null;
  if (writeQueue.length === 0) return;
  const batch = writeQueue.splice(0, writeQueue.length);
  const start = process.hrtime.bigint();
  try {
    const insert = db.transaction((items) => {
      for (const { sql, params } of items) {
        db.prepare(sql).run(...params);
      }
    });
    insert(batch);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsed > 50) {
      logger.warn(`DB batch flush took ${elapsed.toFixed(1)}ms for ${batch.length} ops`);
    }
  } catch (err) {
    logger.error('❌ DB batch flush failed', { error: err.message, batchSize: batch.length });
  }
}

function logSignal(signalData, serverTime = Date.now(), sessionId = null) {
  enqueue(
    `INSERT OR REPLACE INTO signals (id, timestamp, server_timestamp, session_id, date, type, confidence, entry_price, entry_premium, target_premium, sl_premium, vwap, ema5, ema9, ema15, factors, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalData.id || `SIG_${Date.now()}`,
      Number(serverTime) || Date.now(),
      Number(serverTime) || Date.now(),
      sessionId || signalData.sessionId || null,
      getTodayIST(),
      signalData.type,
      signalData.confidence,
      signalData.price,
      signalData.entryPremium,
      signalData.target,
      signalData.sl,
      signalData.vwap?.vwap ?? signalData.vwap ?? null,
      signalData.ema5,
      signalData.ema9,
      signalData.ema15,
      JSON.stringify(signalData.factors || []),
      signalData.tradeStatus || 'OPEN'
    ]
  );
}

function updateSignalOutcome(signalId, outcome, pnl) {
  enqueue(
    `UPDATE signals SET outcome = ?, pnl = ?, status = ? WHERE id = ?`,
    [outcome, pnl, outcome === 'WIN' ? 'CLOSED_WIN' : 'CLOSED_LOSS', signalId]
  );
}

function logTrade(tradeData) {
  enqueue(
    `INSERT INTO trades (id, signal_id, entry_sensex_price, entry_premium, type, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [tradeData.id || `TRADE_${Date.now()}`, tradeData.signalId, tradeData.entrySensexPrice, tradeData.entryPremium, tradeData.type, 'OPEN']
  );
}

function closeTrade(tradeId, exitPrice, exitPremium, pnl) {
  enqueue(
    `UPDATE trades SET exit_sensex_price = ?, exit_premium = ?, pnl = ?, pnl_percentage = (? / entry_premium) * 100, status = ?, close_time = CURRENT_TIMESTAMP WHERE id = ?`,
    [exitPrice, exitPremium, pnl, pnl, pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS', tradeId]
  );
}

function getDailyStats(date) {
  try {
    return db.prepare(`SELECT COUNT(*) as total_signals, SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as winning_signals, SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losing_signals, SUM(pnl) as total_pnl, AVG(pnl) as avg_pnl, MAX(pnl) as max_win, MIN(pnl) as max_loss FROM signals WHERE date = ?`).get(date);
  } catch (err) { logger.error('❌ Failed to get daily stats', { error: err.message }); return null; }
}

function getMonthlyStats(month) {
  try {
    return db.prepare(`SELECT COUNT(*) as total_signals, SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as winning_signals, SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losing_signals, SUM(pnl) as total_pnl, AVG(pnl) as avg_pnl FROM signals WHERE strftime('%Y-%m', date) = ?`).get(month);
  } catch (err) { logger.error('❌ Failed to get monthly stats', { error: err.message }); return null; }
}

function getRecentSignals(limit = 10) {
  try {
    return db.prepare(`SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?`).all(limit);
  } catch (err) { logger.error('❌ Failed to get recent signals', { error: err.message }); return []; }
}

function getCalibrationSignals(limit = 200) {
  try {
    return db.prepare(`
      SELECT id, timestamp, date, type, confidence, outcome, pnl, status
      FROM signals
      WHERE type IN ('BUY_CE', 'BUY_PE')
        AND (outcome IS NOT NULL OR pnl IS NOT NULL OR status IN ('CLOSED_WIN', 'CLOSED_LOSS'))
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);
  } catch (err) {
    logger.error('❌ Failed to get calibration signals', { error: err.message });
    return [];
  }
}

function getSignalsByDate(date, limit = 100) {
  try {
    return db.prepare(`SELECT * FROM signals WHERE date = ? ORDER BY timestamp DESC LIMIT ?`).all(date, limit);
  } catch (err) { logger.error('❌ Failed to get signals by date', { error: err.message, date }); return []; }
}

function getSignalsAfterTimestamp(timestamp, limit = 100) {
  try {
    const ts = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
    return db.prepare(`SELECT * FROM signals WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`).all(ts, limit);
  } catch (err) { logger.error('❌ Failed to get signals after timestamp', { error: err.message }); return []; }
}

function getWinRate(days = 30) {
  try {
    const result = db.prepare(`SELECT SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins, COUNT(*) as total FROM signals WHERE date >= date('now', ? || ' days')`).get(-days);
    return result.total ? parseFloat(((result.wins / result.total) * 100).toFixed(2)) : 0;
  } catch (err) { logger.error('❌ Failed to calculate win rate', { error: err.message }); return 0; }
}

function logMetric(metricType, metricName, value, metadata = null) {
  enqueue(
    `INSERT INTO metrics (metric_type, metric_name, value, metadata) VALUES (?, ?, ?, ?)`,
    [metricType, metricName, value, metadata ? JSON.stringify(metadata) : null]
  );
}

function logFeedHealth(feedName, ageMs, isStale) {
  enqueue(
    `INSERT INTO feed_health (feed_name, age_ms, is_stale) VALUES (?, ?, ?)`,
    [feedName, ageMs, isStale ? 1 : 0]
  );
}

module.exports = {
  db,
  initializeTables,
  logSignal,
  updateSignalOutcome,
  logTrade,
  closeTrade,
  getDailyStats,
  getMonthlyStats,
  getRecentSignals,
  getCalibrationSignals,
  getSignalsByDate,
  getSignalsAfterTimestamp,
  getWinRate,
  logMetric,
  logFeedHealth,
  // Expose flush for graceful shutdown
  _flushQueue: flushQueue,
};
