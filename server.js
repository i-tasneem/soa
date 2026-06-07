// ============================================================
//  SOA TRADER — Local Server v2.2
//  Fixes: instrument loading from disk, 403 candle retry,
//         reduced log noise, health wiring, DB persistence
// ============================================================
require('dotenv').config();

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const axios     = require('axios');
const path      = require('path');
const fs        = require('fs');
const cors      = require('cors');
const { authenticator } = require('otplib');
const config       = require('./config');
// ── INSTRUMENT CONFIGURATION ─────────────────────────────────
const INSTRUMENT_CONFIG = {
  SENSEX:    { name:'SENSEX',    displayName:'Sensex',     exchange:'BSE', optExchange:'BFO', indexToken:'99919000', wsExchangeType:3, file:'instruments_sensex.json',    step:100 },
  NIFTY:     { name:'NIFTY',     displayName:'Nifty',      exchange:'NSE', optExchange:'NFO', indexToken:'99926000', wsExchangeType:1, file:'instruments_nifty.json',     step:50  },
  BANKNIFTY: { name:'BANKNIFTY', displayName:'Bank Nifty', exchange:'NSE', optExchange:'NFO', indexToken:'99926009', wsExchangeType:1, file:'instruments_banknifty.json', step:100 },
  FINNIFTY:  { name:'FINNIFTY',  displayName:'Fin Nifty',  exchange:'NSE', optExchange:'NFO', indexToken:'99926037', wsExchangeType:1, file:'instruments_finnifty.json',  step:50  },
  BANKEX:    { name:'BANKEX',    displayName:'Bankex',     exchange:'BSE', optExchange:'BFO', indexToken:'99919012', wsExchangeType:3, file:'instruments_bankex.json',    step:100 },
};

const ACTIVE_INSTRUMENT = (config.activeInstrument || 'SENSEX').toUpperCase();
const INST = INSTRUMENT_CONFIG[ACTIVE_INSTRUMENT] || INSTRUMENT_CONFIG.SENSEX;


const orchestrator = require('./strategy/orchestrator');
const { MultiInstrumentManager } = require('./strategy/multiInstrumentManager');
const database     = require('./database');
const health       = require('./health');
const logger       = require('./logger');
const oiEngine = require('./strategy/oiEngine');

// ── INIT DATABASE ────────────────────────────────────────────
database.initializeTables();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
// Control whether to log cache hits/misses
const DEBUG_EXPIRY_CACHE = false;  // Set to true to debug caching behavior
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let authToken       = null;
let feedToken       = null;
let angelWS         = null;
let isWSConnecting = false;
let clients         = new Set();
let lastSensex      = null;
let liveData        = { sensex: null, atmStrike: null };
let authRetries     = 0;
let tokenMap        = {};
let instrumentsLoading = false; // guard against concurrent loads
let lastRangeData   = null;
let lastOptionChain = null;
let lastCachedExpiry = null;
let lastExpiryCheckTime = 0;
const EXPIRY_CACHE_TTL = 60 * 1000;  // 1 minute in milliseconds
let lastExpiryResetDate = null;  // Track day boundaries

const BASE             = 'https://apiconnect.angelbroking.com';
const INSTRUMENTS_PATH = path.join(__dirname, 'data', INST.file);

