// ============================================================
// SIGNAL AUDIT FRAMEWORK — Comprehensive signal logging & reporting
// Every generated signal is recorded with full context for post-hoc analysis.
// Dependencies: database.js (SQLite), logger.js
// ============================================================

const logger = require('../logger');

class SignalAudit {
  constructor(db) {
    this.db = db;
    this._initSchema();
    this._pendingOutcomes = [];
    this._flushInterval = null;
    this._startFlushLoop();
  }

  _initSchema() {
    // signal_audit: captures signal at generation time
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

    // signal_outcomes: updated continuously as trade progresses
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

    // Indexes for fast reporting queries
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_instrument_date ON signal_audit(instrument, date)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON signal_audit(timestamp)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_outcome_status ON signal_outcomes(status)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_outcome_instrument ON signal_outcomes(instrument)`).run();
  }

  _startFlushLoop() {
    if (this._flushInterval) clearInterval(this._flushInterval);
    this._flushInterval = setInterval(() => this._flushOutcomes(), 5000);
  }

  stopFlushLoop() {
    if (this._flushInterval) {
      clearInterval(this._flushInterval);
      this._flushInterval = null;
    }
  }

  // ── LOG SIGNAL GENERATION ──────────────────────────────────
  logSignal(signal, instrumentId, context) {
    try {
      const auditId = `AUD_${instrumentId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const date = new Date().toISOString().split('T')[0];

      const record = {
        auditId,
        signalId: signal.id,
        instrument: instrumentId,
        date,
        timestamp: signal.timestamp || Date.now(),
        direction: signal.type,
        entryPrice: context.entryPrice || null,
        entryPremium: signal.entryPremium || null,
        atmStrike: signal.atmStrike || null,
        targetPts: signal.targetPts || null,
        slPts: signal.slPts || null,
        targetPremium: signal.targetPremium || null,
        slPremium: signal.slPremium || null,
        plannedRR: signal.plannedRR || null,
        score: signal.score || 0,
        confidence: signal.confidence || 0,
        strength: signal.strength || 'WEAK',
        factorsJson: JSON.stringify(context.factors || []),
        contextJson: JSON.stringify({
          indicators: context.indicators || {},
          marketState: context.marketState || {},
          oi: context.oi || {},
          regime: context.regime || {},
          abortFlags: context.abortFlags || [],
        }),
        executionJson: JSON.stringify({
          filled: false,
          fillTimestamp: null,
          fillPremium: null,
          slippage: null,
          lots: signal.lots || null,
          brokerOrderId: null,
        }),
        outcomeJson: JSON.stringify({
          status: 'OPEN',
          exitTimestamp: null,
          exitPrice: null,
          exitPremium: null,
          exitReason: null,
          pnl: null,
          durationMs: null,
          maxProfit: null,
          maxDrawdown: null,
          actualRR: null,
        }),
        performanceJson: JSON.stringify({
          qualityScore: null,
          timingScore: null,
          efficiency: null,
        }),
      };

      this.db.prepare(`
        INSERT INTO signal_audit (
          audit_id, signal_id, instrument, date, timestamp, direction,
          entry_price, entry_premium, atm_strike, target_pts, sl_pts,
          target_premium, sl_premium, planned_rr, score, confidence, strength,
          factors_json, context_json, execution_json, outcome_json, performance_json
        ) VALUES (
          @auditId, @signalId, @instrument, @date, @timestamp, @direction,
          @entryPrice, @entryPremium, @atmStrike, @targetPts, @slPts,
          @targetPremium, @slPremium, @plannedRR, @score, @confidence, @strength,
          @factorsJson, @contextJson, @executionJson, @outcomeJson, @performanceJson
        )
      `).run(record);

      logger.info(`[Audit] Signal logged: ${auditId} ${instrumentId} ${signal.type} score=${signal.score}`);
      return auditId;
    } catch (err) {
      logger.error(`[Audit] Failed to log signal: ${err.message}`);
      return null;
    }
  }

  // ── UPDATE EXECUTION (when broker fills order) ──────────────
  logExecution(auditId, execution) {
    try {
      const existing = this.db.prepare('SELECT execution_json FROM signal_audit WHERE audit_id = ?').get(auditId);
      if (!existing) return;

      const current = JSON.parse(existing.execution_json || '{}');
      const updated = { ...current, ...execution };

      this.db.prepare(`
        UPDATE signal_audit SET execution_json = ? WHERE audit_id = ?
      `).run(JSON.stringify(updated), auditId);

      logger.info(`[Audit] Execution logged: ${auditId} filled=${execution.filled}`);
    } catch (err) {
      logger.error(`[Audit] Failed to log execution: ${err.message}`);
    }
  }

