// ============================================================
// SIGNAL CALIBRATOR — Phase 2B
// Lightweight historical calibration based on recent signal outcomes.
// Works even without DB access; accepts rows from database when available.
// ============================================================
class SignalCalibrator {
  constructor(config = {}) {
    this.minSamples = Number(config.minSamples ?? 20);
    this.maxBoost = Number(config.maxBoost ?? 8);
    this.maxPenalty = Number(config.maxPenalty ?? 10);
    this.cache = { updatedAt: 0, byType: {} };
  }

  build(rows = []) {
    const byType = {};
    for (const r of rows || []) {
      const type = r.type || r.signal_type;
      if (!type || !['BUY_CE', 'BUY_PE'].includes(type)) continue;

      byType[type] ||= { total: 0, wins: 0, pnl: 0 };
      byType[type].total += 1;

      const outcome = String(r.outcome || r.status || '').toUpperCase();
      const pnl = Number(r.pnl ?? 0);

      if (outcome.includes('WIN') || pnl > 0) byType[type].wins += 1;
      byType[type].pnl += Number.isFinite(pnl) ? pnl : 0;
    }

    this.cache = { updatedAt: Date.now(), byType };
    return this.cache;
  }

  getStats(type) {
    const stats = this.cache.byType?.[type];
    if (!stats) {
      return {
        type,
        sampleCount: 0,
        winRate: 0,
        avgPnl: 0
      };
    }

    const total = Number(stats.total || 0);
    const wins = Number(stats.wins || 0);
    const pnl = Number(stats.pnl || 0);

    return {
      type,
      sampleCount: total,
      winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
      avgPnl: total > 0 ? Number((pnl / total).toFixed(2)) : 0
    };
  }

  getSnapshot() {
    const result = {};
    for (const type of ['BUY_CE', 'BUY_PE']) {
      result[type] = this.getStats(type);
    }
    return {
      updatedAt: this.cache.updatedAt || 0,
      byType: result
    };
  }

  adjust(signal) {
    if (!signal) return signal;

    const rawConfidence = Number(signal.rawConfidence ?? signal.confidence ?? 0);
    const stats = this.cache.byType?.[signal.type];

    if (!stats || stats.total < this.minSamples) {
      return {
        ...signal,
        rawConfidence,
        calibration: {
          enabled: true,
          applied: false,
          reason: 'insufficient_samples',
          samples: stats?.total || 0
        }
      };
    }

    const winRate = stats.wins / stats.total;
    let adjustment = 0;

    if (winRate >= 0.60) {
      adjustment = Math.min(this.maxBoost, Math.round((winRate - 0.50) * 40));
    } else if (winRate <= 0.40) {
      adjustment = -Math.min(this.maxPenalty, Math.round((0.50 - winRate) * 40));
    }

    const confidence = Math.max(0, Math.min(100, rawConfidence + adjustment));

    return {
      ...signal,
      rawConfidence,
      confidence,
      calibration: {
        enabled: true,
        applied: adjustment !== 0,
        adjustment,
        samples: stats.total,
        winRate: Number((winRate * 100).toFixed(2)),
        avgPnl: Number((stats.pnl / stats.total).toFixed(2))
      },
      factors: adjustment
        ? [...(signal.factors || []), { name: 'Historical Calibration', score: adjustment }]
        : (signal.factors || [])
    };
  }
}

module.exports = SignalCalibrator;
module.exports.instance = new SignalCalibrator();
