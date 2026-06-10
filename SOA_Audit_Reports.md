# SOA Trader — Full Repository Audit & Migration Blueprint
## Phase 1–2: Architecture Review, Performance Review, Issue Findings
### Prepared: 2026-06-09 | Scope: Complete codebase read

---

## 1. ARCHITECTURE REVIEW

### 1.1 Current Data Flow

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│  Angel One  │────▶│  MarketDataService  │────▶│  MultiOrchestrator   │
│   REST API  │     │  (singleton hybrid) │     │  (strategy/core/)    │
└─────────────┘     └─────────────────────┘     └──────────────────────┘
         │                    │                           │
         │  LTP 2s            │  Token mutex              │  Per-instrument
         │  Chain 5s          │  Rate limiter             │  engine map
         │  Master 45MB       │  403 backoff              │
         │                    │                           │
         ▼                    ▼                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         INSTRUMENT ENGINE (per ID)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │CandleBuilder│  │  Indicators │  │ MarketState │  │   OIEngine  │  │
│  │  (3/5/15/30)│  │EMA,BB,VWAP  │  │  (regime)   │  │ walls/PCR  │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│         │                │                │                │         │
│         └────────────────┴────────────────┴────────────────┘         │
│                                    │                                 │
│                                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              SIGNAL ENGINE (score-based)                     │    │
│  │  EMA(25) + VWAP(10) + RSI(10) + State(15) + OI(15+10+8)    │    │
│  │  + Regime(10) + ATR filter(−10)  →  BUY_CE / BUY_PE        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                    │                                 │
│                                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              TRADE MANAGER (per instrument)                  │    │
│  │  Entry → Target/SL → Trail(50% trigger, 40% trail) → Exit      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                    │                                 │
│                                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  WebSocket Broadcast  ←  externalBroadcast hook              │    │
│  │  TICK / SIGNAL / TRADE_OPEN / TRADE_CLOSED / ANALYSIS        │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SQLite (better-sqlite3)  ←  5s async write queue                   │
│  signals | trades | daily_performance | metrics | feed_health       │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  public/index.html  (57KB single-file PWA)                            │
│  Tabs: HOME | MARKET | CALC | RULES                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Module Dependency Map

```
server.js
├── config.js
├── logger.js
├── database.js
├── health.js
├── strategy/core/multiOrchestrator.js
│   ├── strategy/core/marketDataService.js  ←── Angel One hardcoded
│   ├── strategy/core/instrumentEngine.js
│   │   ├── candleBuilder.js
│   │   ├── indicators.js
│   │   ├── marketStateEngine.js
│   │   ├── oiEngine.js
│   │   ├── signalEngine.js
│   │   ├── tradeManager.js
│   │   ├── abortEngine.js
│   │   ├── dataFreshness.js
│   │   ├── greeksCalculator.js
│   │   ├── signalCalibrator.js
│   │   ├── earlyEntryDetector.js
│   │   ├── regimeDetector.js
│   │   └── utils/expiryCalculator.js
│   └── strategy/dna/instrumentProfiles.js
├── strategy/stockScanner.js  ←── uses MarketDataService internals
├── .env.example
└── public/
    ├── index.html
    ├── manifest.json
    └── sw.js

# PARALLEL / DEAD CODE (not used by server.js)
strategy/multiInstrumentManager.js   ←── FULL DUPLICATE of core/ pipeline
strategy/SERVER_ADDITIONS.js         ←── references old orchestrator.js
strategy/FRONTEND_ADDITIONS.html     ←── snippets for manual merge
```

### 1.3 Key Architectural Decisions (Current)

