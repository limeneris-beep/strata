# Acend

**The order book Solana never had.**

[![Status](https://img.shields.io/badge/status-devnet_live-brightgreen)](#)
[![Built on Solana](https://img.shields.io/badge/built_on-Solana-blue)](#)
[![Colosseum Hackathon 2026](https://img.shields.io/badge/Colosseum-2026-purple)](#)

> $1.6T on-chain volume. Zero real spot exchanges.  
> Acend is the first order book DEX on Solana that doesn't look empty — ever.

---

## What Is Acend?

Acend is a next-generation order book DEX built on Solana. It combines **three liquidity layers** into one unified book:

```
Layer 1 ████████  REAL LIMIT ORDERS (green/red)
        User orders escrowed on-chain. Hard commitment. Highest priority.

Layer 2 ░░░░░░░░  INTENT ORDERS (gold)
        Trusted MM soft RFQ commitments. Reputation-backed.

Layer 3 ▓▓▓▓▓▓▓▓  AVL — AGGREGATED VIRTUALIZED LIQUIDITY (gray)
        Jupiter/AMM mirrored depth. Universal fallback. Guaranteed fills.
```

**Every taker order routes through priority: real → intents → AVL fallback ensures 100% fill.**

No other Solana DEX shows you all three.

---

## Why It Matters

**The Problem:** Solana is the world's #2 spot venue behind only Binance — $1.6T on-chain volume in 2025, ahead of Coinbase, Bybit, and Bitget. SOL/USDC on-chain volume has out-traded the top two CEXes combined since September 2025.

Yet there are **zero Solana DEXes** with a real exchange-grade UX. AMMs hide liquidity behind swap widgets. Phoenix and OpenBook need paid market makers to bootstrap every market. Pros stay on Binance.

**The Solution:** Acend doesn't wait for liquidity to arrive. It pulls existing AMM depth from across Solana (via Jupiter) and renders it as visible order book depth. Real user orders sit alongside this. Market makers compete on spread — not on who gets paid the most rebates.

**The Slogan:** *"All liquidity, on the books."*

---

## The Three Layers

### Layer 1 — Real Limit Orders

User limit orders escrowed in on-chain UserVault PDAs. Hard commitment — funds are locked. These settle immediately when matched. Green and red bars on the book. Price-time priority.

**Order types:** GTC · IOC · FOK · Post-Only

### Layer 2 — Intent Orders (v3)

Trusted market makers post soft RFQ-based commitments. Their intent is visible on the book in gold. When a taker hits that level, the matching engine sends a parallel RFQ to all MMs at that price. First responder wins. Non-responders are penalized via on-chain reputation.

**Why this works:** MMs quote tighter spreads than AVL because AMM depth is already on the book — they're not building from scratch. They capture spread inside a pre-quoted curve. Hedge cost ≈ 0 (same AMMs, same chain).

### Layer 3 — AVL (Aggregated Virtualized Liquidity)

The Depth Sampler continuously polls Jupiter to build a picture of available AMM liquidity at every price level. This depth is mirrored as virtual orders on the book — gray, translucent bars. It's the universal fallback that guarantees the book is never empty.

When a taker hits virtual depth, the matching engine fetches a **fresh** Jupiter quote, builds an atomic Solana transaction with a CPI to Jupiter, and executes the swap. Price guard on-chain reverts if execution deviates beyond slippage tolerance.

**No funds move until execution. No new liquidity pools needed.**

---

## Structural Edge

| | Everyone Else | Acend |
|---|---|---|
| **MM model** | Pay MMs to bootstrap ($1M+/yr per pair) | MMs profit by quoting tighter than AVL |
| **Day-one depth** | Empty books | Deep books — AMM depth already on the book |
| **Hedge cost** | High (cross-venue) | ≈ 0 (same AMMs, same chain) |
| **New pairs** | Needs MM program launch | Deep day one, any SPL token |

**Deep books without paid MM programs. Structural, not promotional.**

---

## Competitive Landscape

| | Acend | Jupiter | Phoenix | Binance |
|---|---|---|---|---|
| **Order book UI** | ✓ | ✗ | ✓ | ✗ |
| **Limit / Post-only** | ✓ | Partial | ✓ | ✓ |
| **Deep day-one** | ✓ | — | ✗ | N/A |
| **Self-custody** | ✓ | ✓ | ✓ | ✗ |
| **Permissionless pairs** | ✓ | ✓ | ✓ | N/A |
| **No paid MM needed** | ✓ | N/A | ✗ | N/A |

Only Acend hits all six.

---

## Features (Devnet Live)

- ✅ **Two-layer order book** — Real orders + AVL, segmented depth bars
- ✅ **Live order management** — Limit, IOC, FOK, Post-Only
- ✅ **Matching engine** — Built into server.js, balance-validated, real-time fills
- ✅ **Pro trading terminal** — Candlestick chart (live Binance price feed), order book, trade form
- ✅ **Depth Sampler** — 40+ levels of visible liquidity from Jupiter/Raydium/Pyth/Binance
- ✅ **Price oracle** — Binance WebSocket, guarded against stale/anomalous quotes
- ✅ **Wallet integration** — Phantom (multi-wallet detection), dev auth bypass
- ✅ **Chain-explorer verification** — On-chain transparency via Solana explorer

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Frontend   │────▶│  Matching Engine  │────▶│ Solana RPC  │
│ (acend-v6)   │     │  (server.js)      │     │ (testnet)   │
└──────────────┘     │                   │     └─────────────┘
                     │ • Order book view  │
┌──────────────┐     │ • Waterfall logic  │     ┌─────────────┐
│ Jupiter API  │────▶│ • Settlement tx    │────▶│ Acend       │
│ (AVL quotes) │     │ • WS real-time     │     │ Program     │
└──────────────┘     └──────────────────┘     └─────────────┘
        │                                            │
        └────────────────────────────────────────────┘
                     CPI for AVL fills

┌──────────────┐     ┌──────────────┐
│ Depth Sampler│────▶│ AVL Pipeline │──▶ Order Book
│ (off-chain)  │     │ (src/avl/)   │
└──────────────┘     └──────────────┘
```

---

## Quick Start

```bash
cd ~/hermes/projects/black-box/acend

# Install dependencies
npm install

# Start the server
node server.js
# → http://localhost:8081/

# Start AVL pipeline (separate terminal)
node src/avl/index.js
```

---

## How AVL Works

1. **Sample** — Depth Sampler calls Jupiter `/quote` at 12 size increments (~0.1 to 250 SOL) to map the liquidity curve
2. **Map** — Each quote becomes a virtual order with price, size, TTL, and source tag
3. **Display** — Virtual orders render on the book as translucent bars alongside real orders
4. **Execute** — When a taker hits virtual depth, a fresh Jupiter quote is fetched and executed in a single atomic Solana transaction via CPI
5. **Guard** — On-chain price guard reverts if live execution deviates beyond the taker's slippage tolerance

**Sampling cadence:** 2-5s inner band, 10-15s outer band, 30s far band  
**Granularity:** 10 bps inner, 25 bps outer — producing 40-60 virtual levels per side

---

## Roadmap

**Summer 2026** — Devnet live  
Two-layer CLOB working. Real Orders + AVL operational. Pro trading terminal complete. ✅

**Late Q3 2026** — Mainnet alpha  
Audit, deploy SOL/USDC + 5 majors, KYB-light onboarding.

**Q4 2026** — MM Intents v3  
RFQ engine, MM onboarding, market creation tools. First paid MMs live.

**Q1 2027** — Permissionless pairs  
Public pair creation. Token launch partnership program. 5% creator fee active.

**Q2 2027** — Yield-bearing orders  
Resting orders earn option premium. Cross-protocol integration with lending markets.

**Late 2027** — Options + predictions  
Ultra-short options embedded in the book. Liquidity prediction markets. Full PvP layer activates.

---

## The Vision

> Every piece of liquidity becomes a position in a meta-game.

```
More games → More volume → Deeper books → Better prices → More traders → More games
```

Three participant classes emerge:

- **Options Writers** — Resting orders generate options. Collect premium while their order stays available.
- **Liquidity Bettors** — Bet on whether levels will fill. Speculate on book microstructure and depth dynamics.
- **Spot Traders** — Get deeper books from all the meta-game activity. Better prices, more counterparties.

The line between trading and gaming dissolves.

---

## Team

**Phizen** — Business · Strategy · Operations  
Product direction, market strategy, partnerships, fundraising. Owns vision from positioning to GTM.

**Kaiden** — Engineering · Architecture  
Built the entire codebase: matching engine, Depth Sampler, on-chain Solana programs, frontend. Ships full-stack.

**Hermes** — AI Agent Infrastructure  
In-house, product-specific AI agent that handles development management, code generation, testing, and deployment. Force multiplier enabling a 2-person team to ship at the velocity of 8.

---

## Links

- **Website:** [acend.xyz](https://acend.xyz)
- **GitHub:** [github.com/limeneris-beep/acend](https://github.com/limeneris-beep/acend)
- **Devnet Program:** `4EoitT7wRJjQ5YZF8HEMEDY2RUvcWeJVZVTNNZVFf73x`

## Tech Stack

- **Blockchain:** Solana (Anchor framework, testnet)
- **Liquidity:** Jupiter CPI, Raydium, Orca, Meteora
- **Price Feeds:** Binance WebSocket, Pyth oracle
- **Backend:** Node.js (Express + WebSocket), matching engine built in
- **Frontend:** Vanilla JS (acend-v6.html), lightweight-charts, Phantom wallet
- **AVL Pipeline:** Node.js with PCHIP interpolation + GMM extrapolation
- **Agent Orchestration:** Hermes Agent + DeepSeek V4

---

*Built for the Colosseum Hackathon 2026. Seed stage.*  
*Phizen & Kaiden · acend.xyz*