// ── HEADERS ──────────────────────────────────────────────────
function getHeaders() {
  return {
    'Authorization':    `Bearer ${authToken}`,
    'X-PrivateKey':     config.angel.apiKey,
    'X-UserType':       'USER',
    'X-SourceID':       'WEB',
    'X-ClientLocalIP':  '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress':     '00:00:00:00:00:00',
    'Accept':           'application/json',
    'Content-Type':     'application/json',
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
}

// ── LOAD INSTRUMENTS ─────────────────────────────────────────
// Strategy:
//   1. Load from data/instruments.json (pre-built at build time) — fast & Railway-safe
//   2. Fall back to live network fetch if file missing
async function loadInstruments() {
  if (instrumentsLoading) return; // already in flight
  instrumentsLoading = true;
  try {
    await _doLoadInstruments();
  } finally {
    instrumentsLoading = false;
  }
}

async function _doLoadInstruments() {

  // ── Try local file first (Railway build pre-downloads this) ──
  if (fs.existsSync(INSTRUMENTS_PATH)) {
    try {
      console.log(`📋 Loading ${INST.displayName} instruments from local file...`);
      const data = JSON.parse(fs.readFileSync(INSTRUMENTS_PATH, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        tokenMap = {};
        data.forEach(i => { tokenMap[i.token] = i; });
        const expiries = [...new Set(data.map(i => i.expiry))].sort();
        console.log(`✅ Loaded ${data.length} ${INST.displayName} instruments from disk`);
        console.log(`📅 Available expiries: ${expiries.slice(0, 8).join(', ')}`);
        if (data[0]) console.log(`🔎 Sample: ${JSON.stringify({ token: data[0].token, symbol: data[0].symbol, expiry: data[0].expiry, strike: data[0].strike })}`);
        return; // success — no network call needed
      }
      console.warn('⚠️ Local instruments file empty or malformed, falling back to network');
    } catch (err) {
      console.error('⚠️ Failed to read local instruments file:', err.message);
    }
  } else {
    console.warn('⚠️ data/instruments.json not found — falling back to network fetch');
    console.warn('   Run "npm run build" locally or set Railway build command to "npm run build"');
  }

  // ── Fallback: fetch from network ────────────────────────────
  try {
    console.log(`📋 Fetching ${INST.displayName} instruments from network (may be slow on Railway)...`);
    const res = await axios.get(
      'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
      {
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':     'application/json',
        },
      }
    );

    if (!Array.isArray(res.data)) throw new Error('Unexpected response — not an array');

    const sensex = res.data.filter(i =>
      i.exch_seg === INST.optExchange && i.name === INST.name && i.instrumenttype === 'OPTIDX'
    );

    if (sensex.length === 0) throw new Error(`No ${INST.name} instruments in response`);

    tokenMap = {};
    sensex.forEach(i => { tokenMap[i.token] = i; });

    const expiries = [...new Set(sensex.map(i => i.expiry))].sort();
    console.log(`✅ Loaded ${sensex.length} ${INST.displayName} instruments from network`);
    console.log(`📅 Available expiries: ${expiries.slice(0, 8).join(', ')}`);

    // Cache to disk for next startup
    try {
      if (!fs.existsSync(path.dirname(INSTRUMENTS_PATH))) {
        fs.mkdirSync(path.dirname(INSTRUMENTS_PATH), { recursive: true });
      }
      fs.writeFileSync(INSTRUMENTS_PATH, JSON.stringify(sensex));
      console.log('💾 Cached instruments to disk for next startup');
    } catch (_) {}

  } catch (err) {
    const status = err.response?.status;
    const reason = status ? `HTTP ${status}` : 'network blocked or timeout';
    const msg    = err.message || String(err);
    console.error(`❌ Instrument load failed (${reason}): ${msg}`);
    console.error('   Fix: Run "npm run build" to pre-download instruments.json');
    console.log('🔄 Retrying instrument load in 15s...');
    setTimeout(loadInstruments, 15000);
  }
}

// ── HISTORICAL CANDLES ───────────────────────────────────────
async function fetchHistoricalCandles(interval, fromDate, toDate, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        `${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`,
        { exchange: INST.exchange, symboltoken: INST.indexToken, interval, fromdate: fromDate, todate: toDate },
        { headers: getHeaders(), timeout: 15000 }
      );
      if (res.data.status && res.data.data) {
        return res.data.data.map(c => ({
          time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0,
        }));
      }
      return [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 && attempt < retries) {
        // 403 often means token just refreshed — wait and retry
        console.warn(`⚠️ Candle fetch 403 for ${interval} (attempt ${attempt}/${retries}) — retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      console.error(`Historical candle error [${interval}]:`, err.message, status ? `(HTTP ${status})` : '');
      return [];
    }
  }
  return [];
}

// ── PRELOAD CANDLES ──────────────────────────────────────────
async function preloadCandles() {
  const ist  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const today = ist.toISOString().split('T')[0];

  const yesterday = new Date(ist);
  yesterday.setDate(yesterday.getDate() - 1);
  if (yesterday.getDay() === 0) yesterday.setDate(yesterday.getDate() - 2); // Sunday → Friday
  if (yesterday.getDay() === 6) yesterday.setDate(yesterday.getDate() - 1); // Saturday → Friday
  const prevDay = yesterday.toISOString().split('T')[0];

  console.log('📦 Preloading historical candles...');
  const fromDate = `${prevDay} 09:15`;
  const toDate   = `${today} ${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;

  const [c5m, c15m, c30m] = await Promise.all([
    fetchHistoricalCandles('FIVE_MINUTE',    fromDate, toDate),
    fetchHistoricalCandles('FIFTEEN_MINUTE', fromDate, toDate),
    fetchHistoricalCandles('THIRTY_MINUTE',  fromDate, toDate),
  ]);

  const candleBuilder = require('./strategy/candleBuilder');
  if (c5m.length)  candleBuilder.preload(c5m,  5);
  if (c15m.length) candleBuilder.preload(c15m, 15);
  if (c30m.length) candleBuilder.preload(c30m, 30);

  const prevDayCandles = c5m.filter(c => c.time.startsWith(prevDay));
  if (prevDayCandles.length > 0) {
    const prevClose = prevDayCandles[prevDayCandles.length - 1].close;
    const prevHigh  = Math.max(...prevDayCandles.map(c => c.high));
    const prevLow   = Math.min(...prevDayCandles.map(c => c.low));
    console.log(`📊 Prev day: Close=${prevClose} High=${prevHigh} Low=${prevLow}`);
    broadcast({ type: 'PREV_DAY', close: prevClose, high: prevHigh, low: prevLow, date: prevDay });
  }

  console.log(`✅ Preloaded: 5m=${c5m.length} 15m=${c15m.length} 30m=${c30m.length} candles`);
}

// ── AUTHENTICATE ─────────────────────────────────────────────
async function authenticate() {
  try {
    console.log('🔐 Authenticating with Angel One SmartAPI...');
    const totp = authenticator.generate(config.angel.totpSecret);
    const res = await axios.post(
      `${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
      { clientcode: config.angel.clientId, password: config.angel.password, totp },
      {
        headers: {
          'Content-Type': 'application/json', 'Accept': 'application/json',
          'X-UserType': 'USER', 'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': config.angel.apiKey,
        },
      }
    );
    if (res.data.status && res.data.data) {
      authToken   = res.data.data.jwtToken;
      feedToken   = res.data.data.feedToken;
      authRetries = 0;
      console.log('✅ Authentication successful!');
      broadcast({ type: 'AUTH_STATUS', status: 'connected', message: 'Angel One Live' });
      health.setServerState({ authToken });

      await preloadCandles();
      await loadInstruments();
      connectAngelWebSocket();
    } else {
      throw new Error(res.data.message || 'Auth failed');
    }
  } catch (err) {
    authRetries++;
    console.error(`❌ Auth error (attempt ${authRetries}):`, err.message);
    broadcast({ type: 'AUTH_STATUS', status: 'error', message: err.message });
    if (authRetries < 5) setTimeout(authenticate, 10000 * authRetries);
  }
}

// ── ORCHESTRATOR CALLBACKS ───────────────────────────────────
orchestrator.onSignal = (signal) => {
  const serverTime = Date.now();
  signal.serverTime = serverTime;
  broadcast({ type: 'SIGNAL', data: signal, serverTime });
  console.log(`🚨 Signal: ${signal.type} ${signal.confidence}%`);
  try { database.logSignal(signal, serverTime); } catch (_) {}
};

 orchestrator.onTradeOpen = (trade) => {
   broadcast({ type: 'TRADE_OPEN', data: trade });
   
broadcast({
    type: 'TRADE_STATUS',
    activeTrade: trade,
    canOpenNewSignal: false
  });

   try { database.logTrade({
     id: trade.id,
     signalId: trade.signalId,
     entrySensexPrice: trade.entryPrice,
     entryPremium: trade.entryPremium,
     type: trade.type
   }); } catch (_) {}
 };

orchestrator.onUpdate = (update) => {
  broadcast({ type: 'ANALYSIS', data: update });
};

orchestrator.onTradeClose = (trade) => {
  broadcast({ type: 'TRADE_CLOSED', data: trade });
  
broadcast({
    type: 'TRADE_STATUS',
    activeTrade: null,
    canOpenNewSignal: true
  });

  try {
    database.closeTrade(trade.id, trade.exitPrice, trade.exitPremium, trade.pnl);
    if (trade.signalId) {
      database.updateSignalOutcome(trade.signalId, trade.pnl >= 0 ? 'WIN' : 'LOSS', trade.pnl);
    }
  } catch (_) {}
};

// Day reset: wait 5s for token to stabilize before fetching candles

// ── MULTI-INSTRUMENT MODE ───────────────────────────────────
const MULTI_INSTRUMENTS = process.env.MULTI_INSTRUMENT
  ? process.env.MULTI_INSTRUMENT.split(',').map(s => s.trim().toUpperCase()).filter(s => INSTRUMENT_CONFIG[s])
  : null;

let manager = null;
let activeSessions = null;

if (MULTI_INSTRUMENTS && MULTI_INSTRUMENTS.length > 1) {
  console.log(`🔀 Multi-instrument mode: ${MULTI_INSTRUMENTS.join(', ')}`);
  manager = new MultiInstrumentManager(MULTI_INSTRUMENTS);
  activeSessions = manager.getAllSessions();

  // Wire callbacks for all sessions
  for (const session of activeSessions) {
    session.onSignal = (signal) => {
      const serverTime = Date.now();
      signal.serverTime = serverTime;
      broadcast({ type: 'SIGNAL', data: signal, instrument: signal.instrument, serverTime });
      console.log(`🚨 [${signal.instrument}] Signal: ${signal.type} ${signal.confidence}%`);
    };
    session.onTradeOpen = (trade) => {
      broadcast({ type: 'TRADE_OPEN', data: trade, instrument: trade.instrument });
      broadcast({ type: 'TRADE_STATUS', activeTrade: trade, canOpenNewSignal: false, instrument: trade.instrument });
    };
    session.onTradeClose = (trade) => {
      broadcast({ type: 'TRADE_CLOSED', data: trade, instrument: trade.instrument });
      broadcast({ type: 'TRADE_STATUS', activeTrade: null, canOpenNewSignal: true, instrument: trade.instrument });
    };
    session.onUpdate = (update) => {
      broadcast({ type: 'ANALYSIS', data: update, instrument: update.instrument });
    };
    session.onSetupAbort = (abort) => {
      broadcast({ type: 'SETUP_ABORT', data: abort, instrument: abort.setup?.instrument });
    };
  }
} else {
  console.log(`📌 Single-instrument mode: ${INST.name}`);
}

orchestrator.onDayReset = async () => {
  console.log('🌅 Day reset — waiting 5s for auth token to stabilize...');
  
  // Clear expiry cache on new day
  lastCachedExpiry = null;
  lastExpiryCheckTime = 0;
  console.log('🔄 [EXPIRY CACHE] Cleared for new day');
  
  await new Promise(r => setTimeout(r, 5000));
  await preloadCandles();
};

// ── SENSEX LTP ───────────────────────────────────────────────
async function fetchSensexLTP() {
  if (!authToken) return null;
  const t0 = Date.now();
  try {
    const res = await axios.post(
      `${BASE}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'LTP', exchangeTokens: { BSE: ['99919000'] } },
      { headers: getHeaders(), timeout: 5000 }
    );
    if (res.data.status && res.data.data?.fetched?.[0]) {
      const ltp = res.data.data.fetched[0].ltp;
      health.setServerState({ lastApiLatMs: Date.now() - t0 });
      return ltp;
    }
  } catch (err) {
    console.error('LTP error:', err.message);
  }
  return null;
}

// ── PHASE B: OI WALL SUPPORT/RESISTANCE ─────────────

function getStrikeStep(strikes) {
  const arr = [...new Set((strikes || []).map(n => Number(n)).filter(n => Number.isFinite(n)))].sort((a,b)=>a-b);
  if (arr.length < 2) return 100;
  // choose smallest positive diff
  const diffs = [];
  for (let i=1;i<arr.length;i++) {
    const d = arr[i] - arr[i-1];
    if (d > 0) diffs.push(d);
  }
  diffs.sort((a,b)=>a-b);
  return diffs[0] || 100;
}

function strength(oi, vol) {
  // OI dominates; volume adds confirmation
  const oiW = 1.0;
  const volW = 0.30;
  return (Number(oi) || 0) * oiW + (Number(vol) || 0) * volW;
}

function clusterLevels(levels, step) {
  if (!Array.isArray(levels) || levels.length === 0) return [];

  const sorted = [...levels]
    .map(x => ({...x, strike: Number(x.strike)}))
    .filter(x => Number.isFinite(x.strike))
    .sort((a,b)=>a.strike-b.strike);

  if (sorted.length === 0) return [];

  const clusters = [];
  let cur = [sorted[0]];

  for (let i=1;i<sorted.length;i++) {
    if (Math.abs(sorted[i].strike - sorted[i-1].strike) <= step) cur.push(sorted[i]);
    else { clusters.push(cur); cur = [sorted[i]]; }
  }
  clusters.push(cur);

  return clusters.map(c => {
    const strikes = c.map(x => x.strike).sort((a,b)=>a-b);
    const center = strikes[Math.floor(strikes.length/2)];
    const strengthSum = c.reduce((s,x)=>s + (Number(x.score) || 0), 0);
    return {
      start: strikes[0],
      end: strikes[strikes.length-1],
      center,
      strikes,
      strength: Math.round(strengthSum),
    };
  }).sort((a,b)=>b.strength-a.strength);
}

// ============================================================
// FIXED computeWalls() Function for server.js (Lines 362-403)
// Replace the original function with this improved version
// ============================================================

function computeWalls(chain, spot) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { 
      resistance: null, 
      support: null, 
      ceWalls: [], 
      peWalls: [], 
      resistanceWall: null, 
      supportWall: null 
    };
  }

  const strikes = chain.map(r => r.strikePrice);
  const step = getStrikeStep(strikes);
  const px = Number(spot);

  // Rank strikes by strength (OI + volume)
  const ceRank = chain
    .map(r => ({
      strike: r.strikePrice,
      score: strength(r.CE?.oi, r.CE?.volume),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const peRank = chain
    .map(r => ({
      strike: r.strikePrice,
      score: strength(r.PE?.oi, r.PE?.volume),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const ceWalls = clusterLevels(ceRank, step);
  const peWalls = clusterLevels(peRank, step);

  // ✅ IMPROVED: Better resistance wall detection
  // Find nearest CE wall ABOVE price (resistance)
  let resistanceWall = null;
  if (Number.isFinite(px)) {
    const ceByCenter = [...ceWalls].sort((a, b) => a.center - b.center);
    // First try: wall exactly at or above price
    resistanceWall = ceByCenter.find(w => w.center >= px);
    // Second try: if none above, use strongest CE wall
    if (!resistanceWall && ceWalls.length > 0) {
      resistanceWall = ceWalls[0];
    }
  } else if (ceWalls.length > 0) {
    resistanceWall = ceWalls[0];
  }

  // ✅ IMPROVED: Better support wall detection
  // Find nearest PE wall BELOW price (support)
  let supportWall = null;
  if (Number.isFinite(px)) {
    const peByCenter = [...peWalls].sort((a, b) => b.center - a.center);
    // First try: wall exactly at or below price
    supportWall = peByCenter.find(w => w.center <= px);
    // Second try: if none below, use strongest PE wall
    if (!supportWall && peWalls.length > 0) {
      supportWall = peWalls[0];
    }
  } else if (peWalls.length > 0) {
    supportWall = peWalls[0];
  }

  // ✅ NEW: Extract values
  let resistance = resistanceWall?.center ?? null;
  let support = supportWall?.center ?? null;

  // ✅ NEW: Sanity check - ensure Support < Resistance
  // If both are the same, force them to different levels
  if (resistance === support && resistance !== null) {
    // Case 1: Multiple CE walls available
    if (ceWalls.length > 1) {
      const higherCEWalls = ceWalls
        .filter(w => w.center > support)
        .sort((a, b) => a.center - b.center);
      if (higherCEWalls.length > 0) {
        resistance = higherCEWalls[0].center;
      }
    }

    // Case 2: If still equal, look for lower PE walls
    if (resistance === support && peWalls.length > 1) {
      const lowerPEWalls = peWalls
        .filter(w => w.center < resistance)
        .sort((a, b) => b.center - a.center);
      if (lowerPEWalls.length > 0) {
        support = lowerPEWalls[0].center;
      }
    }

    // Case 3: If still equal (only 1 wall each), ensure proper bounds
    if (resistance === support && Number.isFinite(px)) {
      // Force support below spot
      if (support >= px && step) {
        support = px - step;
      }
      // Force resistance above spot
      if (resistance <= px && step) {
        resistance = px + step;
      }
    }
  }

  // ✅ NEW: Log when deduplication occurs (debug)
  if (resistanceWall?.center === supportWall?.center && resistance !== support) {
    console.log(`🔧 Wall deduplication: raw=${resistanceWall.center} → S:${support} R:${resistance}`);
  }

  return {
    resistance,
    support,
    ceWalls,
    peWalls,
    resistanceWall,
    supportWall,
    strikeStep: step,
  };
}


function enrichLatestSignalFromChain(chainData) {
  try {
    const snap = orchestrator.getSnapshot();
    const lastSignal = snap?.signals?.lastSignal;
    if (!lastSignal || !lastSignal.optionToken) return null;

    let premium = null;

    for (const row of chainData || []) {
      if (row.CE?.token === lastSignal.optionToken) {
        premium = row.CE?.ltp ?? null;
        break;
      }
      if (row.PE?.token === lastSignal.optionToken) {
        premium = row.PE?.ltp ?? null;
        break;
      }
    }

    if (typeof premium !== 'number') return null;

    const entryPremium = Number(lastSignal.entryPremium);
    const target = Number.isFinite(entryPremium) ? parseFloat((entryPremium + 25).toFixed(2)) : null;
    const sl = Number.isFinite(entryPremium) ? parseFloat((entryPremium - 20).toFixed(2)) : null;

    let tradeStatus = lastSignal.tradeStatus || 'OPEN';
    if (target != null && premium >= target) tradeStatus = 'WIN';
    if (sl != null && premium <= sl) tradeStatus = 'LOSS';

    return {
      ...lastSignal,
      currentPremium: premium,
      entryPremium,
      target,
      sl,
      tradeStatus,
    };
  } catch (_) {
    return null;
  }
}

// ── OPTION CHAIN ─────────────────────────────────────────────
async function fetchOptionChain() {
  if (!authToken || !liveData.atmStrike) return null;
  
  if (Object.keys(tokenMap).length === 0) {
    logger.debug('fetchOptionChain: tokenMap empty, instruments still loading');
    return null;
  }

  try {
    // Get available expiries for cache validation
    const availableExpiries = [...new Set(Object.values(tokenMap).map(i => i.expiry))];
    
    // Use cached expiry instead of recalculating every time
    const expiry = getCachedExpiry(availableExpiries);  // ← CHANGED THIS LINE
    if (!expiry) {
      console.error('❌ fetchOptionChain: Could not find any suitable expiry date');
      return null;
    }
    const atm    = liveData.atmStrike;
    const strikes = [];
    const range = 10; // number of strikes above/below
    for (let i = range; i > 0; i--) strikes.push(atm - (i * INST.step));
    strikes.push(atm);
    for (let i = 1; i <= range; i++) strikes.push(atm + (i * INST.step));

    const chainData = [];
    for (const strike of strikes) {		
	// DEBUG: check tokenMap sample (only once for ATM)
	if (strike === liveData.atmStrike && Object.keys(tokenMap).length > 0) {
	console.log('🔍 SAMPLE TOKEN:', Object.values(tokenMap)[0]);
	}
      // Angel One ScripMaster stores strike as the face value with 2 decimals, e.g. "75700.00"
      // Common formats seen: "75700.0", "75700.00", "75700" — check all
     // ✅ FIXED STRIKE MATCHING (handles Angel formats like 7570000)
		const matchStrike = (s) => {
		const val = Number(s);
		if (!Number.isFinite(val)) return false;
		
		// direct match
		if (val === strike) return true;
		
		// Angel scaled format (x100)
		if (val === strike * 100) return true;
		if (val / 100 === strike) return true;
		
		return false;
		};
      
	  // ✅ FIXED EXPIRY MATCHING (handles 16MAY2026 / 16-MAY-2026 / 16 MAY 2026)
	  const normalize = (x) => String(x || '')
	  .replace(/[-\s]/g, '')
	  .toUpperCase();
	  
	  const matchExpiry = (e) => {
	  if (!e) return false;
	  return normalize(e).includes(normalize(expiry));
	  };

      const ce = Object.values(tokenMap).find(i => matchStrike(i.strike) && i.symbol?.includes('CE') && matchExpiry(i.expiry));
      const pe = Object.values(tokenMap).find(i => matchStrike(i.strike) && i.symbol?.includes('PE') && matchExpiry(i.expiry));
      logger.debug(`Strike ${strike} → CE:${ce?.token || 'NOT FOUND'} PE:${pe?.token || 'NOT FOUND'}`);
      if (ce && pe) chainData.push({ strikePrice: strike, CE: ce, PE: pe });
    }

    if (chainData.length === 0) {
      const expiries = [...new Set(Object.values(tokenMap).map(i => i.expiry))].sort();
      const sampleStrike = Object.values(tokenMap)[0]?.strike ?? 'N/A';
      console.warn(`⚠️ No chain matches for expiry "${expiry}" | tokenMap: ${Object.keys(tokenMap).length} | Available expiries: ${expiries.slice(0,6).join(', ')}`);
      console.warn(`   Strike format in file: "${sampleStrike}" — ATM input was: ${liveData.atmStrike}`);
      return null;
    }

    const tokens = chainData.flatMap(r => [r.CE?.token, r.PE?.token].filter(Boolean));
    const res = await axios.post(
      `${BASE}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'FULL', exchangeTokens: { BFO: tokens } },
      { headers: getHeaders(), timeout: 8000 }
    );

    if (res.data.status && res.data.data?.fetched) {
      const dataMap = {};
      res.data.data.fetched.forEach(f => {
        dataMap[f.symbolToken] = { ltp: f.ltp, oi: f.opnInterest || 0, volume: f.tradeVolume || 0 };
      });

      chainData.forEach(row => {
        if (row.CE && dataMap[row.CE.token]) Object.assign(row.CE, dataMap[row.CE.token]);
        if (row.PE && dataMap[row.PE.token]) Object.assign(row.PE, dataMap[row.PE.token]);
      });
		// ✅ NEW: Feed real option LTP for active trade
const active = require('./strategy/tradeManager').activeTrade;

if (active && active.optionToken) {
  for (const row of chainData) {
    if (row.CE?.token === active.optionToken) {
      orchestrator.onOptionLTP(row.CE.ltp);
      break;
    }
    if (row.PE?.token === active.optionToken) {
      orchestrator.onOptionLTP(row.PE.ltp);
      break;
    }
  }
}

	  // Phase B logic
	  const spot = liveData.sensex || lastSensex || atm;
	  const walls = computeWalls(chainData, spot);
	  const resistance = walls.resistance;
	  const support = walls.support;
      const atmRow     = chainData.find(r => r.strikePrice === liveData.atmStrike);
      const atmCall    = atmRow?.CE?.ltp || null;
      const atmPut     = atmRow?.PE?.ltp  || null;

      //orchestrator.onOptionChain(chainData, atmCall, atmPut);
	  const atm = liveData.atmStrike;
	  
	  // Find ATM row (with debug logging)
	  const currentAtmRow = chainData.find(r => r.strikePrice === atm);
	  
	  if (!currentAtmRow) {
	  console.warn(`⚠️ WARNING: ATM strike ${atm} not found in chainData!`);
	  console.warn(`   Available strikes: ${chainData.map(r => r.strikePrice).join(', ')}`);
	  // Use closest strike instead of null
	  const closest = chainData.reduce((prev, curr) => 
	  	Math.abs(curr.strikePrice - atm) < Math.abs(prev.strikePrice - atm) ? curr : prev
	  );
	  console.warn(`   Using closest strike instead: ${closest.strikePrice}`);
	  }
	  
	  const selectedRow = currentAtmRow || chainData[Math.floor(chainData.length / 2)]; // Fallback to middle
	  
	  // Build premiums object (CORRECT FORMAT)
	  const premiums = {
	  atm: {
	  	strike: atm,
	  	call: selectedRow?.CE?.ltp ?? null,
	  	put: selectedRow?.PE?.ltp ?? null,
	  },
	  exec: {
	  	ce: {
	  	strike: atm,
	  	premium: selectedRow?.CE?.ltp ?? null,
	  	token: selectedRow?.CE?.token ?? null,
	  	expiry: selectedRow?.CE?.expiry ?? null,
	  	},
	  	pe: {
		strike: atm,
	  	premium: selectedRow?.PE?.ltp ?? null,
	  	token: selectedRow?.PE?.token ?? null,
	  	expiry: selectedRow?.PE?.expiry ?? null,
	  	},
	  },
	  };
	  
	  // ✅ Correct call with debugging
	  console.log(`📊 ATM Data: strike=${atm}, call=${selectedRow?.CE?.ltp}, put=${selectedRow?.PE?.ltp}`);
	  orchestrator.onOptionChain(chainData, premiums);
      console.log(`✅ Chain: ${chainData.length} strikes | ATM CE:${atmCall} PE:${atmPut} | S:${support} R:${resistance}`);
	  console.log(`🧠 WALL SR → Support:${support} Resistance:${resistance}`);
		 if (walls?.supportWall || walls?.resistanceWall) {
		   console.log(`🧱 WALL ZONES → SUP ${walls.supportWall?.start ?? '--'}-${walls.supportWall?.end ?? '--'} | RES ${walls.resistanceWall?.start ?? '--'}-${walls.resistanceWall?.end ?? '--'}`);
		 }
  lastRangeData   = { resistance, support };
      lastOptionChain = chainData;

      broadcast({
        type: 'RANGE_UPDATE',
        resistance,
        support
      });

      const oiAnalysis = oiEngine.getAnalysis(spot) || {};

      broadcast({
        type: 'OI_WALLS',
        data: oiAnalysis
      });

      // Keep the latest visible signal tied to its original contract token,
      // not to the newly recalculated ATM row.
      const liveSignal = enrichLatestSignalFromChain(chainData);
      if (liveSignal) {
        broadcast({ type: 'SIGNAL', data: liveSignal });
      }

      return chainData;
    }
  } catch (err) {
    console.error('Chain error:', err.message);
  }
  return null;
}

// ── WEBSOCKET (Angel One feed) ───────────────────────────────
function connectAngelWebSocket() {
  // ✅ prevent multiple connections
  if (angelWS && angelWS.readyState === WebSocket.OPEN) {
    return;
  }

  if (isWSConnecting) {
    return;
  }

  isWSConnecting = true;

  console.log('🔌 Connecting to Angel One WebSocket...');

  // ❌ REMOVE forced close
  // if (angelWS) { try { angelWS.close(); } catch (_) {} }

  angelWS = new WebSocket('wss://smartapisocket.angelone.in/smart-stream', {
    headers: {
      'Authorization': authToken,
      'x-api-key': config.angel.apiKey,
      'x-client-code': config.angel.clientId,
      'x-feed-token': feedToken,
    },
  });


  angelWS.on('open', () => {
  console.log('✅ Angel One WebSocket connected');

  isWSConnecting = false;

  const tokenList = [];
  if (manager) {
    for (const name of MULTI_INSTRUMENTS) {
      const cfg = INSTRUMENT_CONFIG[name];
      tokenList.push({ exchangeType: cfg.wsExchangeType, tokens: [cfg.indexToken] });
    }
  } else {
    tokenList.push({ exchangeType: INST.wsExchangeType, tokens: [INST.indexToken] });
  }
  angelWS.send(JSON.stringify({
    correlationID: 'soa',
    action: 1,
    params: { mode: 3, tokenList }
  }));

  console.log(`📡 Subscribed to ${manager ? MULTI_INSTRUMENTS.join(', ') : INST.displayName} feed`);
});
  angelWS.on('message', (data) => {
    try {
      const buf = Buffer.from(data);
      if (buf.length >= 51) {
        // WS tick received — LTP fetched via REST for accuracy (logged only in debug)
        logger.debug('WS tick received');
      }
    } catch (_) {}
  });
  angelWS.on('error', (err) => console.error('⚠️ WS error:', err.message));
  angelWS.on('close', () => {
  console.log('⚠️ WS closed. Reconnecting in 5s...');

  angelWS = null;
  isWSConnecting = false;

  setTimeout(() => {
    connectAngelWebSocket();
  }, 5000);
});

  // Heartbeat every 30s
  const hb = setInterval(() => {
    if (angelWS?.readyState === WebSocket.OPEN) {
      angelWS.send(JSON.stringify({ correlationID: 'hb', action: 0, params: {} }));
    } else {
      clearInterval(hb);
    }
  }, 30000);
}

// ── EXPIRY CALC ───────────────────────────────────────────────
//function getThisWeekExpiry() {
//  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
//  const day = ist.getDay();
//  const thursday = new Date(ist);
//  const daysToThu = (4 - day + 7) % 7;
//  thursday.setDate(ist.getDate() + (daysToThu === 0 ? 0 : daysToThu));
//  const dd  = String(thursday.getDate()).padStart(2, '0');
//  const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][thursday.getMonth()];
//  const yy  = String(thursday.getFullYear());
//  return `${dd}${mmm}${yy}`;
//}
// ── HELPER: Format date to DDMMMYYYY format ───────────────────────────────────
function formatExpiryDate(date) {
  const dd  = String(date.getDate()).padStart(2, '0');
  const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][date.getMonth()];
  const yyyy = String(date.getFullYear());
  return `${dd}${mmm}${yyyy}`;
}

// ── HELPER: Get IST date ───────────────────────────────────────────────────────
function getISTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

// ── HELPER: Check if expiry exists in tokenMap ───────────────────────────────────
function expiryExists(expiryStr) {
  if (!expiryStr || Object.keys(tokenMap).length === 0) return false;
  
  const normalize = (x) => String(x || '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  
  const normalized = normalize(expiryStr);
  
  return Object.values(tokenMap).some(token => 
    normalize(token.expiry).includes(normalized)
  );
}

// ── HELPER: Find available expiry in a date range ───────────────────────────────────
function findAvailableExpiryInRange(startDate, endDate) {
  const current = new Date(startDate);
  const today = getISTDate();  // Get today's date
  today.setHours(0, 0, 0, 0);  // Set to midnight for fair comparison
  
  // Loop through each date in the range
  while (current <= endDate) {
    // SKIP PAST DATES ← THIS IS THE FIX
    if (current < today) {
      current.setDate(current.getDate() + 1);
      continue;
    }
    
    // Skip weekends
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {  // 0=Sunday, 6=Saturday
      const dateStr = formatExpiryDate(current);
      if (expiryExists(dateStr)) {
        return { date: dateStr, day: current.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: '2-digit' }) };
      }
    }
    current.setDate(current.getDate() + 1);
  }
  
  return null;
}

// ── HELPER: Get last Thursday of a given month ───────────────────────────────────
function getLastThursdayOfMonth(year, month) {
  // Get last day of the month
  const lastDay = new Date(year, month + 1, 0);
  
  // Loop backwards to find Thursday (day 4)
  while (lastDay.getDay() !== 4) {
    lastDay.setDate(lastDay.getDate() - 1);
  }
  
  return lastDay;
}

// ── HELPER: Get next week's start and end dates ───────────────────────────────────
function getNextWeekDateRange(fromDate) {
  const dayOfWeek = fromDate.getDay();
  
  // Calculate next Monday
  const daysToMonday = (1 - dayOfWeek + 7) % 7;
  const nextMonday = new Date(fromDate);
  nextMonday.setDate(fromDate.getDate() + (daysToMonday === 0 ? 7 : daysToMonday));
  
  // Next Friday is 4 days after Monday
  const nextFriday = new Date(nextMonday);
  nextFriday.setDate(nextMonday.getDate() + 4);
  
  return { start: nextMonday, end: nextFriday };
}

// ── MAIN: Smart expiry fallback with 5-level priority ───────────────────────────────────
function getThisWeekExpiry() {
  const ist = getISTDate();
  const dayOfWeek = ist.getDay();
  
  console.log(`\n📅 [EXPIRY SEARCH] Starting search on ${ist.toDateString()} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]})`);
  
  // ── LEVEL 1: Check This Week's Thursday ───────────────────────────────────
  console.log('  ├─ Level 1: Checking this week\'s Thursday...');
  const daysToThu = (4 - dayOfWeek + 7) % 7;
  const thisThursday = new Date(ist);
  thisThursday.setDate(ist.getDate() + (daysToThu === 0 ? 0 : daysToThu));
  const thisThuStr = formatExpiryDate(thisThursday);
  
  if (expiryExists(thisThuStr)) {
    console.log(`  ✅ Found: "${thisThuStr}" (This week's Thursday)\n`);
    return thisThuStr;
  }
  console.log(`  ❌ Not found: "${thisThuStr}"`);
  
  // ── LEVEL 2: Scan entire this week (Mon-Fri) ───────────────────────────────────
  console.log('  ├─ Level 2: Scanning entire this week (Mon-Fri)...');
  const thisWeekStart = new Date(ist);
  // Calculate this Monday
  const daysToMonday = (1 - dayOfWeek + 7) % 7;
  thisWeekStart.setDate(ist.getDate() - dayOfWeek + 1);  // Start from Monday
  
  const thisWeekEnd = new Date(thisWeekStart);
  thisWeekEnd.setDate(thisWeekStart.getDate() + 4);  // Friday
  
  const foundThisWeek = findAvailableExpiryInRange(thisWeekStart, thisWeekEnd);
  if (foundThisWeek) {
    console.log(`  ✅ Found: "${foundThisWeek.date}" (${foundThisWeek.day} - This week fallback)\n`);
    return foundThisWeek.date;
  }
  console.log(`  ❌ No contracts found in entire this week`);
  
  // ── LEVEL 3: Check Next Week's Thursday ───────────────────────────────────
  console.log('  ├─ Level 3: Checking next week\'s Thursday...');
  const nextWeekRange = getNextWeekDateRange(ist);
  const nextThursday = new Date(nextWeekRange.start);
  nextThursday.setDate(nextWeekRange.start.getDate() + 3);  // 3 days after Monday = Thursday
  const nextThuStr = formatExpiryDate(nextThursday);
  
  if (expiryExists(nextThuStr)) {
    console.log(`  ✅ Found: "${nextThuStr}" (Next week's Thursday)\n`);
    return nextThuStr;
  }
  console.log(`  ❌ Not found: "${nextThuStr}"`);
  
  // ── LEVEL 4: Scan entire next week (Mon-Fri) ───────────────────────────────────
  console.log('  ├─ Level 4: Scanning entire next week (Mon-Fri)...');
  const foundNextWeek = findAvailableExpiryInRange(nextWeekRange.start, nextWeekRange.end);
  if (foundNextWeek) {
    console.log(`  ✅ Found: "${foundNextWeek.date}" (${foundNextWeek.day} - Next week fallback)\n`);
    return foundNextWeek.date;
  }
  console.log(`  ❌ No contracts found in entire next week`);
  
  // ── LEVEL 5: Check Last Thursday of Next Month ───────────────────────────────────
  console.log('  └─ Level 5: Checking last Thursday of next month...');
  const nextMonth = ist.getMonth() + 1;
  const nextYear = nextMonth === 12 ? ist.getFullYear() + 1 : ist.getFullYear();
  const monthForCalc = nextMonth === 12 ? 0 : nextMonth;
  
  const lastThuNextMonth = getLastThursdayOfMonth(nextYear, monthForCalc);
  const lastThuStr = formatExpiryDate(lastThuNextMonth);
  
  if (expiryExists(lastThuStr)) {
    console.log(`  ✅ Found: "${lastThuStr}" (Last Thursday of next month)\n`);
    return lastThuStr;
  }
  console.log(`  ❌ Not found: "${lastThuStr}"`);
  
  // ── ERROR: No expiry found anywhere ───────────────────────────────────
  console.error(`\n❌ [EXPIRY CRITICAL ERROR] No expiry found in any level!`);
  const availableExpiries = [...new Set(Object.values(tokenMap).map(i => i.expiry))].sort();
  console.error(`   Available expiries: ${availableExpiries.slice(0, 10).join(', ')}`);
  console.error(`   tokenMap size: ${Object.keys(tokenMap).length}\n`);
  
  return null;
}


function getCachedExpiry(availableExpiries) {
  const now = Date.now();
  const today = new Date().toLocaleDateString('en-US');  // "5/28/2026" format
  
  // Check 1: New day? Reset cache
  if (lastExpiryResetDate && lastExpiryResetDate !== today) {
    console.log('📅 [EXPIRY CACHE] Day boundary detected — resetting cache');
    lastCachedExpiry = null;
    lastExpiryCheckTime = 0;
  }
  lastExpiryResetDate = today;
  
  // Check 2: Cache still valid (less than 1 minute old)?
  if (lastCachedExpiry && lastExpiryCheckTime && (now - lastExpiryCheckTime) < EXPIRY_CACHE_TTL) {
    return lastCachedExpiry;  // Return cached without re-evaluating
  }
  if (DEBUG_EXPIRY_CACHE) console.log('📅 [EXPIRY CACHE MISS] Re-evaluating...');
  
  // Check 3: Need to re-evaluate expiry
  console.log('📅 [EXPIRY CACHE] Re-evaluating (cache expired or empty)');
  const expiry = getThisWeekExpiry();
  
  // Update cache
  lastCachedExpiry = expiry;
  lastExpiryCheckTime = now;
  
  return expiry;
}
// ── EXPIRY CALC (LEGACY - kept for reference) ───────────────────────────────────
// This is the old simple function, replaced by getThisWeekExpiry() above
function getThisWeekExpiry_LEGACY() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const thursday = new Date(ist);
  const daysToThu = (4 - day + 7) % 7;
  thursday.setDate(ist.getDate() + (daysToThu === 0 ? 0 : daysToThu));
  const dd  = String(thursday.getDate()).padStart(2, '0');
  const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][thursday.getMonth()];
  const yy  = String(thursday.getFullYear());
  return `${dd}${mmm}${yy}`;
}

// ── BROADCAST ─────────────────────────────────────────────────
function broadcast(msg) {
  const serverTime = msg.serverTime || Date.now();
  const enriched = { ...msg, serverTime, timestamp: new Date(serverTime).toISOString(), feedAges: orchestrator.getSnapshot?.().feedAges || {} };
  const str = JSON.stringify(enriched);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

 function getTodayIST() {
   const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
   return now.toISOString().split('T')[0];
 }
// ── PHASE 1: INIT STATE HELPER ───────────────────────────────
function buildInitState() {
  const today = getTodayIST();
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  const snap = orchestrator.getSnapshot();

  return {
    authStatus: authToken ? 'connected' : 'disconnected',
    config: { trading: config.trading, market: config.market },
    market: {
      lastSensex,
      liveData,
      range: lastRangeData,
      optionChain: lastOptionChain,
      snapshot: snap,
    },
    activeTrade: snap?.trade?.activeTrade || null,
    pendingCandidate: snap?.pendingCandidate || null,
    todaySignalHistory: database.getSignalsByDate(today, 100),
    sessionSignalHistory: database.getSignalsAfterTimestamp(threeHoursAgo, 100),
    sessionStartTime: threeHours
  };
}
 function getISTNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isMarketOpenIST() {
  const now = getISTNow();
  const day = now.getDay(); // 0 Sun, 6 Sat
  if (day === 0 || day === 6) return false;

  const mins = now.getHours() * 60 + now.getMinutes();
  // 09:15 to 15:30 IST
  return mins >= 555 && mins <= 930;
}
 
 function buildInitState() {
   const today = getTodayIST();
   if (manager) {
     return {
       authStatus: authToken ? 'connected' : 'disconnected',
       multiInstrument: true,
       instruments: MULTI_INSTRUMENTS,
       sessions: manager.getAllSnapshots(),
       todaySignalHistory: database.getSignalsByDate(today, 100),
     };
   }
   const todaySignals = database.getSignalsByDate
     ? database.getSignalsByDate(today, 100)
     : database.getRecentSignals(100).filter(s => s.date === today);
 
   const snap = orchestrator.getSnapshot();
 
   return {
     authStatus: authToken ? 'connected' : 'disconnected',
     config: { trading: config.trading, market: config.market },
     market: {
       lastSensex,
       liveData,
       range: lastRangeData,
       optionChain: lastOptionChain,
       snapshot: snap
     },
     activeTrade: snap?.trade?.activeTrade || null,
     pendingCandidate: snap?.pendingCandidate || null,
     todaySignalHistory: todaySignals
   };
 }

// ── BROWSER WS CONNECTIONS ────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`🌐 Browser connected (${clients.size} total)`);

  const initState = buildInitState();

  // Current shape
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    data: initState
  }));

  // Legacy shape so existing frontend code can hydrate immediately
  // Legacy shape so existing frontend code can hydrate immediately
  ws.send(JSON.stringify({
    type: 'INIT',
    snapshot: initState.market?.snapshot || null,
    pastSignals: initState.todaySignalHistory || [],
    sessionSignalHistory: initState.sessionSignalHistory || [],
    authStatus: initState.authStatus,
    config: initState.config,
    lastSensex: initState.market?.lastSensex ?? null,
    liveData: initState.market?.liveData ?? {},
  }));
 

  ws.on('message', async (msg) => {
    try {
      const req = JSON.parse(msg);
	  if (req.type === 'GET_INIT_STATE') {
		ws.send(JSON.stringify({ type: 'INIT_STATE', data: buildInitState() }));
		}
      if (req.type === 'GET_OPTION_CHAIN') {
        const chain = await fetchOptionChain();
        ws.send(JSON.stringify({ type: 'OPTION_CHAIN', data: chain }));
		} else if (req.type === 'GET_INIT_STATE') {
		ws.send(JSON.stringify({ type: 'INIT_STATE', data: buildInitState() }));
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🌐 Browser disconnected (${clients.size} remaining)`);
  });
});

// ── REST API ROUTES ───────────────────────────────────────────
app.get('/api/status',       (req, res) => res.json({ connected: !!authToken, sensex: lastSensex }));
app.get('/api/sensex',       async (req, res) => res.json({ ltp: await fetchSensexLTP() }));
app.get('/api/option-chain', async (req, res) => res.json((await fetchOptionChain()) || { error: 'Failed' }));

// Health endpoint
app.get('/api/health', (req, res) => {
  try {
    const payload    = health.buildHealthPayload();
    const httpStatus = payload.status === 'healthy' ? 200 : payload.status === 'degraded' ? 207 : 503;
    res.status(httpStatus).json(payload);
  } catch (err) {
    logger.error('❌ /api/health failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Stats endpoints
app.get('/api/stats/today',   (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({ date: today, stats: database.getDailyStats(today) || {} });
});
app.get('/api/stats/signals', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  res.json({ signals: database.getRecentSignals(limit) });
});
app.get('/api/stats/winrate', (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  res.json({ days, win_rate: database.getWinRate(days) });
});

// ── POLLING INTERVALS ─────────────────────────────────────────

// LTP poll every 2s
let chainBootstrapped = false;

setInterval(async () => {
  if (!authToken) return;

  const marketOpen = isMarketOpenIST();
  health.setServerState({
    authToken,
    wsClients: clients.size,
    marketOpen,
  });

  if (!marketOpen) return;

  const ltp = await fetchSensexLTP();
  if (!ltp) return;

  lastSensex = ltp;
  liveData.sensex = ltp;
  liveData.atmStrike = Math.round(ltp / INST.step) * INST.step;

  if (manager) {
    manager.routeTick(INST.name, ltp);
  } else {
    orchestrator.onTick(ltp);
  }

  if (clients.size > 0) {
    broadcast({ type: 'SENSEX_LTP', ltp, instrument: INST.name }); // type kept for frontend compat
  }

  health.setServerState({
    authToken,
    wsClients: clients.size,
    lastSensex: ltp,
    marketOpen,
  });

  if (!chainBootstrapped) {
    chainBootstrapped = true;
    const chain = await fetchOptionChain();
    if (chain && clients.size > 0) {
      broadcast({ type: 'OPTION_CHAIN', data: chain });
    }
  }
}, 2000);

// Option chain refresh every 5s
setInterval(async () => {
  if (!authToken || !liveData.atmStrike) return;
  if (!isMarketOpenIST()) return;

  const chain = await fetchOptionChain();

  if (chain) {
    if (manager) {
      manager.routeOptionChain(INST.name, chain, {
        atm: { strike: liveData.atmStrike, call: chain.find(r => r.strikePrice === liveData.atmStrike)?.CE?.ltp, put: chain.find(r => r.strikePrice === liveData.atmStrike)?.PE?.ltp },
        exec: {
          ce: { strike: liveData.atmStrike, premium: chain.find(r => r.strikePrice === liveData.atmStrike)?.CE?.ltp, token: chain.find(r => r.strikePrice === liveData.atmStrike)?.CE?.token, expiry: chain.find(r => r.strikePrice === liveData.atmStrike)?.CE?.expiry },
          pe: { strike: liveData.atmStrike, premium: chain.find(r => r.strikePrice === liveData.atmStrike)?.PE?.ltp, token: chain.find(r => r.strikePrice === liveData.atmStrike)?.PE?.token, expiry: chain.find(r => r.strikePrice === liveData.atmStrike)?.PE?.expiry },
        }
      });
    }
    if (clients.size > 0) {
      broadcast({ type: 'OPTION_CHAIN', data: chain, instrument: INST.name });
    }
  }
}, 5000);

// Re-auth every 12h
setInterval(authenticate, 12 * 60 * 60 * 1000);


// Phase 1: Persist feed health every 30s
setInterval(() => {
  try {
    const report = orchestrator.getSnapshot?.().feedAges || {};
    Object.entries(report).forEach(([feed, r]) => {
      database.logFeedHealth(feed, r.ageMs, r.isStale);
    });
  } catch (_) {}
}, 30000);


// ── START SERVER ──────────────────────────────────────────────
const PORT = config.server.port;
server.listen(PORT, config.server.host, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      SOA TRADER — Local Server v2.2      ║');
  console.log(`║   Instrument: ${INST.displayName.padEnd(26)}║`);
  console.log(`║   Listening on port ${PORT}                  ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  authenticate();
  health.startPeriodicSnapshots();
});