  // ── UPDATE OUTCOME (on trade close or periodic update) ────────
  updateOutcome(auditId, outcome) {
    this._pendingOutcomes.push({ auditId, outcome, timestamp: Date.now() });
    // Immediate flush for terminal states
    if (outcome.status && ['WIN', 'LOSS', 'EXPIRED', 'CANCELLED'].includes(outcome.status)) {
      this._flushOutcomes();
    }
  }

  _flushOutcomes() {
    if (this._pendingOutcomes.length === 0) return;
    const batch = this._pendingOutcomes.splice(0, this._pendingOutcomes.length);

    const updateStmt = this.db.prepare(`
      INSERT INTO signal_outcomes (
        audit_id, signal_id, instrument, status, exit_timestamp, exit_price,
        exit_premium, exit_reason, pnl, duration_ms, max_profit, max_drawdown, actual_rr
      ) VALUES (
        @auditId, @signalId, @instrument, @status, @exitTimestamp, @exitPrice,
        @exitPremium, @exitReason, @pnl, @durationMs, @maxProfit, @maxDrawdown, @actualRR
      )
      ON CONFLICT(audit_id) DO UPDATE SET
        status = excluded.status,
        exit_timestamp = COALESCE(excluded.exit_timestamp, signal_outcomes.exit_timestamp),
        exit_price = COALESCE(excluded.exit_price, signal_outcomes.exit_price),
        exit_premium = COALESCE(excluded.exit_premium, signal_outcomes.exit_premium),
        exit_reason = COALESCE(excluded.exit_reason, signal_outcomes.exit_reason),
        pnl = COALESCE(excluded.pnl, signal_outcomes.pnl),
        duration_ms = COALESCE(excluded.duration_ms, signal_outcomes.duration_ms),
        max_profit = COALESCE(excluded.max_profit, signal_outcomes.max_profit),
        max_drawdown = COALESCE(excluded.max_drawdown, signal_outcomes.max_drawdown),
        actual_rr = COALESCE(excluded.actual_rr, signal_outcomes.actual_rr),
        updated_at = strftime('%s','now') * 1000
    `);

    const updateAuditStmt = this.db.prepare(`
      UPDATE signal_audit SET outcome_json = ? WHERE audit_id = ?
    `);

    for (const { auditId, outcome } of batch) {
      try {
        // Get signal_id from audit record
        const audit = this.db.prepare('SELECT signal_id, instrument, outcome_json FROM signal_audit WHERE audit_id = ?').get(auditId);
        if (!audit) continue;

        const currentOutcome = JSON.parse(audit.outcome_json || '{}');
        const merged = { ...currentOutcome, ...outcome };

        updateStmt.run({
          auditId,
          signalId: audit.signal_id,
          instrument: audit.instrument,
          status: merged.status || 'OPEN',
          exitTimestamp: merged.exitTimestamp || null,
          exitPrice: merged.exitPrice || null,
          exitPremium: merged.exitPremium || null,
          exitReason: merged.exitReason || null,
          pnl: merged.pnl !== undefined ? merged.pnl : null,
          durationMs: merged.durationMs || null,
          maxProfit: merged.maxProfit !== undefined ? merged.maxProfit : null,
          maxDrawdown: merged.maxDrawdown !== undefined ? merged.maxDrawdown : null,
          actualRR: merged.actualRR !== undefined ? merged.actualRR : null,
        });

        updateAuditStmt.run(JSON.stringify(merged), auditId);
      } catch (err) {
        logger.error(`[Audit] Failed to flush outcome for ${auditId}: ${err.message}`);
      }
    }
  }

