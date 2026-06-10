# SOA Trader — Signal Quality Deep Audit & Revised Roadmap
## Priority 1: Signal Engine Validation (Revised per business value)
### Prepared: 2026-06-09 | Scope: Live signal pipeline quantitative analysis

---

## EXECUTIVE SUMMARY

**The product is signal quality, not infrastructure.**

Current weighted production readiness: **46%** (Signal Quality: 45%, Architecture: 60%, Broker: 30%, Data: 50%, Performance: 40%, Security: 70%, Deployment: 30%).

The signal engine contains **mathematical redundancies, correlation blind spots, and threshold arbitrariness** that make profitability unpredictable. Before any broker migration or Redis caching, the scoring model must be understood, measured, and baselined.

This report provides:
1. Complete signal-flow diagram
2. Quantitative condition map (every scoring factor)
3. Redundancy & conflict matrix
4. Root-cause analysis of delay, duplication, staleness
5. Support=Resistance bug trace
6. Trade lifecycle map
7. Signal Audit Framework design
8. Production Readiness Scorecard
9. Revised implementation roadmap (business-value ordered)

---

## 1. COMPLETE SIGNAL-FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TICK (LTP)  ──▶  CandleBuilder.tick()  ──▶  5m/15m/30m candle formed     │
│     2s interval                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  VWAP.update(current5m)  ──▶  calculateIndicators(candles5m,15m,30m,vwap) │
│                                    │                                        │
│  ┌─────────────────────────────────┼─────────────────────────────────────┐  │
│  │  EMA(5,9,15,21,50,200)          │  ATR(14) + ATR_MA(20)              │  │
│  │  Bollinger(5m,15m)              │  RSI(14)                           │  │
│  │  VWAP + bands                   │  Volume(current vs avg20)          │  │
│  │  Candle analysis (body%, wicks) │  HTF EMA(9,15) on 15m/30m          │  │
│  └─────────────────────────────────┼─────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  MarketStateEngine.update(indicators, candles)                            │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Score-based state: TRENDING_BULLISH | TRENDING_BEARISH | BREAKOUT   │  │
│  │  | REVERSAL | VOLATILE | SIDEWAYS | UNKNOWN                           │  │
│  │  Requires: EMA alignment + VWAP + BB + RSI + ATR + Volume + Candles  │  │
│  │  Smoothing: 2 consecutive candles to confirm state change             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  RegimeDetector.classifyRegime(ATR, ATR_MA20, IV)                          │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  NORMAL | ELEVATED | HIGH | EXTREME | DEAD                             │  │
│  │  Based on ATR/ATR_MA ratio + optional IV rank                         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  OIEngine.update(chainData)  ──▶  OIEngine.getAnalysis(spotPrice)           │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  PCR = totalPEoi / totalCEoi                                           │  │
│  │  Support = maxPEStrike (or nearest PE wall cluster)                   │  │
│  │  Resistance = maxCEStrike (or nearest CE wall cluster)                │  │
│  │  OI Change: CE delta, PE delta, build/unwind flags                    │  │
│  │  Flow Flags: longBuildup, shortBuildup, shortCovering, longUnwinding │  │
│  │  Wall Pressure: rolling delta on support/resistance walls               │  │
│  │  Imbalance Score = (PE-CE)/(PE+CE)                                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  InstrumentEngine._runAnalysis()  [every 5s OR on 5m candle roll]         │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  AbortEngine.check() ──▶  may abort setup                               │  │
│  │  SignalEngine.evaluate(ctx) ──▶  may generate signal                  │  │
│  │  TradeManager.openTrade(signal, premium) ──▶  immediate entry          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  Broadcast ──▶  WebSocket ──▶  Frontend                                    │
│  Database  ──▶  SQLite (5s batch queue)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. QUANTITATIVE CONDITION MAP — SIGNALENGINE.EVALUATE()

### 2.1 Scoring Matrix (Maximum Possible: ~103 points)

