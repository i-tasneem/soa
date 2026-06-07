// ============================================================
//  SERVER.JS — ADDITIONS FOR SIGNAL ENGINE
//  Add these to your existing server.js
// ============================================================

// ── 1. ADD THIS NEAR THE TOP (after existing requires) ───────
const orchestrator = require('./strategy/orchestrator');

// ── 2. WIRE ORCHESTRATOR CALLBACKS (add after authenticate()) ─
orchestrator.onSignal = (signal) => {
  broadcast({ type: 'SIGNAL', data: signal });
  console.log(`🚨 Broadcasting signal: ${signal.type} ${signal.confidence}%`);
};

orchestrator.onUpdate = (update) => {
  broadcast({ type: 'ANALYSIS', data: update });
};

orchestrator.onTradeClose = (trade) => {
  broadcast({ type: 'TRADE_CLOSED', data: trade });
};

// ── 3. UPDATE YOUR REST LTP POLLING INTERVAL ─────────────────
// Find your existing LTP setInterval and ADD this one line:
// orchestrator.onTick(ltp);
// Example — your existing interval should look like this:
setInterval(async () => {
  if (!authToken || clients.size === 0) return;
  const ltp = await fetchSensexLTP();
  if (ltp) {
    lastSensex = ltp;
    liveData.sensex = ltp;
    liveData.atmStrike = Math.round(ltp / 100) * 100;
    broadcast({ type: 'SENSEX_LTP', ltp });
    orchestrator.onTick(ltp);   // ← ADD THIS LINE
  }
}, 2000);

// ── 4. UPDATE YOUR OPTION CHAIN INTERVAL ─────────────────────
// Find your existing chain setInterval and ADD these lines:
setInterval(async () => {
  if (!authToken || clients.size === 0) return;
  const chain = await fetchOptionChain();
  if (chain) {
    broadcast({ type: 'OPTION_CHAIN', data: chain });
    // Find ATM premiums
    const atm = liveData.atmStrike;
    const atmRow = chain.find(r => r.strikePrice === atm);
    const atmCall = atmRow?.CE?.ltp || null;
    const atmPut  = atmRow?.PE?.ltp || null;
    orchestrator.onOptionChain(chain, atmCall, atmPut); // ← ADD THIS LINE
  }
}, 10000);

// ── 5. ADD SNAPSHOT TO BROWSER INIT MESSAGE ──────────────────
// In wss.on('connection') find where you send INIT and add:
// snapshot: orchestrator.getSnapshot()
// Example:
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type:       'INIT',
    authStatus: authToken ? 'connected' : 'disconnected',
    config:     { trading: config.trading, market: config.market },
    lastSensex,
    liveData,
    snapshot:   orchestrator.getSnapshot(),  // ← ADD THIS
  }));
  // ... rest of your existing ws handlers
});
