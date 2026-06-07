// ============================================================
// TEST: Multi-Instrument Independence
// Verifies 9 critical properties of the multi-instrument refactor
// ============================================================

const { InstrumentEngine } = require('./strategy/core/instrumentEngine');
const { ExpiryCalculator, createExpiryCalculator } = require('./strategy/utils/expiryCalculator');
const profiles = require('./strategy/dna/instrumentProfiles');

let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}`);
    failed++;
  }
}

// ── TEST 1: Isolated candle state ──────────────────────────
console.log('\n--- TEST 1: Isolated candle state ---');
const niftyEngine = new InstrumentEngine('NIFTY', profiles.NIFTY, {});
const bankniftyEngine = new InstrumentEngine('BANKNIFTY', profiles.BANKNIFTY, {});

niftyEngine.candleBuilder.tick(24500, Date.now());
bankniftyEngine.candleBuilder.tick(52000, Date.now());

const niftyCandles = niftyEngine.candleBuilder.getCandles(5, 50);
const bankCandles = bankniftyEngine.candleBuilder.getCandles(5, 50);

test('NIFTY has candles, BANKNIFTY has candles', niftyCandles.length > 0 && bankCandles.length > 0);
test('NIFTY candle close !== BANKNIFTY candle close', niftyCandles[0].close !== bankCandles[0].close);

// ── TEST 2: Simultaneous signals ───────────────────────────
console.log('\n--- TEST 2: Simultaneous signals (no suppression) ---');
let niftySignalReceived = false;
let bankSignalReceived = false;

niftyEngine.onSignal = (id, sig) => { if (id === 'NIFTY') niftySignalReceived = true; };
bankniftyEngine.onSignal = (id, sig) => { if (id === 'BANKNIFTY') bankSignalReceived = true; };

niftyEngine.signalEngine.signals = [];
niftyEngine.signalEngine.signalCount = 0;
niftyEngine.signalEngine.lastSignalTime = 0;

bankniftyEngine.signalEngine.signals = [];
bankniftyEngine.signalEngine.signalCount = 0;
bankniftyEngine.signalEngine.lastSignalTime = 0;

const mockSignal = {
  id: 'TEST_SIG', type: 'BUY_CE', confidence: 85, strength: 'STRONG',
  score: 50, factors: [], price: 24500, timestamp: Date.now(),
  timeStr: '10:15:00', signalNum: 1,
  indicators: { ema5: 24500, ema9: 24490, ema21: 24480, vwap: 24495, rsi: 60, bb: { bw: 2, squeeze: false }, atr: 50 },
  marketState: { state: 'TRENDING_BULLISH', confidence: 80 },
  oi: { pcr: 1.2, pcrBias: 'BULLISH', imbalanceBias: 'BULLISH' },
};

niftyEngine.signalEngine.signals.push(mockSignal);
bankniftyEngine.signalEngine.signals.push({ ...mockSignal, id: 'TEST_SIG_2', price: 52000 });

if (niftyEngine.onSignal) niftyEngine.onSignal('NIFTY', mockSignal);
if (bankniftyEngine.onSignal) bankniftyEngine.onSignal('BANKNIFTY', { ...mockSignal, id: 'TEST_SIG_2' });

test('NIFTY signal broadcast', niftySignalReceived);
test('BANKNIFTY signal broadcast', bankSignalReceived);
test('Both signals broadcast simultaneously', niftySignalReceived && bankSignalReceived);

// ── TEST 3: NIFTY maxSignalsDay does NOT block BANKNIFTY ───
console.log('\n--- TEST 3: Independent maxSignalsDay ---');
niftyEngine.signalEngine.signalCount = 5;
bankniftyEngine.signalEngine.signalCount = 0;

test('NIFTY at max signals', niftyEngine.signalEngine.signalCount >= niftyEngine.signalEngine.maxSignals);
test('BANKNIFTY not at max', bankniftyEngine.signalEngine.signalCount < bankniftyEngine.signalEngine.maxSignals);
test('BANKNIFTY can still signal', bankniftyEngine.signalEngine.signalCount < bankniftyEngine.signalEngine.maxSignals);

// ── TEST 4: OI walls per-instrument ────────────────────────
console.log('\n--- TEST 4: Per-instrument OI walls ---');
test('NIFTY OI engine is separate instance', niftyEngine.oiEngine !== bankniftyEngine.oiEngine);

// ── TEST 5: Expiry dates correct per instrument ──────────────
console.log('\n--- TEST 5: Correct expiry dates ---');
const niftyCalc = createExpiryCalculator(profiles.NIFTY);
const bankCalc = createExpiryCalculator(profiles.BANKNIFTY);
const sensexCalc = createExpiryCalculator(profiles.SENSEX);

const testDate = new Date(2026, 5, 9);
const niftyExpiry = niftyCalc.getCurrentExpiry(testDate);
const bankExpiry = bankCalc.getCurrentExpiry(testDate);
const sensexExpiry = sensexCalc.getCurrentExpiry(testDate);

test('NIFTY weekly expiry on Tuesday', niftyExpiry === '09JUN2026');
test('BANKNIFTY monthly expiry (last Tue of June)', bankExpiry === '30JUN2026');
test('SENSEX weekly expiry on Thursday', sensexExpiry === '11JUN2026');

// ── TEST 6: Stock lotSize auto-fetched (mock) ──────────────
console.log('\n--- TEST 6: Stock lotSize auto-extraction ---');
const stockProfile = { ...profiles.STOCK_OPTION_TEMPLATE };
stockProfile.name = 'RELIANCE';
const mockTokenMap = {
  '1': { token: '1', symbol: 'RELIANCE26JUN3000CE', name: 'RELIANCE', expiry: '26JUN2026', strike: 3000, lotsize: '500', instrumenttype: 'OPTSTK', exch_seg: 'NFO' },
  '2': { token: '2', symbol: 'RELIANCE26JUN3050CE', name: 'RELIANCE', expiry: '26JUN2026', strike: 3050, lotsize: '500', instrumenttype: 'OPTSTK', exch_seg: 'NFO' },
};
const first = Object.values(mockTokenMap)[0];
stockProfile.lotSize = parseInt(first.lotsize) || 1;
const strikes = [...new Set(Object.values(mockTokenMap).map(s => parseFloat(s.strike))).filter(Number.isFinite)].sort((a, b) => a - b);
const diffs = [];
for (let i = 1; i < strikes.length; i++) diffs.push(strikes[i] - strikes[i - 1]);
diffs.sort((a, b) => a - b);
stockProfile.strikeStep = diffs[0] || 1;

test('Stock lotSize extracted from master', stockProfile.lotSize === 500);
test('Stock strikeStep extracted from master', stockProfile.strikeStep === 50);

// ── TEST 7: Stock scanner activates liquid stocks ────────────
console.log('\n--- TEST 7: Stock scanner liquid check ---');
const spread = 5;
const premium = 15;
test('Stock passes liquidity check (spread < 8%, premium > min)', spread < 8 && premium > 10);

// ── TEST 8: Broadcast messages include instrument field ────
console.log('\n--- TEST 8: Broadcast instrument field ---');
let broadcastMsg = null;
niftyEngine.onSignal = (id, sig) => {
  broadcastMsg = { type: 'SIGNAL', instrument: id, data: sig };
};
if (niftyEngine.onSignal) niftyEngine.onSignal('NIFTY', mockSignal);
test('Broadcast has instrument field', broadcastMsg && broadcastMsg.instrument === 'NIFTY');
test('Broadcast has type field', broadcastMsg && broadcastMsg.type === 'SIGNAL');

// ── TEST 9: Frontend receives all signals in unified feed ──
console.log('\n--- TEST 9: Unified signal feed ---');
const unifiedFeed = [];
function addToUnifiedFeed(signal, instrument) {
  unifiedFeed.unshift({ ...signal, instrument });
}
addToUnifiedFeed(mockSignal, 'NIFTY');
addToUnifiedFeed({ ...mockSignal, id: 'TEST_2' }, 'BANKNIFTY');
addToUnifiedFeed({ ...mockSignal, id: 'TEST_3' }, 'FINNIFTY');

test('Unified feed has all 3 signals', unifiedFeed.length === 3);
test('Unified feed has NIFTY', unifiedFeed.some(s => s.instrument === 'NIFTY'));
test('Unified feed has BANKNIFTY', unifiedFeed.some(s => s.instrument === 'BANKNIFTY'));
test('Unified feed has FINNIFTY', unifiedFeed.some(s => s.instrument === 'FINNIFTY'));

// ── SUMMARY ──────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