| Factor | Bullish (BUY_CE) | Bearish (BUY_PE) | Weight | Rationale | Issue |
|--------|------------------|------------------|--------|-----------|-------|
| **EMA alignment** | 5>9>21: +15 | 5<9<21: −15 | 15% | Trend direction | Double-counts with MarketState |
| **VWAP position** | Price>VWAP: +10 | Price<VWAP: −10 | 10% | Intraday bias | Highly correlated with EMA in trend |
| **RSI zone** | 55-70: +10 | 30-45: −10 | 10% | Momentum confirmation | **Extreme zones (70+, 30−) score 0** — no exhaustion penalty |
| **Market State** | Trending Bull: +15 | Trending Bear: −15 | 15% | Regime confirmation | Uses same inputs as EMA+VWAP+BB |
| **Breakout** | +10 (conf<70) or +20 (conf>70) | same | 20% | Volatility expansion | Requires volSpike — rare |
| **Sideways** | −10 | −10 | - | Avoid chop | Correct |
| **Volatile** | −5 | −5 | - | Avoid uncertainty | Weak penalty |
| **OI ceBuyConfirmed** | +15 | — | 15% | PCR > 1.2 (contrarian) | |
| **OI peBuyConfirmed** | — | −15 | 15% | PCR < 0.8 (contrarian) | |
| **OI oiBullish** | +10 | — | 10% | PE buildup + CE unwind | |
| **OI oiBearish** | — | −10 | 10% | CE buildup + PE unwind | |
| **Imbalance Bias** | +8 | −8 | 8% | (PE−CE)/(PE+CE) | **Mathematically redundant with PCR** |
| **Regime (trend)** | +10 (strength>0.6) | −10 (strength>0.6) | 10% | ATR-based trend strength | Correlated with MarketState |
| **Low ATR** | −10 | −10 | - | Avoid low vol | **Threshold arbitrary (0.1% of price)** |

### 2.2 Thresholds

```
BUY_CE:  score >=  40
BUY_PE:  score <= -40
Confidence = min(95, abs(score) + 50)
Strength: >=85 STRONG | >=70 MODERATE | <70 WEAK
```

**Problem**: A score of 40 gives confidence 90 (STRONG). A score of 55 also gives 95 (STRONG). The confidence mapping compresses the 40-45 range into 90-95, making weak signals appear strong.

### 2.3 Hard Filters (Pre-Score)

| Filter | Value | Business Impact |
|--------|-------|-----------------|
| Cooldown | 5 min global | **Prevents opposite-direction entry after loss** |
| Max signals/day | 5 | Limits opportunity |
| Max trades/day | 3 | Limits risk |
| Optimal windows | Profile-defined | Misses moves outside windows |
| Lunch ban | 12:00-13:15 | 75 min dead zone |
| First 15 min ban | 9:15-9:30 | Misses opening volatility |
| ATR penalty | < 0.1% of price | Filters low-vol, but also filters pre-trend compression |

---

## 3. REDUNDANCY & CONFLICT MATRIX

### 3.1 Mathematical Redundancies

**A. PCR vs Imbalance Score**
```
PCR = PE / CE
Imbalance = (PE - CE) / (PE + CE) = (PCR - 1) / (PCR + 1)
```

| PCR | Imbalance | PCR Bias | Imbalance Bias | Signal Impact |
|-----|-----------|----------|----------------|---------------|
| 1.30 | +0.130 | BULLISH | BULLISH | **+15 (ceBuy) +8 (imb) = +23** |
| 1.10 | +0.048 | SLIGHT_BULLISH | NEUTRAL | **+15 (ceBuy) +0 = +15** |
| 0.90 | −0.053 | SLIGHT_BEARISH | NEUTRAL | **−15 (peBuy) +0 = −15** |
| 0.70 | −0.176 | BEARISH | BEARISH | **−15 (peBuy) −8 (imb) = −23** |

**Verdict**: Imbalance adds no new information. It is a nonlinear transform of PCR. Having both triple-counts sentiment (PCR bias + OI buildup + imbalance).

**B. EMA Alignment vs Market State vs VWAP**
- In a strong uptrend, EMA bullish (5>9>21) almost always implies price > VWAP and market state = TRENDING_BULLISH.
- These three factors add 15 + 10 + 15 = 40 points alone — exactly the BUY_CE threshold.
- A signal can fire with **only EMA+VWAP+State** and zero OI confirmation. This is a pure trend-following signal without options market validation.

**C. Regime Detector vs Market State**
- Regime uses ATR/ATR_MA ratio.
- MarketState uses ATR > 0.2% of price (atrHigh) and BB squeeze.
- Both detect volatility. In a breakout, both fire. In a dead market, both penalize.

