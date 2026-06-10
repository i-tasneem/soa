// ============================================================
// SERVER v7 — Broker-Agnostic + Audit Framework
// Changes from v6:
// 1. Uses broker factory (createBrokerAdapter) instead of hardcoded Angel
// 2. Injects SignalAudit into MultiOrchestrator
// 3. Adds audit reporting API endpoints
// 4. Graceful shutdown with broker cleanup
// 5. Redis integration (optional)
// ============================================================

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createBrokerAdapter } = require('./broker');
const { SignalAudit } = require('./audit/signalAudit');
const { MultiOrchestrator } = require('./strategy/core/multiOrchestrator');
const logger = require('./logger');
const database = require('./database');
const config = require('./config');
const health = require('./health');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let orchestrator = null;
let signalAudit = null;
let redisClient = null;

// ── REDIS SETUP (Optional) ──────────────────────────────────
async function setupRedis() {
  if (!config.redis || !config.redis.enabled) {
    logger.info('[Server] Redis disabled');
    return null;
  }
  try {
    const redis = require('redis');
    const client = redis.createClient({
      url: config.redis.url || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500),
      },
    });
    client.on('error', (err) => logger.error(`[Redis] ${err.message}`));
    await client.connect();
    logger.info('[Server] Redis connected');
    return client;
  } catch (err) {
    logger.warn(`[Server] Redis connection failed: ${err.message}`);
    return null;
  }
}

// ── INITIALIZATION ───────────────────────────────────────────
async function initialize() {
  try {
    logger.info('[Server] Starting SOA Trader v7...');

    // Setup Redis
    redisClient = await setupRedis();

    // Create broker adapter from config
    const brokerType = config.broker?.type || 'angel';
	const brokerConfig = brokerType === 'angel' 
    ? config.broker.angel 
    : config.broker.dhan;


    const brokerAdapter = createBrokerAdapter(brokerType, brokerConfig);
    logger.info(`[Server] Broker adapter created: ${brokerType}`);

    // Initialize audit framework
    signalAudit = new SignalAudit(database.db);

    // Create orchestrator with broker and audit
    orchestrator = new MultiOrchestrator(brokerAdapter, signalAudit, {
      ltpInterval: config.polling?.ltpInterval || 2000,
      chainInterval: config.polling?.chainInterval || 5000,
      wsThrottleMs: config.polling?.wsThrottleMs || 5000,
      useRedis: !!redisClient,
      redisClient,
    });

    await orchestrator.initialize();

    // Add instruments from config
    for (const [instrumentId, profile] of Object.entries(config.instruments || {})) {
      orchestrator.addInstrument(instrumentId, profile);
    }
	orchestrator.startAll();

    // Bind orchestrator events to WebSocket
    orchestrator.on('broadcast', (data) => {
      broadcastToClients(data.type, data);
    });
    orchestrator.on('signal', (data) => {
      broadcastToClients('SIGNAL', data);
    });
    orchestrator.on('tradeOpen', (data) => {
      broadcastToClients('TRADE_OPEN', data);
    });
    orchestrator.on('tradeClosed', (data) => {
      broadcastToClients('TRADE_CLOSED', data);
    });
    orchestrator.on('engineError', (data) => {
      broadcastToClients('ERROR', data);
    });

    logger.info('[Server] Initialization complete');
    return true;
  } catch (err) {
    logger.error(`[Server] Initialization failed: ${err.message}`);
    throw err;
  }
}

// ── WEBSOCKET ───────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  logger.info(`[WS] Client connected. Total: ${clients.size}`);

  // Send current snapshots
  if (orchestrator) {
    const snapshots = orchestrator.getAllSnapshots();
    ws.send(JSON.stringify({ type: 'INIT', data: snapshots, timestamp: Date.now() }));
  }

  ws.on('close', () => {
    clients.delete(ws);
    logger.info(`[WS] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (err) => {
    logger.error(`[WS] Client error: ${err.message}`);
  });
});

function broadcastToClients(type, data) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ── EXPRESS ROUTES ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json(health.getStatus());
});

// Instrument snapshots
app.get('/api/snapshot/:instrumentId', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Not initialized' });
  const snapshot = orchestrator.getSnapshot(req.params.instrumentId);
  if (!snapshot) return res.status(404).json({ error: 'Instrument not found' });
  res.json(snapshot);
});

app.get('/api/snapshots', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Not initialized' });
  res.json(orchestrator.getAllSnapshots());
});

// Start/Stop instruments
app.post('/api/instrument/:instrumentId/start', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Not initialized' });
  orchestrator.startInstrument(req.params.instrumentId);
  res.json({ success: true, instrumentId: req.params.instrumentId });
});

app.post('/api/instrument/:instrumentId/stop', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Not initialized' });
  orchestrator.stopInstrument(req.params.instrumentId);
  res.json({ success: true, instrumentId: req.params.instrumentId });
});

app.post('/api/start-all', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Not initialized' });
  orchestrator.startAll();
  res.json({ success: true });
});

app.post('/api/stop-all', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Not initialized' });
  orchestrator.stopAll();
  res.json({ success: true });
});

// ── AUDIT API ENDPOINTS ─────────────────────────────────────
app.get('/api/audit/performance', (req, res) => {
  if (!signalAudit) return res.status(503).json({ error: 'Audit not initialized' });
  const { instrument, date, days } = req.query;
  try {
    const report = signalAudit.getPerformanceReport({
      instrument,
      date,
      days: parseInt(days) || 7,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit/signals', (req, res) => {
  if (!signalAudit) return res.status(503).json({ error: 'Audit not initialized' });
  const { instrument, limit } = req.query;
  try {
    const signals = signalAudit.getRecentSignals(instrument, parseInt(limit) || 50);
    res.json(signals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit/signal/:auditId', (req, res) => {
  if (!signalAudit) return res.status(503).json({ error: 'Audit not initialized' });
  try {
    const detail = signalAudit.getSignalDetails(req.params.auditId);
    if (!detail) return res.status(404).json({ error: 'Signal not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRADITIONAL API (preserved) ─────────────────────────────
app.get('/api/signals/:instrument', (req, res) => {
  const signals = database.getSignals(req.params.instrument, 100);
  res.json(signals);
});

app.get('/api/trades/:instrument', (req, res) => {
  const trades = database.getTrades(req.params.instrument, 100);
  res.json(trades);
});

app.get('/api/performance/:date', (req, res) => {
  const performance = database.getDailyPerformance(req.params.date);
  res.json(performance);
});

// ── START SERVER ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await initialize();
  server.listen(PORT, () => {
    logger.info(`[Server] Running on port ${PORT}`);
  });
}

// ── GRACEFUL SHUTDOWN ───────────────────────────────────────
async function shutdown() {
  logger.info('[Server] Shutting down...');

  if (orchestrator) {
    await orchestrator.shutdown();
  }

  if (redisClient) {
    await redisClient.quit();
  }

  database.close();

  server.close(() => {
    logger.info('[Server] HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => {
    logger.error('[Server] Forced shutdown');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  logger.error(`[Server] Uncaught exception: ${err.message}`);
  shutdown();
});

start().catch((err) => {
  logger.error(`[Server] Failed to start: ${err.message}`);
  process.exit(1);
});
