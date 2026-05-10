#!/usr/bin/env node
/**
 * strata unified server v2
 * WebSocket CLOB + HTTP REST + matching engine
 * Replaces server-unified.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const WebSocket = require('ws');

const PORT = 8081;
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVL_PORT = 4001;
const JUPITER_BASE = 'api.jup.ag';

// ─── Price feed (fetched from Binance) ───────────────────────────
let oraclePrice = 89.55; // fallback SOL/USDC
let oraclePriceLive = false; // set to true only after first successful fetch
// Cached AVL depth data (updated every 5s for order book merging)
let _cachedAVL = null;

// ─── MIME types ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── Helpers ─────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

function proxyExternal(req, res, targetHost, targetPath, targetPort = 443) {
  const opts = {
    hostname: targetHost, port: targetPort, path: targetPath,
    method: req.method, headers: { ...req.headers, host: targetHost },
    rejectUnauthorized: false,
  };
  const proxy = targetPort === 443 ? https.request(opts) : http.request(opts);
  proxy.on('response', (pres) => { cors(res); res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
  proxy.on('error', (e) => json(res, 502, { error: 'Proxy error: ' + e.message }));
  req.pipe(proxy);
}

function proxyLocal(res, avlPath) {
  const opts = { hostname: 'localhost', port: AVL_PORT, path: avlPath, method: 'GET' };
  const req = http.request(opts, (pres) => {
    cors(res);
    let body = '';
    pres.on('data', (c) => (body += c));
    pres.on('end', () => { res.writeHead(pres.statusCode, { 'Content-Type': 'application/json' }); res.end(body); });
  });
  req.on('error', () => json(res, 502, { error: 'AVL server unreachable' }));
  req.end();
}

function fetchAVL() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${AVL_PORT}/avl/curve`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════════
// TOKEN CONFIG
// ═══════════════════════════════════════════════════════════════════
const BASE_DECIMALS = 9;   // SOL
const QUOTE_DECIMALS = 6;  // USDC

// ═══════════════════════════════════════════════════════════════════
// MATCHING ENGINE
// ═══════════════════════════════════════════════════════════════════

let orderIdCounter = 0;
function nextOrderId() { orderIdCounter++; return `o${Date.now()}-${orderIdCounter}`; }

class MatchingEngine {
  constructor() {
    this.bids = [];       // [{ id, pubkey, price, size, filled, timestamp }] sorted price desc
    this.asks = [];       // [{ id, pubkey, price, size, filled, timestamp }] sorted price asc
    this.balances = {};   // pubkey → { base, quote, baseLocked, quoteLocked }
    this.trades = [];     // [{ price, size, side, timestamp, makerId, takerId }]
    this.connections = {}; // pubkey → ws
    this._priceCache = { bestBid: null, bestAsk: null };
  }

  // ── Balance ──────────────────────────────────────────────────
  creditBalance(pubkey, isBase, amount) {
    if (!this.balances[pubkey]) this.balances[pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
    if (isBase) this.balances[pubkey].base += amount;
    else this.balances[pubkey].quote += amount;
    this._pushBalance(pubkey);
  }

  debitBalance(pubkey, isBase, amount) {
    if (!this.balances[pubkey]) this.balances[pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
    if (isBase) {
      if (this.balances[pubkey].base < amount) throw new Error('Insufficient base balance');
      this.balances[pubkey].base -= amount;
    } else {
      if (this.balances[pubkey].quote < amount) throw new Error('Insufficient quote balance');
      this.balances[pubkey].quote -= amount;
    }
    this._pushBalance(pubkey);
  }

  _pushBalance(pubkey) {
    const ws = this.connections[pubkey];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'balance', data: this.getBalance(pubkey) }));
    }
  }

  getBalance(pubkey) {
    const b = this.balances[pubkey] || { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
    return {
      base: b.base, quote: b.quote,
      baseLocked: b.baseLocked, quoteLocked: b.quoteLocked,
      baseAvailable: b.base - b.baseLocked,
      quoteAvailable: b.quote - b.quoteLocked,
    };
  }

  // ── Order Placement ──────────────────────────────────────────
  placeLimitOrder(pubkey, side, price, size) {
    const id = nextOrderId();
    const order = { id, pubkey, price, size, filled: 0, timestamp: Date.now() };

    // Lock funds
    if (side === 'bid') {
      const bal = this.balances[pubkey] || { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
      // price in quote atomic (6 decimals), size in base atomic (9 decimals)
      // cost = price * (size / 10^BASE_DECIMALS) in quote atomic
      const required = Math.floor(price * size / Math.pow(10, BASE_DECIMALS));
      if (bal.quote - bal.quoteLocked < required) throw new Error('Insufficient quote balance');
      if (!this.balances[pubkey]) this.balances[pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
      this.balances[pubkey].quoteLocked += required;
    } else {
      const bal = this.balances[pubkey] || { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
      if (bal.base - bal.baseLocked < size) throw new Error('Insufficient base balance');
      if (!this.balances[pubkey]) this.balances[pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
      this.balances[pubkey].baseLocked += size;
    }

    // Insert in sorted order
    if (side === 'bid') {
      this.bids.push(order);
      this.bids.sort((a, b) => b.price - a.price || a.timestamp - b.timestamp);
    } else {
      this.asks.push(order);
      this.asks.sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);
    }

    // Attempt CLOB matching
    const fills = this._match();
    
    // If order still has remaining size, try matching against AVL liquidity
    if (order.filled < order.size) {
      const avlFills = this._matchAVL(side, price, order.size - order.filled, order, pubkey);
      fills.push(...avlFills);
    }

    return { id, resting: order.filled < order.size, fills };
  }

  _broadcastIfNeeded() {
    // Called externally after place_order/cancel to push merged OB immediately
    this._broadcastOrderBook();
  }

  placeMarketOrder(pubkey, side, size) {
    // Validate sufficient balance before processing
    const bal = this.balances[pubkey] || { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
    if (side === 'bid') {
      // Estimate max cost at worst price (highest ask)
      const worstPrice = this.asks.length > 0 ? this.asks[this.asks.length - 1].price : (oraclePrice || 100) * 1e6;
      const maxCost = Math.floor(size * worstPrice / Math.pow(10, BASE_DECIMALS));
      if (bal.quote - bal.quoteLocked < maxCost) throw new Error('Insufficient quote balance');
    } else {
      if (bal.base - bal.baseLocked < size) throw new Error('Insufficient base balance');
    }

    const fills = [];
    let remaining = size;

    const oppositeBook = side === 'bid' ? this.asks : this.bids;

    for (const order of oppositeBook) {
      if (remaining <= 0) break;
      if (order.pubkey === pubkey) continue; // no self-trade
      const avail = order.size - order.filled;
      const fillSize = Math.min(remaining, avail);
      if (fillSize <= 0) continue;

      const fillPrice = order.price;
      order.filled += fillSize;
      remaining -= fillSize;

      // Calculate cost: fillSize (base atomic) * fillPrice (quote atomic) / 10^BASE_DECIMALS
      const cost = Math.floor(fillSize * fillPrice / Math.pow(10, BASE_DECIMALS));
      const fee = Math.floor(cost * 0.001); // 10 bps

      // Execute the trade
      if (!this.balances[pubkey]) this.balances[pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
      if (!this.balances[order.pubkey]) this.balances[order.pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };

      if (side === 'bid') {
        // Taker buys base, pays quote
        this.balances[pubkey].quote -= (cost + fee);
        this.balances[pubkey].base += fillSize;
        // Maker (asker) gets quote, loses base
        this.balances[order.pubkey].quote += cost;
        this.balances[order.pubkey].baseLocked -= fillSize;
        this.balances[order.pubkey].base -= fillSize;
      } else {
        // Taker sells base, gets quote
        this.balances[pubkey].base -= fillSize;
        this.balances[pubkey].quote += (cost - fee);
        // Maker (bidder) gets base, loses locked quote
        this.balances[order.pubkey].base += fillSize;
        this.balances[order.pubkey].quoteLocked -= cost;
      }

      const trade = {
        id: `t${Date.now()}-${fills.length}`,
        price: fillPrice, size: fillSize,
        side: side === 'bid' ? 'buy' : 'sell',
        timestamp: Date.now(),
        makerId: order.id, takerPubkey: pubkey,
      };
      fills.push(trade);
      this.trades.unshift(trade);
      if (this.trades.length > 200) this.trades.pop();

      // Notify maker
      const makerWs = this.connections[order.pubkey];
      if (makerWs && makerWs.readyState === WebSocket.OPEN) {
        makerWs.send(JSON.stringify({ type: 'fill', order_id: order.id, size: fillSize, price: fillPrice, maker: true }));
      }
    }

    // Remove fully filled orders
    this.bids = this.bids.filter(o => o.filled < o.size);
    this.asks = this.asks.filter(o => o.filled < o.size);

    // If market order still has remaining, try AVL
    if (remaining > 0) {
      const avlFills = this._matchAVL(side, 0, remaining, null, pubkey);
      fills.push(...avlFills);
    }

    this._pushBalance(pubkey);
    this._broadcastOrderBook();

    return { id: nextOrderId(), resting: false, fills, remaining };
  }

  _match() {
    const fills = [];
    while (this.bids.length > 0 && this.asks.length > 0) {
      const bestBid = this.bids[0];
      const bestAsk = this.asks[0];
      if (bestBid.price < bestAsk.price) break; // no crossing

      if (bestBid.pubkey === bestAsk.pubkey) {
        // Self-trade prevention: remove the newer order
        if (bestBid.timestamp > bestAsk.timestamp) this.bids.shift();
        else this.asks.shift();
        continue;
      }

      const fillPrice = bestAsk.price; // match at ask price
      const bidRemaining = bestBid.size - bestBid.filled;
      const askRemaining = bestAsk.size - bestAsk.filled;
      const fillSize = Math.min(bidRemaining, askRemaining);

      // Execute
      const cost = Math.floor(fillSize * fillPrice / Math.pow(10, BASE_DECIMALS));
      const fee = Math.floor(cost * 0.001);

      if (!this.balances[bestBid.pubkey]) this.balances[bestBid.pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };
      if (!this.balances[bestAsk.pubkey]) this.balances[bestAsk.pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };

      // Bidder: pays quote, gets base
      this.balances[bestBid.pubkey].quoteLocked -= cost;
      this.balances[bestBid.pubkey].base += fillSize;
      this.balances[bestBid.pubkey].quote -= fee;

      // Asker: gets quote, loses base
      this.balances[bestAsk.pubkey].baseLocked -= fillSize;
      this.balances[bestAsk.pubkey].quote += (cost - fee);
      this.balances[bestAsk.pubkey].base -= fillSize;

      bestBid.filled += fillSize;
      bestAsk.filled += fillSize;

      const trade = {
        id: `t${Date.now()}-${fills.length}`,
        price: fillPrice, size: fillSize,
        side: 'buy',
        timestamp: Date.now(),
        makerAskId: bestAsk.id, takerBidId: bestBid.id,
      };
      fills.push(trade);
      this.trades.unshift(trade);
      if (this.trades.length > 200) this.trades.pop();

      // Notify both parties
      [bestBid.pubkey, bestAsk.pubkey].forEach(pk => {
        const ws = this.connections[pk];
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'fill', order_id: bestBid.id, size: fillSize, price: fillPrice, maker: pk === bestAsk.pubkey }));
        }
      });

      // Remove fully filled
      if (bestBid.filled >= bestBid.size) this.bids.shift();
      if (bestAsk.filled >= bestAsk.size) this.asks.shift();
    }
    return fills;
  }

  // ── AVL Liquidity Matching ───────────────────────────────────
  // Fills remaining order size against cached AVL (Jupiter) depth
  _matchAVL(side, limitPrice, remaining, order, pubkey) {
    const fills = [];
    if (!_cachedAVL || remaining <= 0) return fills;

    const avlSide = side === 'bid' ? _cachedAVL.asks : _cachedAVL.bids;
    if (!avlSide || avlSide.length === 0) return fills;

    for (const level of avlSide) {
      if (remaining <= 0) break;

      const avlPrice = typeof level.price === 'number' ? level.price : level[0];
      const avlSize = typeof level.size === 'number' ? level.size : level[1];
      
      // Check if order crosses this AVL level
      if (side === 'bid') {
        // Buying: limit price must be >= AVL ask price (or market order)
        if (limitPrice > 0 && limitPrice < avlPrice * 1e6) break;
      } else {
        // Selling: limit price must be <= AVL bid price (or market order)
        if (limitPrice > 0 && limitPrice > avlPrice * 1e6) break;
      }

      const fillSizeAtomic = Math.min(remaining, Math.floor(avlSize * 1e9));
      if (fillSizeAtomic <= 0) continue;

      const fillPriceAtomic = Math.floor(avlPrice * 1e6);
      const cost = Math.floor(fillSizeAtomic * fillPriceAtomic / 1e9);
      const fee = Math.floor(cost * 0.001);

      if (!this.balances[pubkey]) this.balances[pubkey] = { base: 0, quote: 0, baseLocked: 0, quoteLocked: 0 };

      if (side === 'bid') {
        this.balances[pubkey].quote -= (cost + fee);
        this.balances[pubkey].base += fillSizeAtomic;
      } else {
        this.balances[pubkey].base -= fillSizeAtomic;
        this.balances[pubkey].quote += (cost - fee);
      }

      remaining -= fillSizeAtomic;
      
      const fill = {
        id: `avl-${Date.now()}-${fills.length}`,
        price: fillPriceAtomic, size: fillSizeAtomic,
        side: side === 'bid' ? 'buy' : 'sell',
        timestamp: Date.now(),
        source: 'avl',
      };
      fills.push(fill);
      this.trades.unshift(fill);
      if (this.trades.length > 200) this.trades.pop();

      // Update the resting order if it exists
      if (order) order.filled += fillSizeAtomic;
    }
    return fills;
  }

  // ── Cancel ────────────────────────────────────────────────────
  cancelOrder(pubkey, orderId, side) {
    const book = side === 'bid' ? this.bids : this.asks;
    const idx = book.findIndex(o => o.id === orderId && o.pubkey === pubkey);
    if (idx === -1) return { success: false, reason: 'Order not found' };

    const order = book[idx];
    const remaining = order.size - order.filled;
    book.splice(idx, 1);

    // Unlock funds
    const bal = this.balances[pubkey];
    if (bal) {
      if (side === 'bid') {
        const cost = Math.floor(remaining * order.price / Math.pow(10, BASE_DECIMALS));
        bal.quoteLocked -= cost;
      } else {
        bal.baseLocked -= remaining;
      }
    }

    this._pushBalance(pubkey);
    this._broadcastOrderBook();
    return { success: true };
  }

  // ─── Order Book Snapshot ───────────────────────────────────────
  getOrderBookSnapshot(depth = 15) {
    const groupBids = this._groupByPrice(this.bids, depth);
    const groupAsks = this._groupByPrice(this.asks, depth);
    const bestBid = this.bids.length > 0 ? this.bids[0].price : null;
    const bestAsk = this.asks.length > 0 ? this.asks[0].price : null;
    return { bids: groupBids, asks: groupAsks, bestBid, bestAsk };
  }

  // Merge CLOB orders with AVL depth + MM bot for full order book
  mergeWithAVL(clobSnap, avlData) {
    const clobBids = clobSnap.bids.map(b => [b[0], b[1], 'clob', 'real']);
    const clobAsks = clobSnap.asks.map(a => [a[0], a[1], 'clob', 'real']);

    const mid = (avlData && avlData.midPrice) || oraclePrice || 89.55;

    // ── Real AVL depth (from Jupiter on-chain sampler) ──
    let avlBids = [], avlAsks = [];
    const hasAvl = avlData && (avlData.bids?.length > 0 || avlData.asks?.length > 0);
    if (hasAvl) {
      // Convert AVL objects to [price, size, source, type] arrays
      avlBids = (avlData.bids || []).map(b => [
        typeof b.price === 'number' ? b.price : parseFloat(b.price),
        typeof b.size === 'number' ? b.size : parseFloat(b.size),
        'avl', 'virtual'
      ]);
      avlAsks = (avlData.asks || []).map(a => [
        typeof a.price === 'number' ? a.price : parseFloat(a.price),
        typeof a.size === 'number' ? a.size : parseFloat(a.size),
        'avl', 'virtual'
      ]);
    } else {
      // Fallback: synthetic AVL (10 levels, 0.8% to 5% from mid)
      for (let i = 0; i < 10; i++) {
        const spread = 0.8 + i * 0.45;
        const size = 5 + Math.random() * 8;
        avlBids.push([+(mid * (1 - spread/100)).toFixed(2), +size.toFixed(2), 'avl', 'virtual']);
        avlAsks.push([+(mid * (1 + spread/100)).toFixed(2), +size.toFixed(2), 'avl', 'virtual']);
      }
    }

    // ── MM bot orders: tight around mid ──
    const mmBids = [], mmAsks = [];
    for (let i = 0; i < 12; i++) {
      const spread = 0.03 + i * 0.12;
      const size = 2 + Math.random() * 5;
      mmBids.push([+(mid * (1 - spread/100)).toFixed(2), +size.toFixed(2), 'mm-bot', 'mm']);
      mmAsks.push([+(mid * (1 + spread/100)).toFixed(2), +size.toFixed(2), 'mm-bot', 'mm']);
    }

    // CLOB closest to mid, then MM, then AVL outer
    const allBids = [...clobBids, ...mmBids, ...avlBids].sort((a, b) => b[0] - a[0]);
    const allAsks = [...clobAsks, ...mmAsks, ...avlAsks].sort((a, b) => a[0] - b[0]);

    // Enforce minimum spread: trim inner levels that cross the book
    const bestBid = allBids[0]?.[0] || 0;
    const bestAsk = allAsks[0]?.[0] || Infinity;
    const minSpread = mid * 0.0001; // 1 bp minimum spread
    if (bestAsk - bestBid < minSpread) {
      const fairMid = (bestBid + bestAsk) / 2;
      // Trim bids above fairMid and asks below fairMid
      const cleanBids = allBids.filter(b => b[0] < fairMid);
      const cleanAsks = allAsks.filter(a => a[0] > fairMid);
      if (cleanBids.length > 0 && cleanAsks.length > 0) {
        return { bids: cleanBids, asks: cleanAsks, bestBid: cleanBids[0][0], bestAsk: cleanAsks[0][0] };
      }
    }

    return { bids: allBids, asks: allAsks, bestBid: allBids[0]?.[0] || null, bestAsk: allAsks[0]?.[0] || null };
  }

  // Interpolate sparse AVL levels to fill every tick for smooth orderbook display
  _interpolateAVL(levels, side, tickSize) {
    if (levels.length < 2) return levels;
    const sorted = [...levels].sort((a, b) => side === 'ask' ? a[0] - b[0] : b[0] - a[0]);
    const result = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i], next = sorted[i + 1];
      result.push(curr);
      const priceGap = Math.abs(next[0] - curr[0]);
      if (priceGap > tickSize * 1.1) {
        const steps = Math.round(priceGap / tickSize);
        // Linear size interpolation: smooth taper between curr and next
        const sizeDelta = (next[1] - curr[1]) / steps;
        for (let s = 1; s < steps; s++) {
          const interpPrice = side === 'ask'
            ? +(curr[0] + s * tickSize).toFixed(4)
            : +(curr[0] - s * tickSize).toFixed(4);
          const interpSize = +(curr[1] + s * sizeDelta).toFixed(4);
          result.push([interpPrice, interpSize, curr[2], curr[3]]);
        }
      }
    }
    result.push(sorted[sorted.length - 1]);
    return result;
  }

  _groupByPrice(orders, depth) {
    const map = {};
    for (const o of orders) {
      const remaining = o.size - o.filled;
      if (remaining <= 0) continue;
      map[o.price] = (map[o.price] || 0) + remaining;
    }
    return Object.entries(map)
      .map(([price, size]) => [parseInt(price), size])
      .sort((a, b) => b[0] - a[0])
      .slice(0, depth);
  }

  _broadcastOrderBook() {
    const snap = this.getOrderBookSnapshot();
    const merged = this.mergeWithAVL(snap, _cachedAVL);
    const msg = JSON.stringify({
      type: 'order_book_update',
      bids: merged.bids,
      asks: merged.asks,
    });
    Object.values(this.connections).forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }

  // ── Auth ──────────────────────────────────────────────────────
  verifyAuth(pubkey, signature, message) {
    try {
      const pkBytes = base58Decode(pubkey);
      const sigBytes = base58Decode(signature);
      const msgBytes = new TextEncoder().encode(message);
      return nacl.sign.detached.verify(msgBytes, sigBytes, pkBytes);
    } catch (e) {
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BASE58 (Bitcoin alphabet)
// ═══════════════════════════════════════════════════════════════════
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  let num = 0n;
  for (const c of str) {
    const idx = B58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('Non-base58 character: ' + c);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ═══════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════

const engine = new MatchingEngine();

// ═══════════════════════════════════════════════════════════════════
// V5 LIQUIDITY FEED GENERATORS
// ═══════════════════════════════════════════════════════════════════

// ─── MM Order Generator ───────────────────────────────────────────
// 30 levels at 1.0 steps (±$30), scaled to match intent/onchain visibility
let _mmSeed = 0;
let _mmBids = [], _mmAsks = [];
function generateMMOrders(mid) {
  _mmSeed += 0.03;
  const bids = [], asks = [];
  for (let i = 1; i <= 30; i++) {
    const offset = +i.toFixed(2); // 1.0 steps — align with tickSize=1 buckets
    const size = +(70 * Math.exp(-i * 0.15) + Math.sin(_mmSeed + i) * 5).toFixed(1);
    bids.push({ price: +(mid - offset).toFixed(2), size: Math.max(0.1, size) });
    asks.push({ price: +(mid + offset).toFixed(2), size: Math.max(0.1, size) });
  }
  _mmBids = bids; _mmAsks = asks;
  return { bids, asks };
}

// ─── Intent Order Generator ───────────────────────────────────────
// 30 levels at 1.0 steps (±$30), large lumpy sizes
let _intentSeed = 0;
let _intentBids = [], _intentAsks = [];
function generateIntentOrders(mid) {
  _intentSeed += 0.008;
  const bids = [], asks = [];
  for (let i = 1; i <= 30; i++) {
    const offset = +i.toFixed(2); // 1.0 steps — align with tickSize=1 buckets
    const baseSize = 55 * Math.exp(-i * 0.12);
    const noise = (Math.sin(_intentSeed * 2 + i) + 1) * 8;
    const size = +(baseSize + noise).toFixed(1);
    bids.push({ price: +(mid - offset).toFixed(2), size: Math.max(0.1, size) });
    asks.push({ price: +(mid + offset).toFixed(2), size: Math.max(0.1, size) });
  }
  _intentBids = bids; _intentAsks = asks;
  return { bids, asks };
}

// ─── Price Polling (Binance + fallback) ─────────────────────────
function pollPrice() {
  https.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDC', (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try { oraclePrice = parseFloat(JSON.parse(body).price) || oraclePrice; oraclePriceLive = true; } catch (e) {}
    });
  }).on('error', () => {
    // Binance blocked in WSL — keep fallback
  });
}
pollPrice();
setInterval(pollPrice, 5000);

// ─── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // Jupiter proxy
  if (pathname.startsWith('/api/jupiter/')) return proxyExternal(req, res, JUPITER_BASE, pathname.replace('/api/jupiter', ''));
  // AVL proxy
  if (pathname.startsWith('/avl/')) return proxyLocal(res, req.url);
  // Health
  if (pathname === '/health') return json(res, 200, { status: 'ok', uptime: process.uptime(), orders: engine.bids.length + engine.asks.length });
  // Config
  if (pathname === '/api/config') return json(res, 200, { rpc_url: 'https://api.devnet.solana.com', program_id: '4EoitT7wRJjQ5YZF8HEMEDY2RUvcWeJVZVTNNZVFf73x', base_mint: '8pUe1hAiihSjsCDRXGSFPKbQdMAW4k57W88MsUJiUDmo', quote_mint: '76xKuTjqVR924udCbjtWStsRutMLnw8LrNAUgzEWtznK' });

  // Order book (merged AVL + CLOB)
  if (pathname === '/api/orderbook') {
    const clobSnap = engine.getOrderBookSnapshot();
    const merged = engine.mergeWithAVL(clobSnap, _cachedAVL);
    const mid = (_cachedAVL && _cachedAVL.midPrice) || oraclePrice || 89.55;
    return json(res, 200, {
      ...merged,
      spread: merged.bestAsk && merged.bestBid ? merged.bestAsk - merged.bestBid : 0,
      mid_price: mid, source: _cachedAVL ? 'jupiter+clob+mm' : 'clob+mm+avl', ts: Date.now(),
    });
  }

  // Stats
  if (pathname === '/api/stats') {
    try {
      const vol24h = engine.trades.reduce((s, t) => s + t.size * t.price, 0);
      return json(res, 200, {
        mark_price: oraclePrice || 89.55,
        spread: 0,
        volume_24h: vol24h,
        change_24h: 0,
        source: 'synthetic',
      });
    } catch (e) {
      return json(res, 200, { mark_price: oraclePrice || 89.55, volume_24h: 0, change_24h: 0, source: 'fallback' });
    }
  }

  // Recent trades (real + mock)
  if (pathname === '/api/trades/recent') {
    const trades = engine.trades.slice(0, 20).map(t => ({
      price: t.price / 1e6,
      size: t.size / 1e9,
      side: t.side,
      time: new Date(t.timestamp).toISOString(),
    }));
    if (trades.length < 5) {
      for (let i = trades.length; i < 20; i++) {
        const p = (oraclePrice || 85) + (Math.random() - 0.5) * 0.5;
        trades.push({ price: +p.toFixed(2), size: +(Math.random() * 3).toFixed(2), side: Math.random() > 0.5 ? 'buy' : 'sell', time: new Date(Date.now() - i * 15000).toISOString() });
      }
    }
    return json(res, 200, trades);
  }

  // Candles
  if (pathname === '/api/trades/candles') {
    const interval = parsed.query.interval || '15m';
    const limit = Math.min(parseInt(parsed.query.limit) || 100, 200);
    const basePrice = oraclePrice || 85;
    const candles = [];
    const intervalMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1H': 3600000, '4H': 14400000, '1D': 86400000, '1W': 604800000 }[interval] || 900000;
    for (let i = limit; i >= 0; i--) {
      const open = basePrice + (Math.random() - 0.5) * 3;
      const close = open + (Math.random() - 0.5) * 2;
      candles.push({
        time: Date.now() - i * intervalMs,
        open: +open.toFixed(2), high: +(Math.max(open, close) + Math.random()).toFixed(2),
        low: +(Math.min(open, close) - Math.random()).toFixed(2), close: +close.toFixed(2),
        volume: +(Math.random() * 50).toFixed(1),
      });
    }
    return json(res, 200, candles);
  }

  // Deposit notification (called by clob.js after on-chain confirmation)
  if (pathname === '/api/deposit/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pubkey, amount, is_base } = JSON.parse(body);
        engine.creditBalance(pubkey, is_base, amount);
        console.log(`[deposit] ${pubkey.slice(0,8)}... ${is_base?'BASE':'QUOTE'} +${amount}`);
        return json(res, 200, { success: true, new_balance: engine.getBalance(pubkey) });
      } catch (e) {
        return json(res, 400, { success: false, error: e.message });
      }
    });
    return;
  }

  // Withdraw notification (called by clob.js after on-chain confirmation)
  if (pathname === '/api/withdraw/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pubkey, amount, is_base } = JSON.parse(body);
        engine.debitBalance(pubkey, is_base, amount);
        console.log(`[withdraw] ${pubkey.slice(0,8)}... ${is_base?'BASE':'QUOTE'} -${amount}`);
        return json(res, 200, { success: true, new_balance: engine.getBalance(pubkey) });
      } catch (e) {
        return json(res, 400, { success: false, error: e.message });
      }
    });
    return;
  }

  // Balance query (REST — used by frontend fetchBalances)
  if (pathname.startsWith('/api/balances/') && req.method === 'GET') {
    const pubkey = pathname.replace('/api/balances/', '');
    try {
      const b = engine.getBalance(pubkey);
      return json(res, 200, {
        base:    { available: b.baseAvailable,    locked: b.baseLocked,    total: b.base },
        quote:   { available: b.quoteAvailable,   locked: b.quoteLocked,   total: b.quote },
      });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // Dev faucet (credits test balances without on-chain tx)
  if (pathname === '/api/faucet' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pubkey } = JSON.parse(body);
        if (!pubkey) return json(res, 400, { error: 'pubkey required' });
        engine.creditBalance(pubkey, true, 100 * Math.pow(10, BASE_DECIMALS));   // 100 SOL
        engine.creditBalance(pubkey, false, 50000 * Math.pow(10, QUOTE_DECIMALS)); // 50,000 USDC
        console.log(`[faucet] ${pubkey.slice(0,8)}... +100 SOL +50000 USDC`);
        return json(res, 200, { success: true, balance: engine.getBalance(pubkey) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Dev test: place order via REST (bypasses WebSocket auth for debugging)
  if (pathname === '/api/dev/order' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pubkey, side, price, size } = JSON.parse(body);
        if (!pubkey || !side || !price || !size) return json(res, 400, { error: 'pubkey, side, price, size required' });
        const result = engine.placeLimitOrder(pubkey, side, price, size);
        engine._broadcastOrderBook();
        return json(res, 200, { success: true, order: result });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // ─── V5 Liquidity Feed Endpoints ──────────────────────────────────
  // Three independent feeds for the v5 frontend segmented depth bars.
  // Each returns { bids: [{price, size}], asks: [{price, size}] }
  // Price = USD float, size = token float — no scaling needed.

  // Feed 1: On-chain / AVL (dark bar, right side)
  if (pathname === '/api/feed/onchain') {
    const mid = (_cachedAVL && _cachedAVL.midPrice) || oraclePrice || 89.55;
    let bids = [], asks = [];
    
    if (_cachedAVL && (_cachedAVL.bids?.length > 0 || _cachedAVL.asks?.length > 0)) {
      // Real AVL data from Jupiter sampler — scaled to match MM/intent display scale
      // AVL has ~100 fine-grained levels; with tickSize=1.0 they pack 10-15x denser
      // than MM/intents (1 level/bucket). Scale down so all three feeds are comparable.
      const SCALE = 0.55;
      bids = (_cachedAVL.bids || []).map(l => ({
        price: typeof l.price === 'number' ? l.price : parseFloat(l.price),
        size: +((typeof l.size === 'number' ? l.size : parseFloat(l.size)) * SCALE).toFixed(1),
      }));
      asks = (_cachedAVL.asks || []).map(l => ({
        price: typeof l.price === 'number' ? l.price : parseFloat(l.price),
        size: +((typeof l.size === 'number' ? l.size : parseFloat(l.size)) * SCALE).toFixed(1),
      }));
    } else {
      // Fallback: synthetic depth (wide, large — AVL style)
      for (let i = 0; i < 12; i++) {
        const spreadPct = 0.8 + i * 0.7;
        const size = +(25 * Math.exp(-i * 0.2)).toFixed(1);
        bids.push({ price: +(mid * (1 - spreadPct / 100)).toFixed(2), size });
        asks.push({ price: +(mid * (1 + spreadPct / 100)).toFixed(2), size });
      }
    }
    return json(res, 200, { bids, asks, midPrice: mid, ts: Date.now() });
  }

  // Feed 2: MM Orders (mid bar, center)
  if (pathname === '/api/feed/mm-orders') {
    const mid = (_cachedAVL && _cachedAVL.midPrice) || oraclePrice || 89.55;
    const { bids, asks } = generateMMOrders(mid);
    return json(res, 200, { bids, asks, ts: Date.now() });
  }

  // Feed 3: Intents (light bar, left side)
  if (pathname === '/api/feed/intents') {
    const mid = (_cachedAVL && _cachedAVL.midPrice) || oraclePrice || 89.55;
    const { bids, asks } = generateIntentOrders(mid);
    return json(res, 200, { bids, asks, ts: Date.now() });
  }

  // Static files
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'acend-v6.html' : pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(PUBLIC_DIR, 'acend-v6.html');
  serveFile(res, filePath);
});

// ─── WebSocket ────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let authenticatedPubkey = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (msg.type) {
      case 'auth': {
        const { pubkey, signature, message } = msg;
        // DEV MODE: skip signature verification for testing (message starts with "DEV:")
        const isDev = message && message.startsWith('DEV:');
        const valid = isDev || engine.verifyAuth(pubkey, signature, message);
        if (valid) {
          authenticatedPubkey = pubkey;
          engine.connections[pubkey] = ws;
          ws.send(JSON.stringify({ type: 'auth_result', success: true, message: 'Authenticated' }));
          ws.send(JSON.stringify({ type: 'balance', data: engine.getBalance(pubkey) }));
          // Send current order book (merged with synthetic AVL + MM)
          const snap = engine.getOrderBookSnapshot();
          const merged = engine.mergeWithAVL(snap, _cachedAVL);
          ws.send(JSON.stringify({ type: 'order_book_update', bids: merged.bids, asks: merged.asks }));
          console.log(`[ws] auth OK: ${pubkey.slice(0,8)}...`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_result', success: false, message: 'Invalid signature' }));
        }
        break;
      }

      case 'place_order': {
        if (!authenticatedPubkey) { ws.send(JSON.stringify({ type: 'order_rejected', reason: 'Not authenticated' })); return; }
        const { side, price, size, order_type } = msg;
        try {
          let result;
          if (order_type === 'market') {
            result = engine.placeMarketOrder(authenticatedPubkey, side, size);
          } else {
            result = engine.placeLimitOrder(authenticatedPubkey, side, price, size);
          }
          ws.send(JSON.stringify({ type: 'order_accepted', order_id: result.id, resting: result.resting }));
          // Send fills
          if (result.fills) {
            result.fills.forEach(f => {
              ws.send(JSON.stringify({ type: 'fill', order_id: f.makerAskId || f.makerId || '', size: f.size, price: f.price, maker: false }));
            });
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: 'order_rejected', reason: e.message }));
        }
        engine._broadcastOrderBook();
        break;
      }

      case 'cancel_order': {
        if (!authenticatedPubkey) { ws.send(JSON.stringify({ type: 'cancel_rejected', order_id: msg.order_id, reason: 'Not authenticated' })); return; }
        const result = engine.cancelOrder(authenticatedPubkey, msg.order_id, msg.side);
        if (result.success) {
          ws.send(JSON.stringify({ type: 'order_cancelled', order_id: msg.order_id }));
        } else {
          ws.send(JSON.stringify({ type: 'cancel_rejected', order_id: msg.order_id, reason: result.reason }));
        }
        break;
      }

      case 'get_orderbook': {
        const snap = engine.getOrderBookSnapshot(msg.depth || 20);
        const merged = engine.mergeWithAVL(snap, _cachedAVL);
        ws.send(JSON.stringify({ type: 'order_book_update', bids: merged.bids, asks: merged.asks }));
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type: ' + msg.type }));
    }
  });

  ws.on('close', () => {
    if (authenticatedPubkey) delete engine.connections[authenticatedPubkey];
  });
});

// ─── Start ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`strata v2 server → http://localhost:${PORT}`);
  console.log(`  WebSocket /ws  — CLOB matching engine`);
  console.log(`  REST /api/*    — orderbook, stats, trades, balances`);
  console.log(`  AVL proxy /avl → localhost:${AVL_PORT}`);
});

// Broadcast order book every 2 seconds
setInterval(() => engine._broadcastOrderBook(), 2000);
// Cache AVL depth every 5 seconds for order book merging
setInterval(async () => {
  try { _cachedAVL = await fetchAVL(); } catch (e) { /* stale cache is fine */ }
}, 5000);
// Initial AVL fetch
fetchAVL().then(d => _cachedAVL = d).catch(() => {});
// Push oracle price to all clients (only after first real fetch)
setInterval(() => {
  if (!oraclePrice || !oraclePriceLive) return;
  const msg = JSON.stringify({ type: 'oracle_price', price: oraclePrice });
  Object.values(engine.connections).forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}, 3000);

console.log('[engine] Matching engine ready');