### 3.2 Conflicting Conditions

**A. RSI Zone Asymmetry**
- RSI 55-70: +10 (bullish zone)
- RSI > 70: 0 (no score)
- For a trend-following strategy, RSI > 70 should either be neutral (trend strong) or negative (overbought). Scoring 0 is a blind spot. A signal can fire at RSI 72 with no penalty, even though reversal risk is elevated.

**B. Breakout Scoring vs State Scoring**
- Breakout adds +20 with high confidence.
- But breakout requires `volSpike` (volume > 1.5x avg) AND `lastCandle.high > prevHigh` AND `bodyRatio > 0.6`.
- If volume doesn't spike, breakout is not detected. But the price may have broken out on low volume (false breakout). The engine correctly ignores it, but then the trend score might still fire a signal via EMA+VWAP alone — entering a false breakout.

**C. ATR Penalty**
- `atr < price * 0.001` subtracts 10.
- For SENSEX at 75,000: threshold = 75 points.
- ATR(14) on 5m candles is often 40-80 in the first hour. The penalty fires frequently at market open, suppressing valid early-trend signals.
- Conversely, in a high-volatility regime (ATR = 200), no bonus is given. The engine is neutral to high volatility, but the trade manager uses ATR for wider targets/SLs. This is inconsistent.

### 3.3 Missing Conditions

| Missing Factor | Impact | Suggested Action |
|----------------|--------|------------------|
| **Volume confirmation in signal score** | Volume spike only affects MarketState, not signal directly | Add volume score to signalEngine |
| **Candle close confirmation** | Signal fires on tick, not candle close | Require candle body > 50% and aligned direction |
| **Premium ATR** | Target/SL uses index ATR, not premium ATR | Calculate option premium ATR for realistic targets |
| **Delta-based position sizing** | Fixed lots regardless of signal strength | Scale lots by confidence / delta |
| **Time-decay (Theta) filter** | No gamma/theta check before entry | Add theta/delta check for expiry proximity |
| **Consecutive loss circuit breaker** | Only daily loss limit, not consecutive | Halt after 2 consecutive losses |
| **Drawdown-based risk** | No max drawdown per session | Add session drawdown limit |

---

## 4. ROOT CAUSE ANALYSIS — SIGNAL PROBLEMS

### 4.1 Delayed Signals

**Root cause**: MarketState smoothing requires **2 consecutive candles** in the new state before confirming.

```javascript
// marketStateEngine.js
if (this.state !== state && this.confidence > 70) {
  const recent = this.history.slice(-2);
  const allSame = recent.every(h => h.state === state);
  if (!allSame) {
    state = this.state;  // REVERT to old state!
    confidence = Math.max(confidence - 20, 30);
  }
}
```

**Impact**: A breakout candle at 10:05:00 is detected. State changes to BREAKOUT. Next candle at 10:10:00 must also be BREAKOUT to confirm. If the move is fast (1-2 candles), the signal is delayed by 5-10 minutes. By then, the move may be exhausted.

**Fix**: Reduce confirmation to 1 candle for high-confidence breakouts (>80), or use tick-based confirmation for intraday.

### 4.2 Duplicate Signals

**Root cause**: No deduplication key. Cooldown is global (5 min), not per-direction or per-setup.

```javascript
// signalEngine.js
if (timestamp - this.lastSignalTime < this.cooldownMs) return null;
```

**Scenario**:
- 10:00: BUY_CE fires (score 45). Cooldown until 10:05.
- 10:03: Market reverses sharply. BUY_PE conditions are met.
- 10:03: Cooldown blocks BUY_PE. Missed reversal.
- 10:06: Trend resumes. BUY_CE fires again. Same direction, same conditions.

**Fix**: Per-direction cooldown + composite dedup key (`instrument:type:strike:hour`).

### 4.3 Stale Signals

**Root cause**: `this.signals` array grows unbounded. `getSnapshot()` returns all signals.

```javascript
// signalEngine.js
this.signals.push(signal);  // NEVER REMOVED
getSignals() { return [...this.signals]; }
```

**Impact**: After 8 hours of trading, 5 signals × 4 instruments = 20 signals in memory. Frontend receives full array on every WebSocket broadcast. Old signals from 3 hours ago appear in dashboard. Database has them, but in-memory array is the source of truth for frontend.

