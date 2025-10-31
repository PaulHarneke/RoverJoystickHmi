'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const dotenv = require('dotenv');
const { WebSocketServer, WebSocket } = require('ws');

dotenv.config();

const PORT = parseInt(process.env.PORT, 10) || 8443;
const HOST = process.env.HOST || '0.0.0.0';
const HMI_ORIGIN = process.env.HMI_ORIGIN || 'https://169.254.75.59';
const CERT_PATH = process.env.CERT_PATH || path.join(__dirname, 'certs', 'server.crt');
const KEY_PATH = process.env.KEY_PATH || path.join(__dirname, 'certs', 'server.key');
const rawNodeRedUrl = process.env.NODE_RED_HTTP_URL || 'http://127.0.0.1:1880/joystick';
const NODE_RED_HTTP_URL = rawNodeRedUrl.trim();
const NODE_RED_ENABLED = NODE_RED_HTTP_URL.length > 0;
const NODE_RED_RETRY_COOLDOWN_MS = Number.parseInt(process.env.NODE_RED_RETRY_COOLDOWN_MS, 10) || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const HTTPS_OPTIONS = (() => {
  try {
    const cert = fs.readFileSync(path.resolve(CERT_PATH));
    const key = fs.readFileSync(path.resolve(KEY_PATH));
    return { cert, key }; 
  } catch (error) {
    console.error('[HTTPS] Failed to read certificate or key:', error);
    process.exit(1);
  }
})();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

let hmiHost = '169.254.75.59';
try {
  hmiHost = new URL(HMI_ORIGIN).host || hmiHost;
} catch (error) {
  console.warn('[Config] Failed to parse HMI_ORIGIN, falling back to default host:', error);
}

const cspDirectives = {
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", 'data:'],
  "font-src": ["'self'"],
  "connect-src": ["'self'", `wss://${hmiHost}:*`],
  "frame-ancestors": ["'self'", HMI_ORIGIN]
};

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: cspDirectives
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: false,
    hsts: NODE_ENV === 'production'
  })
);

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', `ALLOW-FROM ${HMI_ORIGIN}`);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: NODE_ENV === 'production' ? '1h' : 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-store');
  }
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: state.mode, timestamp: Date.now() });
});

const server = https.createServer(HTTPS_OPTIONS, app);

const wss = new WebSocketServer({ noServer: true });

const clients = new Set();

const initialStickState = { x: 0, y: 0, mag: 0, deg: 0 };
const state = {
  mode: 'automatic',
  stick: { ...initialStickState },
  ts: Date.now()
};

const NODE_RED_THROTTLE_MS = 50;
let lastNodeRedDispatch = 0;
let nodeRedTimeout = null;
let nodeRedNextAttemptAt = 0;
let nodeRedCooldownTimer = null;
let nodeRedSuppressedWarningLogged = false;

if (!NODE_RED_ENABLED) {
  console.info('[Node-RED] HTTP forwarding disabled. Set NODE_RED_HTTP_URL to enable.');
}

function broadcast(payload, exclude) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (exclude && client === exclude) {
      continue;
    }
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (error) {
        console.error('[WS] Broadcast error:', error);
      }
    }
  }
}

