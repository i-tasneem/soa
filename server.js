// ============================================================
// SOA TRADER SERVER — Multi-Instrument Architecture
// Node.js 20, Express 4, WebSocket (ws)
// ============================================================

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const otplib = require('otplib');

const config = require('./config');
const logger = require('./logger');
const db = require('./database');
const health = require('./health');

// NEW: Multi-instrument imports
const multiOrchestrator = require('./strategy/core/multiOrchestrator');
const profiles = require('./strategy/dna/instrumentProfiles');
const { StockScanner } = require('./strategy/stockScanner');

// Legacy singletons (kept for backward compat in some contexts)
// const orchestrator = require('./strategy/orchestrator'); // REMOVED
// const oiEngine = require('./strategy/oiEngine'); // REMOVED

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let authToken = null;
let refreshToken = null;
let feedToken = null;
let jwtToken = null;
let userProfile = null;

// ── AUTHENTICATION ─────────────────────────────────────────
async function authenticate() {
  try {
    const totp = otplib.authenticator.generate(config.angel.totpSecret);
    const resp = await axios.post(`${config.angel.baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      clientcode: config.angel.clientId,
      password: config.angel.password,
      totp: totp,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': 'CLIENT_LOCAL_IP',
        'X-ClientPublicIP': 'CLIENT_PUBLIC_IP',
        'X-MACAddress': 'MAC_ADDRESS',
      },
    });

    if (resp.data && resp.data.status && resp.data.data) {
      authToken = resp.data.data.jwtToken;
      refreshToken = resp.data.data.refreshToken;
      feedToken = resp.data.data.feedToken;
      jwtToken = authToken;
      userProfile = resp.data.data;

      // Set auth token on multi-orchestrator
      multiOrchestrator.setAuthToken(authToken);
      multiOrchestrator.marketData.brokerConfig.jwtToken = jwtToken;
      multiOrchestrator.marketData.brokerConfig.baseUrl = config.angel.baseUrl;

      logger.info('Angel One authenticated successfully');
      broadcastToAllClients({ type: 'AUTH_STATUS', status: 'connected', message: 'Angel One Live' });

      // Initialize instruments after auth
      initializeInstruments();
    } else {
      throw new Error(resp.data?.message || 'Authentication failed');
    }
  } catch (err) {
    logger.error(`Authentication error: ${err.message}`);
    broadcastToAllClients({ type: 'AUTH_STATUS', status: 'error', message: err.message });
  }
}

function initializeInstruments() {
  // Add all configured index instruments
  for (const instId of config.activeInstruments) {
    const profile = profiles[instId];
    if (profile) {
      multiOrchestrator.addInstrument(instId, profile);
    }
  }

  // Start stock scanner if enabled
  if (config.enableStockOptions) {
    const scanner = new StockScanner(multiOrchestrator.marketData, multiOrchestrator);
    scanner.start();
  }
}

// ── WEBSOCKET BROADCAST ────────────────────────────────────
function broadcastToAllClients(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) {}
    }
  });
}

// Wire multi-orchestrator broadcast to WebSocket
multiOrchestrator.externalBroadcast = (msg) => {
  broadcastToAllClients(msg);
};

// ── WEBSOCKET CONNECTION HANDLER ───────────────────────────
wss.on('connection', (ws) => {
  logger.info('Client connected');

  // Send INIT_STATE with all instruments
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    data: {
      authStatus: authToken ? 'connected' : 'disconnected',
      instruments: multiOrchestrator.getAllSnapshots(),
      config: { trading: config.trading, market: config.market },
    },
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'GET_INIT_STATE') {
        ws.send(JSON.stringify({
          type: 'INIT_STATE',
          data: {
            authStatus: authToken ? 'connected' : 'disconnected',
            instruments: multiOrchestrator.getAllSnapshots(),
            config: { trading: config.trading, market: config.market },
          },
        }));
      }
      if (msg.type === 'GET_OPTION_CHAIN') {
        // Client requesting option chain — handled by polling, but can trigger immediate
        // No-op for now, polling handles it
      }
    } catch (err) {
      logger.warn('WS message parse error');
    }
  });

  ws.on('close', () => {
    logger.info('Client disconnected');
  });
});

// ── REST API ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json(health.getStatus());
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: !!authToken,
    instruments: multiOrchestrator.getAllSnapshots(),
    authStatus: authToken ? 'connected' : 'disconnected',
    timestamp: Date.now(),
  });
});

app.get('/api/instruments/:id/snapshot', (req, res) => {
  const snapshot = multiOrchestrator.getSnapshot(req.params.id);
  if (!snapshot) {
    return res.status(404).json({ error: 'Instrument not found' });
  }
  res.json(snapshot);
});

// Backward compatibility: SENSEX snapshot
app.get('/api/sensex', (req, res) => {
  const snapshot = multiOrchestrator.getSnapshot('SENSEX');
  if (!snapshot) {
    return res.status(404).json({ error: 'SENSEX not active' });
  }
  res.json({
    ...snapshot,
    lastSensex: snapshot.price,
    liveData: { sensex: snapshot.price, atmStrike: snapshot.atmStrike },
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    trading: config.trading,
    market: config.market,
    activeInstruments: config.activeInstruments,
    enableStockOptions: config.enableStockOptions,
  });
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const resp = await axios.post(`${config.angel.baseUrl}/rest/auth/angelbroking/user/v1/generateToken`, {
      refreshToken: refreshToken,
    }, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (resp.data && resp.data.status && resp.data.data) {
      authToken = resp.data.data.jwtToken;
      refreshToken = resp.data.data.refreshToken;
      feedToken = resp.data.data.feedToken;
      multiOrchestrator.setAuthToken(authToken);
      res.json({ status: 'success', message: 'Token refreshed' });
    } else {
      throw new Error('Refresh failed');
    }
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── START SERVER ───────────────────────────────────────────
server.listen(config.server.port, config.server.host, () => {
  logger.info(`SOA Trader server running on http://${config.server.host}:${config.server.port}`);
  authenticate();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