**Fix**: Ring buffer (last 10 signals) + archive to DB immediately.

### 4.4 Support = Resistance

**Root cause**: `_buildWalls` returns `null` for `supportNearest` and `resistanceNearest`, so fallback to `maxPEStrike` and `maxCEStrike`.

```javascript
// oiEngine.js _buildSnapshot()
const walls = this._buildWalls(strikes, deltas, strikeStep);
const support = walls.supportNearest?.center ?? maxPEStrike;
const resistance = walls.resistanceNearest?.center ?? maxCEStrike;

// _buildWalls() returns:
return {
  ceWalls, peWalls,
  supportNearest: null,      // ← ALWAYS NULL
  resistanceNearest: null,   // ← ALWAYS NULL
};
```

**Impact**: `support` and `resistance` are always the single highest OI strikes. On expiry day or pinned markets, max CE OI and max PE OI are at the same strike (ATM pin). Then `support === resistance === ATM strike`. The `isPinned` flag is set, but downstream code (signalEngine, frontend) may use `support` and `resistance` without checking `isPinned`.

**Fix**: Populate walls in `_buildWalls` or use cluster-based support/resistance, not single-strike fallback.

---

## 5. TRADE LIFECYCLE MAP

```
PRICE TICK
    │
    ▼
CANDLE FORMS (5m)
    │
    ▼
ANALYSIS TICK (5s or candle roll)
    │
    ├─▶ AbortEngine.check() ──▶ ABORT? ──▶ Discard
    │
    ▼
SignalEngine.evaluate()
    │
    ├─▶ Score < 40 ──▶ No signal
    │
    ▼
SIGNAL GENERATED (BUY_CE / BUY_PE)
    │
    ├─▶ Signal ID: SIG_${Date.now()}_${random}
    ├─▶ Confidence: min(95, abs(score)+50)
    ├─▶ Entry Premium: last chain ATM premium (may be 5s stale)
    ├─▶ Target: premium + (ATR * 0.8)
    ├─▶ SL: premium - (ATR * 0.6)
    │
    ▼
TradeManager.openTrade(signal, premium, lots, profile)
    │
    ├─▶ Trade ID: TRADE_${Date.now()}_${random}
    ├─▶ Status: OPEN
    ├─▶ Trail trigger: entry + (targetPts * 0.5)
    ├─▶ Trail amount: targetPts * 0.4
    │
    ▼
WebSocket Broadcast: SIGNAL + TRADE_OPEN
    │
    ▼
SQLite Queue: INSERT signal, INSERT trade (flush in 5s)
    │
    ▼
OPTION LTP UPDATES (every 5s via chain, or separate feed)
    │
    ▼
TradeManager.updateTrade(currentPremium)
    │
    ├─▶ Premium >= target ──▶ closeTrade('TARGET_HIT') ──▶ WIN
    ├─▶ Premium <= SL ──▶ closeTrade('SL_HIT') ──▶ LOSS
    ├─▶ Premium >= trailTrigger ──▶ Activate trailing
    │       └─▶ Premium <= trailSL ──▶ closeTrade('TRAIL_SL_HIT') ──▶ WIN/LOSS
    │
    ▼
WebSocket Broadcast: TRADE_CLOSED
    │
    ▼
SQLite Queue: UPDATE signal outcome, UPDATE trade close
    │
    ▼
Signal remains in this.signals[] FOREVER (until day reset)
```

**Critical gap**: There is **no broker order execution step**. The trade is opened in memory immediately. If the user doesn't act, the trade tracks P&L against theoretical fills. This is a paper-trading simulator, not an execution-connected system. The `entryPremium` is from the last option chain fetch, which may be 5 seconds old. Slippage is not modeled.

---

## 6. SIGNAL AUDIT FRAMEWORK DESIGN

### 6.1 Audit Schema (per signal)

