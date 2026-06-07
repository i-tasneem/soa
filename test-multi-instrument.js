// ============================================================
// TEST: Multi-Instrument Independence
// Standalone test — no Angel One API needed (mocked)
// Run: node test-multi-instrument.js
// ============================================================

const assert = require('assert');

// ── MOCKS ───────────────────────────────────────────────────

const MOCK_LTP_RESPONSE = {
  status: true,
  data: {
    fetched: [{ ltp: '23450.75', symbolToken: '99926000' }]
  }
};

const MOCK_CHAIN_RESPONSE = {
  status: true,
  data: {
    fetched: [
      { symbolToken: 'CE1', ltp: '380', oi: 50000, volume: 1000, bid: '379', ask: '381' },
      { symbolToken: 'PE1', ltp: '350', oi: 45000, volume: 900, bid: '349', ask: '351' },
    ]
  }
};

const axios = {
  post: async (url, body, config) => {
    if (url.includes('quote')) {
      if (body.mode === 'LTP') return { data: MOCK_LTP_RESPONSE };
      if (body.mode === 'FULL') return { data: MOCK_CHAIN_RESPONSE };
    }
    if (url.includes('login')) {
      return {
        data: {
          status: true,
          data: {
            jwtToken: 'mock-jwt',
            refreshToken: 'mock-refresh',
            feedToken: 'mock-feed',
          }
        }
      };
    }
    return { data: {} };
  },
  get: async (url, config) => {
    return {
      data: [
        // NIFTY options
        { token: 'CE1', symbol: 'NIFTY30JUN2623450CE', name: 'NIFTY', expiry: '30JUN2026', strike: '2345000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'PE1', symbol: 'NIFTY30JUN2623450PE', name: 'NIFTY', expiry: '30JUN2026', strike: '2345000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'CE2', symbol: 'NIFTY30JUN2623500CE', name: 'NIFTY', expiry: '30JUN2026', strike: '2350000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'PE2', symbol: 'NIFTY30JUN2623500PE', name: 'NIFTY', expiry: '30JUN2026', strike: '2350000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        // BANKNIFTY options
        { token: 'BCE1', symbol: 'BANKNIFTY30JUN2648900CE', name: 'BANKNIFTY', expiry: '30JUN2026', strike: '4890000.000000', lotsize: '15', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'BPE1', symbol: 'BANKNIFTY30JUN2648900PE', name: 'BANKNIFTY', expiry: '30JUN2026', strike: '4890000.000000', lotsize: '15', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        // SENSEX options
        { token: 'SCE1', symbol: 'SENSEX30JUN2676500CE', name: 'SENSEX', expiry: '30JUN2026', strike: '7650000.000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5.000000' },
        { token: 'SPE1', symbol: 'SENSEX30JUN2676500PE', name: 'SENSEX', expiry: '30JUN2026', strike: '7650000.000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5.000000' },
        // RELIANCE stock options
        { token: 'RCE1', symbol: 'RELIANCE30JUN262800CE', name: 'RELIANCE', expiry: '30JUN2026', strike: '280000.000000', lotsize: '250', instrumenttype: 'OPTSTK', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'RPE1', symbol: 'RELIANCE30JUN262800PE', name: 'RELIANCE', expiry: '30JUN2026', strike: '280000.000000', lotsize: '250', instrumenttype: 'OPTSTK', exch_seg: 'NFO', tick_size: '5.000000' },
      ]
    };
  }
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'axios') return axios;
  return originalRequire.apply(this, arguments);
};

// ── IMPORTS ────────────────────────────────────────────────

const { createExpiryCalculator } = require('./strategy/utils/expiryCalculator');
const profiles = require('./strategy/dna/instrumentProfiles');

// ── TESTS ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

// Test 1: ExpiryCalculator weekly
test('ExpiryCalculator: NIFTY weekly (Sat -> next Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 6)); // June 6, 2026 = Saturday
  assert.strictEqual(result, '09JUN2026');
});

test('ExpiryCalculator: NIFTY weekly (Tue -> same Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 9)); // June 9, 2026 = Tuesday
  assert.strictEqual(result, '09JUN2026');
});

test('ExpiryCalculator: NIFTY weekly (Wed -> next Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 10)); // June 10, 2026 = Wednesday
  assert.strictEqual(result, '16JUN2026');
});

test('ExpiryCalculator: BANKNIFTY monthly (Jun 15 -> last Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 15));
  assert.strictEqual(result, '30JUN2026');
});

test('ExpiryCalculator: BANKNIFTY monthly (Jun 30 -> next last Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 30));
  assert.strictEqual(result, '28JUL2026');
});

test('ExpiryCalculator: SENSEX weekly (Sat -> next Thu)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 4 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 6));
  assert.strictEqual(result, '11JUN2026');
});

test('ExpiryCalculator: BANKEX monthly (Jun 15 -> last Thu)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 4 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 15));
  assert.strictEqual(result, '25JUN2026');
});

test('ExpiryCalculator: Stock monthly (Jun 20 -> last Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 20));
  assert.strictEqual(result, '30JUN2026');
});