async function postToNodeRed(body) {
  if (!NODE_RED_ENABLED) {
    return;
  }

  const now = Date.now();
  if (nodeRedNextAttemptAt && now < nodeRedNextAttemptAt) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(NODE_RED_HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[Node-RED] HTTP ${response.status}:`, text);
    }
    nodeRedNextAttemptAt = 0;
    nodeRedSuppressedWarningLogged = false;
    if (nodeRedCooldownTimer) {
      clearTimeout(nodeRedCooldownTimer);
      nodeRedCooldownTimer = null;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('[Node-RED] Request timed out');
    } else {
      const errorCode = error?.cause?.code || error.code;
      if (errorCode === 'ECONNREFUSED') {
        nodeRedNextAttemptAt = Date.now() + NODE_RED_RETRY_COOLDOWN_MS;
        if (!nodeRedSuppressedWarningLogged) {
          console.warn(
            `[Node-RED] Unable to reach ${NODE_RED_HTTP_URL} (ECONNREFUSED). Suppressing requests for ${NODE_RED_RETRY_COOLDOWN_MS}ms.`
          );
          nodeRedSuppressedWarningLogged = true;
        }

        if (!nodeRedCooldownTimer) {
          const delay = Math.max(0, nodeRedNextAttemptAt - Date.now());
          nodeRedCooldownTimer = setTimeout(() => {
            nodeRedCooldownTimer = null;
            scheduleNodeRedPush();
          }, delay || NODE_RED_RETRY_COOLDOWN_MS);
          if (typeof nodeRedCooldownTimer.unref === 'function') {
            nodeRedCooldownTimer.unref();
          }
        }
      } else {
        console.error('[Node-RED] Request failed:', error);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleNodeRedPush() {
  if (!NODE_RED_ENABLED) {
    return;
  }

  const now = Date.now();

  const dispatch = () => {
    lastNodeRedDispatch = Date.now();
    nodeRedTimeout = null;
    if (nodeRedNextAttemptAt && Date.now() < nodeRedNextAttemptAt) {
      return;
    }
    const snapshot = {
      mode: state.mode,
      stick: state.stick,
      ts: state.ts,
      source: 'hmi-web'
    };
    postToNodeRed(snapshot).catch((error) => {
      console.error('[Node-RED] Unexpected error:', error);
    });
  };

  if (now - lastNodeRedDispatch >= NODE_RED_THROTTLE_MS) {
    dispatch();
    return;
  }

  if (nodeRedTimeout) {
    return;
  }

  const delay = Math.max(0, NODE_RED_THROTTLE_MS - (now - lastNodeRedDispatch));
  nodeRedTimeout = setTimeout(dispatch, delay);
}

scheduleNodeRedPush();

function updateState(newState) {
  state.mode = newState.mode ?? state.mode;
  state.stick = newState.stick ? { ...state.stick, ...newState.stick } : state.stick;
  state.ts = Date.now();
  scheduleNodeRedPush();
}

function validateMode(value) {
  return value === 'automatic' || value === 'manual';
}

function sanitizeNumber(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(-1, Math.min(1, num));
}

function normalizeStickPayload(payload) {
  const x = sanitizeNumber(payload.x);
  const y = sanitizeNumber(payload.y);
  const mag = Math.max(0, Math.min(1, Number.isFinite(payload.mag) ? Number(payload.mag) : Math.hypot(x, y)));
  let deg;
  if (Number.isFinite(payload.deg)) {
    deg = ((Number(payload.deg) % 360) + 360) % 360;
  } else {
    const rad = Math.atan2(y, x);
    deg = ((rad * (180 / Math.PI)) + 360) % 360;
  }
  return { x, y, mag, deg };
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.add(ws);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      console.warn('[WS] Invalid JSON received');
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'setMode': {
        if (!validateMode(message.mode)) {
          console.warn('[WS] Invalid mode received:', message.mode);
          return;
        }
        updateState({ mode: message.mode });
        broadcast({ type: 'mode', mode: state.mode, ts: state.ts });
        break;
      }
      case 'stick': {
        const stick = normalizeStickPayload(message);
        updateState({ stick });
        broadcast({ type: 'stick', stick: state.stick, ts: state.ts });
        break;
      }
      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('[WS] Client error:', error);
  });

  try {
    ws.send(
      JSON.stringify({
        type: 'state',
        mode: state.mode,
        stick: state.stick,
        ts: state.ts
      })
    );
  } catch (error) {
    console.error('[WS] Failed to send initial state:', error);
  }
});

const HEARTBEAT_INTERVAL = 30000;
const heartbeatTimer = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      try {
        ws.terminate();
      } catch (error) {
        console.error('[WS] Terminate error:', error);
      }
      continue;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      console.error('[WS] Ping error:', error);
    }
  }
}, HEARTBEAT_INTERVAL);

heartbeatTimer.unref();

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`HTTPS server listening on https://${HOST}:${PORT}`);
});

function shutdown() {
  console.log('Shutting down...');
  clearInterval(heartbeatTimer);
  for (const ws of clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch (error) {
      console.error('[WS] Close error:', error);
    }
  }
  server.close((error) => {
    if (error) {
      console.error('[Server] Close error:', error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