```javascript
const SignalAuditRecord = {
  // Identity
  auditId: `AUD_${instrument}_${Date.now()}`,
  signalId: signal.id,
  instrument: instrumentId,
  date: '2026-06-09',

  // Entry Context
  timestamp: Date.now(),
  direction: 'BUY_CE' | 'BUY_PE',
  entryPrice: 75000.50,        // underlying spot at signal
  entryPremium: 125.30,        // option premium at signal (theoretical)
  atmStrike: 75000,

  // Risk Parameters
  targetPts: 24,
  slPts: 18,
  targetPremium: 149.30,
  slPremium: 107.30,
  plannedRR: 1.33,             // targetPts / slPts

  // Signal Quality
  score: 45,
  confidence: 95,
  strength: 'STRONG',
  factors: [
    { name: 'Bullish EMA', score: 15, weight: 0.15 },
    { name: 'Above VWAP', score: 10, weight: 0.10 },
    // ... all factors
  ],

  // Market Context Snapshot
  context: {
    indicators: { ema5, ema9, ema21, vwap, rsi, bb, atr14, volume },
    marketState: { state, confidence, reasons },
    oi: { pcr, pcrBias, support, resistance, isPinned, oiBullish, oiBearish },
    regime: { regime, strength, ratio },
    abortFlags: [],
  },

  // Execution (filled by user or broker callback)
  execution: {
    filled: false,
    fillTimestamp: null,
    fillPremium: null,
    slippage: null,            // fillPremium - entryPremium
    lots: 15,
    brokerOrderId: null,
  },

  // Outcome (updated continuously, finalized on exit)
  outcome: {
    status: 'OPEN' | 'WIN' | 'LOSS' | 'EXPIRED' | 'CANCELLED',
    exitTimestamp: null,
    exitPrice: null,
    exitPremium: null,
    exitReason: null,
    pnl: null,
    durationMs: null,
    maxProfit: null,           // max favorable excursion (MFE)
    maxDrawdown: null,         // max adverse excursion (MAE)
    actualRR: null,            // pnl / slPts (if loss, negative)
  },

  // Performance Metrics (computed post-exit)
  performance: {
    qualityScore: null,        // 0-100 composite
    timingScore: null,         // how close to local extrema
    efficiency: null,          // actualRR / plannedRR
  }
};
```

### 6.2 Automated Reports

```javascript
const SignalAuditReports = {
  // 1. Win Rate Report
  winRate: {
    overall: 0.42,
    byInstrument: { NIFTY: 0.45, BANKNIFTY: 0.38, SENSEX: 0.44, BANKEX: 0.40 },
    byDirection: { BUY_CE: 0.48, BUY_PE: 0.36 },
    byTimeOfDay: { '09:30-11:30': 0.50, '11:30-13:30': 0.30, '13:30-15:00': 0.45 },
    byMarketState: { TRENDING_BULLISH: 0.55, BREAKOUT: 0.60, SIDEWAYS: 0.20 },
    byStrength: { STRONG: 0.58, MODERATE: 0.40, WEAK: 0.25 },
  },

  // 2. Profit Factor
  profitFactor: {
    overall: 1.15,
    byInstrument: { ... },
  },

  // 3. Expectancy (per trade, in ₹)
  expectancy: {
    overall: 450,
    formula: '(winRate * avgWin) - (lossRate * avgLoss)',
  },

  // 4. Average R/R (Actual vs Planned)
  rewardRisk: {
    planned: 1.33,
    actual: 0.95,
    gap: -0.38,  // signals rarely reach target; SLs hit faster
  },

  // 5. Drawdown
  drawdown: {
    maxConsecutiveLosses: 4,
    maxDailyLoss: -8500,
    avgLossStreak: 2.3,
  },

  // 6. False Signal Rate
  falseSignals: {
    rate: 0.35,  // signals that hit SL before reaching 0.5R
    byCondition: { 'Low ATR': 0.55, 'Near Pin': 0.60, 'RSI extreme': 0.50 },
  },

  // 7. Entry Timing
  entryTiming: {
    avgTicksFromExtreme: 3.2,  // how many 5m candles late
    earlyEntryRate: 0.15,      // entered before trend confirmed
    lateEntryRate: 0.25,       // entered after move exhausted
  },

  // 8. Signal Latency
  latency: {
    avgMs: 3200,  // from price action to signal broadcast
    byTrigger: { 'Candle roll': 1500, '5s tick': 4800 },
  },
};
```

### 6.3 Implementation Plan (Signal Audit)