// Test 2: MarketDataService with profile injection
async function testMarketDataService() {
  const { MarketDataService } = require('./strategy/core/marketDataService');
  const mds = new MarketDataService({ baseUrl: 'https://mock.api', jwtToken: 'mock' });
  mds.authToken = 'mock';

  // Test with full profile
  await mds.loadInstrumentMaster('NIFTY', null, profiles.NIFTY);
  const niftyInst = mds.instruments.get('NIFTY');

  test('MarketDataService: NIFTY master loaded with profile', () => {
    assert(niftyInst && Object.keys(niftyInst.tokenMap).length > 0, 'NIFTY tokenMap empty');
  });

  test('MarketDataService: Strike normalized to rupees', () => {
    const token = Object.values(niftyInst.tokenMap)[0];
    assert(token.strike < 100000, `Strike not normalized: ${token.strike}`);
    assert.strictEqual(token.strike, 23450, `Expected 23450, got ${token.strike}`);
  });

  // Test BANKNIFTY
  await mds.loadInstrumentMaster('BANKNIFTY', null, profiles.BANKNIFTY);
  const bnInst = mds.instruments.get('BANKNIFTY');

  test('MarketDataService: BANKNIFTY master loaded with profile', () => {
    assert(bnInst && Object.keys(bnInst.tokenMap).length > 0, 'BANKNIFTY tokenMap empty');
  });

  // Test SENSEX
  await mds.loadInstrumentMaster('SENSEX', null, profiles.SENSEX);
  const sxInst = mds.instruments.get('SENSEX');

  test('MarketDataService: SENSEX master loaded with profile', () => {
    assert(sxInst && Object.keys(sxInst.tokenMap).length > 0, 'SENSEX tokenMap empty');
  });

  // Test stock
  const stockProfile = { ...profiles.STOCK_OPTION_TEMPLATE, name: 'RELIANCE' };
  await mds.loadInstrumentMaster('STOCK_RELIANCE', 'RELIANCE', stockProfile);
  const relInst = mds.instruments.get('STOCK_RELIANCE');

  test('MarketDataService: Stock lotSize auto-fetched', () => {
    assert.strictEqual(relInst.profile.lotSize, 250, `Expected lotSize 250, got ${relInst.profile.lotSize}`);
  });

  test('MarketDataService: Stock strikeStep auto-fetched', () => {
    assert(relInst.profile.strikeStep > 0, `Expected strikeStep > 0, got ${relInst.profile.strikeStep}`);
  });
}

// Test 3: InstrumentEngine independence
async function testInstrumentEngine() {
  const { InstrumentEngine } = require('./strategy/core/instrumentEngine');

  const niftyEngine = new InstrumentEngine('NIFTY', profiles.NIFTY);
  const bankniftyEngine = new InstrumentEngine('BANKNIFTY', profiles.BANKNIFTY);

  // Feed identical ticks to both — they must maintain independent candle state
  for (let i = 0; i < 10; i++) {
    niftyEngine.onTick(23450 + i, Date.now() + i * 1000);
    bankniftyEngine.onTick(48900 + i * 2, Date.now() + i * 1000);
  }

  test('InstrumentEngine: Independent candle state', () => {
    const niftyCandles = niftyEngine.candleBuilder.getCandles(5, 10);
    const bankCandles = bankniftyEngine.candleBuilder.getCandles(5, 10);
    assert(niftyCandles.length > 0, 'NIFTY has no candles');
    assert(bankCandles.length > 0, 'BANKNIFTY has no candles');
    assert(niftyCandles[0].close !== bankCandles[0].close, 'Candles shared state!');
  });

  test('InstrumentEngine: Independent signal counters', () => {
    niftyEngine.signalEngine.signalCount = 5; // Max out NIFTY
    bankniftyEngine.signalEngine.signalCount = 0;
    assert.strictEqual(bankniftyEngine.signalEngine.signalCount, 0, 'BANKNIFTY counter affected by NIFTY');
  });

  test('InstrumentEngine: VWAP updated from candles', () => {
    const vwap = niftyEngine.vwap.get ? niftyEngine.vwap.get() : null;
    assert(vwap && vwap.vwap !== null, 'VWAP is null — .update(candle) not called');
  });

  test('InstrumentEngine: RegimeDetector instantiated', () => {
    assert(typeof niftyEngine.regimeDetector.detect === 'function', 'regimeDetector.detect is not a function');
    const regime = niftyEngine.regimeDetector.detect([], { atr14: 10, atr14_MA20: 10 });
    assert(regime && regime.trend, 'RegimeDetector.detect returned invalid result');
  });
}

// Test 4: MultiOrchestrator broadcast
async function testMultiOrchestrator() {
  const MultiOrchestrator = require('./strategy/core/multiOrchestrator');
  // Reset singleton for test
  MultiOrchestrator.engines = new Map();
  MultiOrchestrator.marketData = new (require('./strategy/core/marketDataService').MarketDataService)({ baseUrl: 'https://mock.api' });
  MultiOrchestrator.marketData.authToken = 'mock';

  const broadcasts = [];
  MultiOrchestrator.externalBroadcast = (msg) => broadcasts.push(msg);

  MultiOrchestrator.addInstrument('NIFTY', profiles.NIFTY);
  MultiOrchestrator.addInstrument('BANKNIFTY', profiles.BANKNIFTY);

  // Wait for master load
  await new Promise(r => setTimeout(r, 500));

  test('MultiOrchestrator: Broadcast includes instrument field', () => {
    // Manually trigger a broadcast
    MultiOrchestrator.broadcast('TEST', 'NIFTY', { test: true });
    const msg = broadcasts.find(b => b.instrument === 'NIFTY');
    assert(msg, 'No broadcast with instrument=NIFTY');
    assert.strictEqual(msg.market, 'NSE', 'Market field missing or wrong');
  });

  test('MultiOrchestrator: setAuthToken proxy exists', () => {
    assert(typeof MultiOrchestrator.setAuthToken === 'function', 'setAuthToken method missing');
    // Should not throw
    MultiOrchestrator.setAuthToken('test-token');
    assert.strictEqual(MultiOrchestrator.marketData.authToken, 'test-token', 'Auth token not propagated');
  });
}

// Run all async tests
async function runAll() {
  await testMarketDataService();
  await testInstrumentEngine();
  await testMultiOrchestrator();

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