  // ── REPORTING API ────────────────────────────────────────────
  getPerformanceReport(options = {}) {
    const { instrument, date, days = 7 } = options;
    const dateFilter = date 
      ? `date = '${date}'` 
      : `date >= date('now', '-${days} days')`;
    const instrumentFilter = instrument ? `AND instrument = '${instrument}'` : '';

    // Win rate
    const winRate = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN o.status = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN o.status = 'LOSS' THEN 1 ELSE 0 END) as losses
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter}
    `).get();

    // Profit factor
    const profitFactor = this.db.prepare(`
      SELECT 
        SUM(CASE WHEN o.pnl > 0 THEN o.pnl ELSE 0 END) as gross_profit,
        ABS(SUM(CASE WHEN o.pnl < 0 THEN o.pnl ELSE 0 END)) as gross_loss
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter} AND o.status IN ('WIN', 'LOSS')
    `).get();

    // Expectancy
    const expectancy = this.db.prepare(`
      SELECT AVG(o.pnl) as avg_pnl, 
             AVG(CASE WHEN o.status = 'WIN' THEN o.pnl END) as avg_win,
             AVG(CASE WHEN o.status = 'LOSS' THEN o.pnl END) as avg_loss
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter} AND o.status IN ('WIN', 'LOSS')
    `).get();

    // R/R analysis
    const rrAnalysis = this.db.prepare(`
      SELECT AVG(a.planned_rr) as avg_planned_rr,
             AVG(o.actual_rr) as avg_actual_rr
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter} AND o.status IN ('WIN', 'LOSS')
    `).get();

    // By time of day
    const byTime = this.db.prepare(`
      SELECT 
        strftime('%H', a.timestamp / 1000, 'unixepoch') as hour,
        COUNT(*) as total,
        SUM(CASE WHEN o.status = 'WIN' THEN 1 ELSE 0 END) as wins
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter}
      GROUP BY hour
      ORDER BY hour
    `).all();

    // By market state
    const byState = this.db.prepare(`
      SELECT 
        json_extract(a.context_json, '$.marketState.state') as state,
        COUNT(*) as total,
        SUM(CASE WHEN o.status = 'WIN' THEN 1 ELSE 0 END) as wins
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter}
      GROUP BY state
    `).all();

    // By strength
    const byStrength = this.db.prepare(`
      SELECT 
        a.strength,
        COUNT(*) as total,
        SUM(CASE WHEN o.status = 'WIN' THEN 1 ELSE 0 END) as wins
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE ${dateFilter} ${instrumentFilter}
      GROUP BY a.strength
    `).all();

    // Drawdown
    const drawdown = this.db.prepare(`
      SELECT MAX(consecutive_losses) as max_consecutive_losses
      FROM (
        SELECT COUNT(*) as consecutive_losses
        FROM (
          SELECT *,
            SUM(CASE WHEN o.status = 'LOSS' THEN 0 ELSE 1 END) 
              OVER (ORDER BY a.timestamp) as grp
          FROM signal_audit a
          LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
          WHERE ${dateFilter} ${instrumentFilter} AND o.status IN ('WIN', 'LOSS')
        )
        WHERE o.status = 'LOSS'
        GROUP BY grp
      )
    `).get();

    const total = winRate?.total || 0;
    const wins = winRate?.wins || 0;
    const losses = winRate?.losses || 0;
    const winRatePct = total > 0 ? (wins / total) : 0;
    const pf = profitFactor?.gross_loss > 0 
      ? (profitFactor.gross_profit / profitFactor.gross_loss) 
      : (profitFactor?.gross_profit > 0 ? Infinity : 0);
    const exp = (winRatePct * (expectancy?.avg_win || 0)) - ((1 - winRatePct) * Math.abs(expectancy?.avg_loss || 0));

    return {
      summary: {
        totalSignals: total,
        winRate: winRatePct,
        profitFactor: pf,
        expectancy: exp,
        avgPlannedRR: rrAnalysis?.avg_planned_rr || 0,
        avgActualRR: rrAnalysis?.avg_actual_rr || 0,
        maxConsecutiveLosses: drawdown?.max_consecutive_losses || 0,
      },
      byTimeOfDay: byTime || [],
      byMarketState: byState || [],
      byStrength: byStrength || [],
    };
  }

  getSignalDetails(auditId) {
    const audit = this.db.prepare('SELECT * FROM signal_audit WHERE audit_id = ?').get(auditId);
    if (!audit) return null;

    const outcome = this.db.prepare('SELECT * FROM signal_outcomes WHERE audit_id = ?').get(auditId);

    return {
      ...audit,
      factors: JSON.parse(audit.factors_json || '[]'),
      context: JSON.parse(audit.context_json || '{}'),
      execution: JSON.parse(audit.execution_json || '{}'),
      outcome: JSON.parse(audit.outcome_json || '{}'),
      performance: JSON.parse(audit.performance_json || '{}'),
      liveOutcome: outcome || null,
    };
  }

  getRecentSignals(instrument, limit = 50) {
    return this.db.prepare(`
      SELECT a.*, o.status as outcome_status, o.pnl
      FROM signal_audit a
      LEFT JOIN signal_outcomes o ON a.audit_id = o.audit_id
      WHERE a.instrument = ?
      ORDER BY a.timestamp DESC
      LIMIT ?
    `).all(instrument, limit);
  }
}

module.exports = { SignalAudit };