| Decision | Assessment |
|----------|------------|
| **Singleton exports** | Most modules export `new Class()` AND `Class`. This creates confusion and state leakage risk. |
| **Per-instrument isolation** | `InstrumentEngine` creates fresh instances of all sub-engines. **Correct.** No shared state between NIFTY and BANKNIFTY. |
| **Async write queue for SQLite** | `database.js` batches writes every 5s. **Correct** for better-sqlite3 (sync). |
| **Candle time as "HH:MM" string** | `_getSlotStart` returns string slot without date. Mitigated by day-reset, but fragile. |
| **Two polling intervals** | LTP every 2s, chain every 5s. Reasonable for REST polling. |
| **No WebSocket data feed** | Uses REST polling only. No SmartAPI WebSocket feed. Adds ~200-500ms latency vs WebSocket. |
| **Instrument master from public URL** | Downloads 45MB JSON from `margincalculator.angelbroking.com`. Cached 12h. |

---

## 2. PERFORMANCE REVIEW

### 2.1 Bottlenecks Ranked

| Rank | Severity | Issue | Location | Impact |
|------|----------|-------|----------|--------|
| 1 | **CRITICAL** | **Sequential option-chain batch requests** | `marketDataService.fetchOptionChain` | Each instrument blocks 1-3s every 5s. With 5 instruments, serial execution = 5-15s total. |
| 2 | **CRITICAL** | **No concurrent instrument polling isolation** | `multiOrchestrator.addInstrument` | `startPolling` sets intervals per instrument, but all hit the same `MarketDataService` singleton with shared rate limiter. One slow instrument stalls others. |
| 3 | **HIGH** | **45MB instrument master parsed synchronously** | `marketDataService._doFetchMaster` | `JSON.parse` on 45MB blocks event loop for 200-500ms. |
| 4 | **HIGH** | **Signal evaluation runs on every analysis tick (5s) with no early-exit** | `instrumentEngine._runAnalysis` | Even when no new candle has formed, full indicator + OI + signal pipeline runs. |
| 5 | **HIGH** | **WebSocket broadcast on every TICK (2s × N instruments)** | `multiOrchestrator.engine.onTick` | Unconditionally broadcasts LTP to all WS clients every 2s. Frontend gets flooded. |
| 6 | **MEDIUM** | **SQLite write queue flush every 5s regardless of load** | `database.js flushQueue` | Under high signal load, 5s delay means stale dashboard data. |
| 7 | **MEDIUM** | **VWAP recalculated from scratch every tick** | `VWAPCalculator.update` | Cumulative algorithm is O(1), but called every 2s tick. Acceptable. |
| 8 | **MEDIUM** | **No connection pooling for Axios** | `marketDataService` | Default axios config creates new TCP connections. |
| 9 | **LOW** | **Logger sync file writes** | `logger.js` | Winston File transports are async, but Console is sync. High tick volume may cause backpressure. |
| 10 | **LOW** | **Frontend receives full chain snapshot every 5s** | `broadcast('ANALYSIS')` | `getSnapshot()` includes full signal history array. Grows unbounded during day. |

### 2.2 Event Loop Blocking Analysis

```
Event Loop Blockers (estimated ms on typical VPS):
├── JSON.parse(45MB master) ............ 250-500 ms  (once per 12h, but at startup)
├── SQLite batch flush (100 rows) ...... 5-20 ms     (every 5s)
├── Indicator calc (50 candles) ........ 1-3 ms     (every 5s per instrument)
├── OI analysis (20 strikes) ........... 0.5-2 ms   (every 5s per instrument)
├── Axios POST + TLS handshake ......... 150-400 ms (every 2s per instrument)
└── Axios POST option chain (50 tok) ... 300-800 ms (every 5s per instrument)
```

**Conclusion**: With 5 instruments, the REST polling pattern alone consumes ~30-50% of event loop time. Redis caching will eliminate the repeated Axios blocking.

---

## 3. SIGNAL ENGINE FINDINGS

### 3.1 Root Cause: Duplicate / Stale Signals

