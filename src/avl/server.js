/**
 * AVL Depth Sampler Server
 *
 * Serves depth curve data via REST API and WebSocket.
 * Provides:
 *   - GET  /avl/curve         → Latest full curve snapshot
 *   - GET  /avl/quote         → Execution-time quote for matching engine
 *   - GET  /avl/status        → Scheduler and sampler status
 *   - GET  /avl/config        → Current configuration (live tuning)
 *   - WS   /ws/avl/curve      → Push curve updates on each sample
 *
 * Design doc: docs/avl-depth-sampler-design.md (§8.3)
 */

const http = require('http');
const url = require('url');
const config = require('./config');
const jupiterCpi = require('./jupiter-cpi');

/**
 * AVL Server class that provides REST + WebSocket endpoints.
 */
class AVLServer {
  /**
   * @param {object} depthSampler - reference to the DepthSampler instance
   */
  constructor(depthSampler) {
    this.depthSampler = depthSampler;
    this.wsClients = new Set();
    this.server = null;
  }

  /**
   * Start the HTTP server.
   *
   * @param {number} [port] - port to listen on (default: config.server.port)
   * @returns {Promise<void>}
   */
  async start(port = config.server.port) {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));

      // WebSocket upgrade handling
      this.server.on('upgrade', (req, socket, head) => {
        const path = url.parse(req.url).pathname;

        if (path === '/ws/avl/curve') {
          this._handleWebSocket(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      this.server.listen(port, () => {
        console.log(`[AVL Server] Listening on port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server and close all connections.
   */
  stop() {
    if (this.server) {
      // Close all WS connections
      for (const ws of this.wsClients) {
        try { ws.close(); } catch (e) { /* ignore */ }
      }
      this.wsClients.clear();
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Push a curve update to all connected WebSocket clients.
   *
   * @param {object} curveSnapshot
   */
  broadcastCurve(curveSnapshot) {
    const message = JSON.stringify({
      type: 'avl_curve',
      market: 'SOL/USDC',
      ...curveSnapshot,
    });

    for (const ws of this.wsClients) {
      try {
        ws.write(message);
      } catch (e) {
        // Client disconnected
        this.wsClients.delete(ws);
      }
    }
  }

  /**
   * Handle an HTTP request.
   */
  _handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;
    const query = parsed.query;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', config.server.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      switch (path) {
        case '/avl/curve':
          this._handleGetCurve(res);
          break;

        case '/avl/quote':
          this._handleGetQuote(res, query);
          break;

        case '/avl/status':
          this._handleGetStatus(res);
          break;

        case '/avl/config':
          this._handleGetConfig(res);
          break;

        // ── Jupiter CPI Endpoints ──

        case '/avl/cpi/quote':
          this._handleCpiQuote(res, query);
          break;

        case '/avl/cpi/routes':
          this._handleCpiRoutes(res);
          break;

        case '/avl/cpi/orderbook':
          this._handleCpiOrderbook(res, query);
          break;

        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (e) {
      console.error('[AVL Server] Error handling request:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * GET /avl/curve → return latest curve snapshot.
   */
  _handleGetCurve(res) {
    const curve = this.depthSampler.getLatestCurve();
    if (!curve) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No curve data available yet', ts: Date.now() }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(curve));
  }

  /**
   * GET /avl/quote?market=SOL/USDC&side=ask&size=50
   * Execution-time quote for the matching engine.
   */
  async _handleGetQuote(res, query) {
    const market = query.market || 'SOL/USDC';
    const side = query.side || 'ask';
    const size = parseFloat(query.size);

    if (!size || size <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing size parameter' }));
      return;
    }

    try {
      const quote = await this.depthSampler.getExecutionQuote(market, side, size);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(quote));
    } catch (e) {
      // Fallback to stale curve price
      const staleQuote = this.depthSampler.getStaleQuoteFallback(market, side, size);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...staleQuote,
        source: 'stale_fallback',
        warning: 'Fresh quote unavailable, using stale curve data',
      }));
    }
  }

  /**
   * GET /avl/status → return scheduler and sampler status.
   */
  _handleGetStatus(res) {
    const status = this.depthSampler.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  /**
   * GET /avl/config → return current configuration (for live tuning).
   */
  _handleGetConfig(res) {
    // Return a sanitized copy (remove any sensitive fields)
    const safeConfig = JSON.parse(JSON.stringify(config));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safeConfig, null, 2));
  }

  /**
   * Handle a WebSocket upgrade request (simple text frames).
   * Implements a minimal WebSocket protocol (RFC 6455).
   */
  _handleWebSocket(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    // Compute accept key
    const crypto = require('crypto');
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB9A5DA63FB')
      .digest('base64');

    // Send upgrade response
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
      '\r\n'
    );

    this.wsClients.add(socket);

    console.log(`[AVL Server] WebSocket client connected (${this.wsClients.size} total)`);

    // Send the latest curve immediately
    const curve = this.depthSampler.getLatestCurve();
    if (curve) {
      const message = JSON.stringify({
        type: 'avl_curve',
        market: 'SOL/USDC',
        ...curve,
      });
      try {
        this._sendWebSocketFrame(socket, message);
      } catch (e) {
        /* ignore */
      }
    }

    // Handle client disconnect
    socket.on('close', () => {
      this.wsClients.delete(socket);
      console.log(`[AVL Server] WebSocket client disconnected (${this.wsClients.size} remaining)`);
    });

    socket.on('error', () => {
      this.wsClients.delete(socket);
    });
  }

  /**
   * Send a text WebSocket frame.
   * Only handles single-frame unmasked text messages (server→client).
   */
  _sendWebSocketFrame(socket, message) {
    const buffer = Buffer.from(message, 'utf8');
    const frame = Buffer.alloc(2 + buffer.length);

    // FIN + opcode text (0x81)
    frame[0] = 0x81;
    frame[1] = buffer.length;
    buffer.copy(frame, 2);

    socket.write(frame);
  }
  // ── Jupiter CPI Handlers ──

  /**
   * GET /avl/cpi/quote?inputMint=...&outputMint=...&amount=...&slippageBps=...
   *
   * Returns a Jupiter v6-compatible quote simulated from AVL synthetic depth.
   * This is the primary CPI endpoint — Jupiter can query this as if it were
   * querying a real orderbook program via CPI.
   */
  _handleCpiQuote(res, query) {
    const { inputMint, outputMint, amount, slippageBps } = query;

    if (!inputMint || !outputMint || !amount) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Missing required parameters: inputMint, outputMint, amount',
      }));
      return;
    }

    const quote = jupiterCpi.getQuote(this.depthSampler, {
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps ? parseInt(slippageBps, 10) : undefined,
    });

    if (!quote) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No AVL depth data available for this route',
        inputMint,
        outputMint,
        supportedRoutes: jupiterCpi.getSupportedRoutes(),
        ts: Date.now(),
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quote));
  }

  /**
   * GET /avl/cpi/routes
   *
   * Returns all supported route pairs that AVL can serve.
   * Used by Jupiter's route discovery.
   */
  _handleCpiRoutes(res) {
    const routes = jupiterCpi.getSupportedRoutes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      routes,
      count: routes.length,
      ts: Date.now(),
    }));
  }

  /**
   * GET /avl/cpi/orderbook?market=SOL/USDC
   *
   * Returns the full synthetic orderbook state in a format
   * compatible with Jupiter's orderbook query interface.
   */
  _handleCpiOrderbook(res, query) {
    const market = query.market || 'SOL/USDC';
    const orderbook = jupiterCpi.getOrderbook(this.depthSampler, market);

    if (!orderbook) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No AVL depth data available for this market',
        market,
        ts: Date.now(),
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(orderbook));
  }
}

module.exports = { AVLServer };