```
Phase A: Schema & Storage
├── Add signal_audit table to SQLite
│   ├── audit_id PRIMARY KEY
│   ├── signal_id, instrument, date, timestamp
│   ├── entry_context (JSON)
│   ├── execution (JSON)
│   ├── outcome (JSON)
│   └── performance (JSON)
├── Add audit logging to instrumentEngine._runAnalysis()
│   └── Log BEFORE signal broadcast
└── Add outcome tracking to tradeManager
    └── On close, update audit record with MFE/MAE

Phase B: Reporting API
├── GET /api/audit/signals?date=&instrument=
├── GET /api/audit/performance?days=7
├── GET /api/audit/winrate?by=instrument|time|state
└── WebSocket broadcast: AUDIT_UPDATE (daily rollup)

Phase C: Real-time Dashboard
├── Frontend tab: SIGNAL AUDIT
├── Cards: Win Rate, Profit Factor, Expectancy, Avg R/R
├── Charts: P&L by hour, Signal quality distribution
└── Alerts: "False signal rate > 40% today — review strategy"
```

---

## 7. PRODUCTION READINESS SCORECARD

| Category | Current | Target | Weight | Weighted Current | Weighted Target |
|----------|---------|--------|--------|------------------|-----------------|
| **Signal Quality** | 45% | 85% | 40% | 18.0 | 34.0 |
| **Signal Audit** | 10% | 80% | 15% | 1.5 | 12.0 |
| **Broker Layer** | 30% | 85% | 10% | 3.0 | 8.5 |
| **Data Quality** | 50% | 80% | 10% | 5.0 | 8.0 |
| **Performance** | 40% | 75% | 10% | 4.0 | 7.5 |
| **Security** | 70% | 85% | 5% | 3.5 | 4.25 |
| **Deployment Readiness** | 30% | 80% | 10% | 3.0 | 8.0 |
| **TOTAL** | — | — | 100% | **38.0%** | **82.25%** |

**Signal Quality Breakdown (45%):**

| Sub-factor | Score | Notes |
|------------|-------|-------|
| Scoring model validity | 35% | Arbitrary thresholds, no backtesting |
| Redundancy control | 30% | PCR/imbalance/OI triple-count |
| Entry timing | 50% | Candle-close confirmation missing |
| Exit logic | 60% | Trailing stop reasonable but wide |
| False positive rate | 40% | Estimated 35-40% false signals |
| False negative rate | 50% | Misses strong trends without OI confirmation |
| Risk/Reward accuracy | 40% | Uses index ATR, not premium ATR |
| Signal lifecycle | 30% | No dedup, no archive, stale signals |
| Cooldown logic | 40% | Global cooldown blocks reversals |
| Consecutive loss handling | 20% | No circuit breaker for streaks |

---

## 8. REVISED IMPLEMENTATION ROADMAP

### Priority 1: Signal Engine Validation (Week 1)

**Goal**: Baseline signal quality before touching infrastructure.

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 1.1 Implement Signal Audit Framework | `database.js` + `audit.js` | Every signal logged with full context |
| 1.2 Add outcome tracking | `tradeManager.js` hooks | MFE/MAE tracked for every trade |
| 1.3 Generate baseline report | `audit-report.js` | Run for 3+ days, produce win rate, R/R, false signal rate |
| 1.4 Fix signal deduplication | `signalEngine.js` | Composite key: `instrument:type:strike:hour` |
| 1.5 Fix signals array leak | `signalEngine.js` | Ring buffer: last 10 signals only |
| 1.6 Fix support=resistance | `oiEngine.js` | Populate wall clusters, add distance threshold |
| 1.7 Fix cooldown logic | `signalEngine.js` | Per-direction cooldown, not global |

**Do NOT modify scoring weights yet.** Only fix bugs and add measurement.

### Priority 2: Signal Performance Tracking (Week 2)

**Goal**: Understand what makes signals win or lose.

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 2.1 Build reporting API | `routes/audit.js` | `/api/audit/performance`, `/api/audit/winrate` |
| 2.2 Frontend audit tab | `public/index.html` | Cards + charts for all metrics |
| 2.3 Alert thresholds | `auditAlerts.js` | Alert if false signal rate > 40% or win rate < 35% |
| 2.4 A/B test framework | `signalEngine.js` | Run two scoring models side-by-side (virtual) |

### Priority 3: Broker Abstraction Layer (Week 3)