**Finding 1: No signal deduplication key**
- `signalEngine.js` generates `id: SIG_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
- No check against "same type, same strike, within N minutes"
- If market conditions persist (e.g., strong trend), a new signal fires after 5min cooldown
- **Fix**: Add composite key: `${instrument}:${type}:${atmStrike}:${hourSlot}`

**Finding 2: `signals` array grows unbounded**
- `this.signals.push(signal)` — never purged except on day reset
- `getSignals()` returns full array in every WebSocket broadcast
- Memory leak over long-running sessions
- **Fix**: Keep only last 24h or last N signals

**Finding 3: Score threshold asymmetry**
- `BUY_CE` requires `score >= 40`
- `BUY_PE` requires `score <= -40`
- But OI contributions are symmetric: `+15` for CE, `-15` for PE
- However, `ceBuyConfirmed` uses `pcrBias` which is contrarian (high PCR = bullish)
- This is intentional contrarian logic, but the naming is confusing

**Finding 4: Missing signal lifecycle state machine**
- Signals are either OPEN or have outcome WIN/LOSS
- No `ACTIVE` state tracking whether a trade was actually opened
- Database stores `status` but signal engine doesn't track it
- **Fix**: Implement NEW → ACTIVE → CLOSED → ARCHIVED lifecycle

**Finding 5: Cooldown uses `timestamp` from analysis, not signal time**
- `timestamp - this.lastSignalTime < this.cooldownMs`
- If `timestamp` is passed as `Date.now()` from `_runAnalysis`, this is fine
- But if derived from LTP response timestamp, clock skew could bypass cooldown

**Finding 6: Trade manager opens trade immediately on signal without confirmation**
- `instrumentEngine._runAnalysis` calls `tradeManager.openTrade(signal, premium, ...)` immediately
- No order placement confirmation from broker
- If broker API fails, the trade is still tracked as "OPEN" in memory
- **Fix**: Separate signal generation from trade execution

### 3.2 OI Engine Issues

**Finding 7: Support/Resistance fallback is single strike, not cluster**
- `_buildWalls` returns `supportNearest: null, resistanceNearest: null`
- These are only populated later in `getAnalysis` via `_pickNearestWalls`
- But `support` and `resistance` in snapshot use `maxPEStrike` / `maxCEStrike` as fallback
- `maxPEStrike` is the single highest PE OI strike — not a wall/cluster
- **This is the "Support = Resistance issue"**: if max CE and max PE happen at same strike (pin), support and resistance both equal that strike

**Finding 8: `_pickNearestWalls` ignores distance threshold**
- It picks the nearest wall regardless of how far it is
- Then `nearResistance` / `nearSupport` check proximity with `thr = max(120, min(250, step*1.5))`
- But the wall itself could be 500 points away and still be called "nearest"
- **Fix**: Add max-distance filter to wall selection

**Finding 9: PCR bias logic is correct but fragile**
- `pcr = totalPEoi / totalCEoi` — standard Put/Call ratio
- `pcr > 1.2 → BULLISH` — contrarian interpretation (too many puts = bullish)
- This is valid for Indian markets, but should be documented

### 3.3 Market State Engine Issues

**Finding 10: State smoothing is too aggressive**
- `if (this.state !== state && this.confidence > 70)` requires 2 consecutive identical states
- This means a breakout detected on one candle won't register until the next candle confirms
- For 5m candles, that's a 5-10min delay in state change
- **Fix**: Reduce to 1 confirmation for high-confidence states, or weight by candle strength

**Finding 11: `breakoutUp` requires `lastCandle.high > prevHigh`**
- This is just a higher high, not a true breakout above resistance
- Should compare to `bb.upper` or recent swing high, not just previous candle

---

## 4. DHAN MIGRATION PLAN

### 4.1 Why Dhan

| Aspect | Angel One | Dhan |
|--------|-----------|------|
| Rate limits | 10 req/s (soft) | 25 req/s |
| Option chain API | Batch quotes only (50 tokens) | Dedicated `/option-chain` endpoint |
| Historical data | Limited | Full historical API |
| WebSocket | SmartAPI WebSocket (complex) | Live Feed API (simpler) |
| Auth | TOTP + JWT refresh every 30min | Access token (longer lived) |
| Instrument master | 45MB public JSON | Compact API endpoint |
| Reliability | Frequent 403s, stale tokens | Better reported uptime |

### 4.2 Broker Adapter Architecture

```
┌─────────────────────────────────────────┐
│           BrokerAdapter (interface)      │
│  ─────────────────────────────────────  │
│  authenticate() → { token, expiry }      │
│  getSpotLTP(instrument) → { ltp, ts }    │
│  getOptionChain(instrument, expiry)      │
│    → { strikes: [ { strike, CE, PE } ]} │
│  getQuotes(tokens[]) → [ { ltp, oi, vol }│
│  getHistorical(instrument, interval)     │
│    → [ { o,h,l,c,v } ]                  │
│  subscribeLiveFeed(tokens[], callback)   │
│  unsubscribeLiveFeed(tokens[])           │
│  getInstrumentMaster() → compact master  │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐       ┌───────────────┐
│  DhanAdapter  │       │ AngelAdapter  │
│  (new)        │       │ (legacy)      │
└───────────────┘       └───────────────┘
```

### 4.3 File Changes Required

| File | Action | Details |
|------|--------|---------|
| `broker/BrokerAdapter.js` | **CREATE** | Abstract base class with standard interface |
| `broker/DhanAdapter.js` | **CREATE** | Dhan API implementation |
| `broker/AngelAdapter.js` | **CREATE** | Extract current Angel logic from MarketDataService |
| `broker/index.js` | **CREATE** | Factory: `createBrokerAdapter(type, config)` |
| `strategy/core/marketDataService.js` | **REFACTOR** | Remove all Angel-specific code. Delegate to BrokerAdapter. Keep polling logic, caching, rate limiting. |
| `config.js` | **MODIFY** | Add `broker: { type: 'DHAN'|'ANGEL', ...credentials }` |
| `server.js` | **MODIFY** | Replace `authenticate()` with broker-agnostic `broker.auth()` |
| `strategy/dna/instrumentProfiles.js` | **MODIFY** | Add Dhan-specific token fields (if needed) |
| `build.js` | **MODIFY** | Use broker adapter to download master |
| `.env.example` | **MODIFY** | Add Dhan env vars |

### 4.4 Migration Sequence

```
Step 1: Create broker/ adapter layer (no change to existing logic)
Step 2: Refactor MarketDataService to use BrokerAdapter
Step 3: Implement AngelAdapter (extract existing code)
Step 4: Implement DhanAdapter with mock responses
Step 5: Run test suite against DhanAdapter
Step 6: Add Redis cache layer (see §5)
Step 7: Switch config to Dhan in dev environment
Step 8: Validate spot, ATM, OI, Greeks for all 4 instruments
Step 9: Deploy to production
```

---

## 5. REDIS DESIGN

### 5.1 Why Redis (not just memory)

| Problem | Memory-only | Redis |
|---------|-------------|-------|
| Server restart | All state lost | State persisted (with RDB) |
| Multi-process | Can't share | Shared across processes |
| Signal dedup | Per-instance only | Global dedup across restarts |
| Frontend stale data | Broadcasts everything | Client can fetch latest on reconnect |
| Memory pressure | Unbounded growth | TTL eviction |

### 5.2 Key Naming Convention

```
# Market Data
md:{instrument}:ltp              → { price, timestamp, source }
md:{instrument}:ohlc:{tf}        → sorted set (score=timestamp, member=json)
md:{instrument}:state            → { state, confidence, reasons, timestamp }

# Option Chain
oc:{instrument}:{expiry}         → hash { strike: json(CE+PE) }
oc:{instrument}:atm              → { strike, cePremium, pePremium, timestamp }
oc:{instrument}:oi:snapshot     → { pcr, support, resistance, timestamp }

# Signals
sig:{instrument}:{yyyy-mm-dd}    → list [json(signal)]
sig:active:{instrument}         → hash { signalId: json(activeSignal) }
sig:dedup:{instrument}:{type}:{hh} → string "1" (TTL 1h)

# Trades
trade:{instrument}:active        → json(activeTrade or null)
trade:{instrument}:{yyyy-mm-dd}  → list [json(closedTrade)]

# WebSocket / Broadcast
ws:lastbroadcast:{instrument}    → json(last message per type)
ws:client:{clientId}             → hash { instrumentFilters, lastPing }

# System
sys:health                       → json(health payload)
sys:broker:token                 → { token, expiry }
sys:instrument:{id}:master       → hash { token→symbol mapping }
```

### 5.3 TTL Strategy

| Key Pattern | TTL | Rationale |
|-------------|-----|-----------|
| `md:*:ltp` | 10s | Spot price stale after 10s |
| `md:*:ohlc:*` | 1h | Candle data valid for session |
| `oc:*` | 30s | Option chain updates every 5s, but cache for burst reads |
| `sig:*` | 24h | Signals persist full trading day |
| `sig:dedup:*` | 1h | Prevent same-hour duplicate |
| `trade:*` | 24h | Active trade must survive session |
| `sys:broker:token` | 25min | Dhan token expiry ~30min |
| `sys:instrument:*:master` | 12h | Master changes daily |

### 5.4 Invalidation Strategy

```
1. LTP cache: write-through on every tick, 10s TTL auto-expires
2. Option chain: write-through after successful fetch, 30s TTL
3. Signal dedup: explicit delete on signal close (or let TTL expire)
4. Broker token: refresh 5min before expiry, atomic SET with NX
5. Day reset: at 09:00 IST, FLUSHDB with prefix `md:*`, `oc:*`, `sig:*`, `trade:*`
```

### 5.5 Redis Integration Points

```
MarketDataService
├── fetchIndexLTP(instrument)
│   ├── GET md:{instrument}:ltp
│   ├── if miss || stale → broker.getSpotLTP()
│   └── SET md:{instrument}:ltp EX 10
│
├── fetchOptionChain(instrument, spot)
│   ├── GET oc:{instrument}:{expiry}
│   ├── if miss || stale → broker.getOptionChain()
│   └── SET oc:{instrument}:{expiry} EX 30
│
└── startPolling()
    └── Every tick: SET md:{instrument}:ltp
    └── Every chain: SET oc:{instrument}:{expiry}

SignalEngine
├── evaluate(ctx)
│   ├── GET sig:dedup:{instrument}:{type}:{hour}
│   ├── if exists → return null (duplicate)
│   └── if new signal → SET sig:dedup EX 3600 + LPUSH sig:{instrument}:{date}
│
└── onTradeOpen(signal)
    └── HSET sig:active:{instrument} {signalId} {json}

TradeManager
├── openTrade() → HSET trade:{instrument}:active
├── updateTrade() → HSET trade:{instrument}:active (update currentPremium)
└── closeTrade() → HDEL trade:{instrument}:active + LPUSH trade:{instrument}:{date}

WebSocket
├── on connection → MGET md:*:ltp, oc:*:atm, trade:*:active
└── broadcast → only if changed from ws:lastbroadcast:{instrument}
```

---

## 6. PRIORITIZED FIX LIST

### P0 — Critical (Deploy Blocker)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 1 | **Duplicate signal engine implementations** (`signalEngine.js` vs `multiInstrumentManager.js` inline) | Delete `multiInstrumentManager.js` and `SERVER_ADDITIONS.js`. Single source of truth: `strategy/core/` pipeline. | 2h |
| 2 | **PCR inversion bug in dead code** (`multiInstrumentManager.js`: `pcr = CE/PE`, `ceBuyConfirmed: pcr < 1`) | Delete dead code. Verify `oiEngine.js` PCR is `PE/CE` (standard). | 1h |
| 3 | **Support/Resistance both fall back to same strike at pin** | Fix `_buildWalls` to populate `supportNearest`/`resistanceNearest` before snapshot. Add distance threshold. | 3h |
| 4 | **Signal deduplication missing** | Add composite dedup key in Redis or memory. | 2h |
| 5 | **Angel One hardcoded throughout** | Create broker adapter layer. | 8h |

### P1 — High (Stability)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 6 | **Sequential option chain blocking** | Parallelize batch requests per instrument, or use Dhan single endpoint. | 4h |
| 7 | **45MB JSON.parse blocks event loop** | Stream parse, or use Dhan compact master, or worker thread. | 4h |
| 8 | **Signals array unbounded growth** | Ring buffer: keep last 50 signals per instrument. | 1h |
| 9 | **WebSocket floods frontend** | Throttle broadcasts: only send if value changed > 0.1% or 5s elapsed. | 2h |
| 10 | **No graceful instrument failure** | Wrap each instrument poll in try/catch; don't let one failure stop others. | 2h |
| 11 | **Trade opens without broker confirmation** | Separate signal from execution. Add `PENDING` state until broker ack. | 4h |

### P2 — Medium (Performance)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 12 | **Redis cache layer** | Implement all key patterns from §5. | 6h |
| 13 | **Axios connection pooling** | Create shared axios instance with `keepAlive`. | 1h |
| 14 | **Analysis runs even when no new candle** | Skip signal eval if 5m candle hasn't rolled. | 1h |
| 15 | **State smoothing too aggressive** | Reduce confirmation requirement for high-confidence breakouts. | 2h |
| 16 | **Database write queue 5s delay** | Reduce to 1s or flush on signal/trade events. | 1h |

### P3 — Low (Cleanup)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 17 | **Delete dead code** (`multiInstrumentManager.js`, `SERVER_ADDITIONS.js`, old orchestrator refs) | Delete and update imports. | 1h |
| 18 | **Candle slot string missing date** | Include date in slot key or ensure day-reset is bulletproof. | 1h |
| 19 | **RegimeDetector defensive import** | Simplify — it's a class, not singleton. | 0.5h |
| 20 | **StockScanner accesses private methods** | Refactor to use public BrokerAdapter methods. | 2h |

---

## 7. INSTRUMENT CERTIFICATION FRAMEWORK

### 7.1 Validation Tests (per instrument)

```javascript
const CERTIFICATION_TESTS = {
  'NIFTY': [
    'Spot data fetch → valid LTP within 2s',
    'ATM calculation → strike divisible by 50',
    'Option chain → 10 strikes each side, CE+PE present',
    'OI values → non-zero, increasing with moneyness',
    'Greeks → delta ~0.5 for ATM, theta negative',
    'Support/Resistance → distinct levels, not pinned',
    'Signal generation → bullish when EMA aligned + OI bullish',
    'Signal cooldown → no duplicate within 5min',
  ],
  'BANKNIFTY': [ /* same schema */ ],
  'SENSEX': [ /* same schema */ ],
  'BANKEX': [ /* same schema */ ],
};
```

### 7.2 Automated Cert Script

- Run before every deployment
- Fails build if any test fails
- Stores results in `sys:cert:{instrument}:{date}`

---

## 8. SUMMARY & RECOMMENDATION

### Current State Grade: C+
- **Architecture**: B (good separation, but dead code duplication)
- **Signal Logic**: B- (sound scoring, but dedup and lifecycle missing)
- **Data Pipeline**: C (Angel One dependency, blocking calls, no caching)
- **Performance**: C- (event loop blocking, WS flooding)
- **Reliability**: C (no graceful degradation, stale fallback only)

### Target State Grade: A-
- **Architecture**: A (clean broker adapter, single pipeline)
- **Signal Logic**: A- (dedup, lifecycle, calibration)
- **Data Pipeline**: A- (Dhan + Redis, WebSocket feed)
- **Performance**: B+ (cached, pooled, throttled)
- **Reliability**: A (instrument isolation, circuit breakers, cert tests)

### Implementation Order
1. **Week 1**: P0 fixes + broker adapter skeleton
2. **Week 2**: Dhan adapter + Redis cache
3. **Week 3**: Signal engine stabilization + cert framework
4. **Week 4**: Performance tuning + P2/P3 cleanup

---
*End of Audit Reports. Ready for implementation phase upon approval.*
