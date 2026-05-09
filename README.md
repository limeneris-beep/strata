# acend v7

**Date:** 2026-05-10 05:11 UTC
**Name:** "Audited & Solidified"

## What's in v7

Full backend audit completed with 4 bugs fixed:

1. **AVL merge fix** — `mergeWithAVL()` now receives live AVL data instead of null (fixes empty on-chain order book segment)
2. **Balance validation** — Market orders validate balances before execution (prevents negative balances)
3. **Hardcoded volume removed** — No more `baseVolume = 100000` fallback; uses real volume data
4. **Duplicate route cleaned** — Redundant regex-based `/api/balances/:pubkey` route removed

## Files

- `server.js` — Main server with matching engine, WebSocket, REST APIs, AVL/MM/intents feeds
- `public/acend-v6.html` — v6 frontend (wallet, faucet, order book with segmented depth bars, chart)
- `src/avl/` — Automated Virtual Liquidity pipeline (curve, depth sampling, price feeds)
- `__tests__/` — AVL unit tests
- `package.json` / `package-lock.json` — Dependencies

## Key Architecture

- **Matching engine:** Built into server.js — limit, market, cancel orders
- **Liquidity feeds:** AVL (external pipeline), MM bot (in-process), user intents (in-process)
- **Price oracle:** Binance → server WS broadcast (guarded: rejects 0, NaN, >25% deviation)
- **Auth:** DEV bypass prefix (`DEV:`) for dev; Ed25519 signMessage for production
- **Balances:** Tracked in-memory; deposit/withdraw endpoints available

## Prior Release

v6 → `releases/v6-20260510-0206`

## Running

```bash
cd ~/hermes/projects/black-box/acend
cp releases/v7-20260510-0511/*.js .
cp releases/v7-20260510-0511/package*.json .
npm install
node server.js
# → http://localhost:8081/
```