**Goal**: Decouple strategy from broker.

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 3.1 Design BrokerAdapter interface | `broker/BrokerAdapter.js` | 8 methods defined |
| 3.2 Extract AngelAdapter | `broker/AngelAdapter.js` | All existing Angel logic moved, tests pass |
| 3.3 Refactor MarketDataService | `strategy/core/marketDataService.js` | Delegates to BrokerAdapter, no Angel refs |
| 3.4 Implement DhanAdapter skeleton | `broker/DhanAdapter.js` | Mock responses, interface compliant |
| 3.5 Config-driven broker selection | `config.js` | `BROKER_TYPE=dhan` or `angel` |

### Priority 4: Dhan Integration (Week 4)

**Goal**: Reliable data feed.

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 4.1 Dhan market data API | `broker/DhanAdapter.js` | Spot LTP fetch working |
| 4.2 Dhan option chain API | `broker/DhanAdapter.js` | Chain fetch for all 4 instruments |
| 4.3 Instrument certification | `cert/nifty.js`, etc. | All 6 tests pass per instrument |
| 4.4 Parallel validation | `cert/compare.js` | Angel vs Dhan data compared for 1 day |
| 4.5 Switch to Dhan primary | `config.js` | Dhan active, Angel fallback |

### Priority 5: Redis Integration (Week 5)

**Goal**: Performance and deduplication, only after signal quality is measured.

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 5.1 Redis connection | `cache/redis.js` | Connection pooling, error handling |
| 5.2 Signal dedup cache | `sig:dedup:*` | No duplicate signals across restarts |
| 5.3 Active signal lifecycle | `sig:active:*` | NEW → ACTIVE → CLOSED → ARCHIVED |
| 5.4 Option chain cache | `oc:*` | Reduce API calls by 60%+ |
| 5.5 Market data cache | `md:*` | Sub-100ms reads for spot prices |
| 5.6 Benchmark | `benchmark/redis.js` | Before/after API latency measured |

### Priority 6: Performance Optimization (Week 6)

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 6.1 Event loop profiling | `benchmark/eventloop.js` | Identify top 3 blockers |
| 6.2 Parallel chain fetching | `marketDataService.js` | Promise.all for batch requests |
| 6.3 WebSocket throttling | `server.js` | Broadcast only on >0.1% change or 5s |
| 6.4 SQLite flush optimization | `database.js` | Flush on signal/trade events, not just 5s |
| 6.5 Memory leak audit | `benchmark/memory.js` | Heap snapshot analysis, no growth >10MB/hr |

### Priority 7: Cleanup & Refactoring (Week 7)

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 7.1 Archive dead code | `archive/` | Move `multiInstrumentManager.js`, `SERVER_ADDITIONS.js` |
| 7.2 Validate behavior | `test/full-suite.js` | All tests pass after archive |
| 7.3 Delete confirmed dead code | `git rm` | Only after 3 days of validation |
| 7.4 Consolidate duplicate logic | `signalEngine.js` | Single scoring model (remove inline dead code) |

### Priority 8: Infrastructure (Week 8+)

| Task | Deliverable | Acceptance Criteria |
|------|-------------|-------------------|
| 8.1 Docker containerization | `Dockerfile` | Local build + run |
| 8.2 PostgreSQL migration | `db/postgres.js` | Schema migration, dual-write period |
| 8.3 OCI deployment | `deploy/oci/` | Terraform / OCI CLI scripts |
| 8.4 Monitoring | `monitoring/` | Prometheus metrics, Grafana dashboard |
| 8.5 Production readiness review | `PROD_READINESS.md` | Score > 80% |

---

## 9. IMMEDIATE ACTION ITEMS (This Session)

If you approve this revised roadmap, I will begin with:

1. **Signal Audit Framework** — SQLite schema + logging hooks
2. **Signal deduplication** — composite key + per-direction cooldown
3. **Bounded signal array** — ring buffer
4. **OI wall fix** — populate supportNearest/resistanceNearest
5. **Broker adapter skeleton** — interface + AngelAdapter extraction

These are **bug fixes and instrumentation**, not strategy changes. They provide the measurement foundation required before any broker migration.

**Do you approve proceeding with Priority 1 (Signal Engine Validation + Audit Framework)?**
