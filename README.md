# Strata

**The order book Solana never had.**

[![Status](https://img.shields.io/badge/status-devnet_live-brightgreen)](#)
[![Built on Solana](https://img.shields.io/badge/built_on-Solana-blue)](#)
[![Colosseum Hackathon 2026](https://img.shields.io/badge/Colosseum-2026-purple)](#)

> $1.6T on-chain volume. Zero real spot exchanges.  
> Strata is the first order book DEX on Solana that doesn't look empty — ever.

---

## What Is Strata?

Strata is a next-generation order book DEX built on Solana. It combines **three liquidity layers** into one unified book:

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

**The Solution:** Strata doesn't wait for liquidity to arrive. It pulls existing AMM depth from across Solana (via Jupiter) and renders it as visible order book depth. Real user orders sit alongside this. Market makers compete on spread — not on who gets paid the most rebates.

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

| | Everyone Else | Strata |
|---|---|---|
| **MM model** | Pay MMs to bootstrap ($1M+/yr per pair) | MMs profit by quoting tighter than AVL |
| **Day-one depth** | Empty books | Deep books — AMM depth already on the book |
| **Hedge cost** | High (cross-venue) | ≈ 0 (same AMMs, same chain) |
| **New pairs** | Needs MM program launch | Deep day one, any SPL token |

**Deep books without paid MM programs. Structural, not promotional.**

---

## Competitive Landscape

| | Strata | Jupiter | Phoenix | Binance |
|---|---|---|---|---|
| **Order book UI** | ✓ | ✗ | ✓ | ✗ |
| **Limit / Post-only** | ✓ | Partial | ✓ | ✓ |
| **Deep day-one** | ✓ | — | ✗ | N/A |
| **Self-custody** | ✓ | ✓ | ✓ | ✗ |
| **Permissionless pairs** | ✓ | ✓ | ✓ | N/A |
| **No paid MM needed** | ✓ | N/A | ✗ | N/A |

Only Strata hits all six.

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
│ Jupiter API  │────▶│ • Settlement tx    │────▶│ Strata       │
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

## Beyond Spot — Financial Primitives Built on Visible Depth

> Visible depth isn't just a UX feature. It's an ingredient for new financial primitives.

The three-layer order book creates something no other DEX has: **a fully transparent, real-time map of available liquidity at every price level.** This isn't just better for traders — it's a substrate for entirely new products that can only exist when depth is visible and programmatic.

---

### Liquidity Prediction Markets

*"Will there be >500 SOL of depth at $150 in the next hour?"*

Bet on the book itself. Traders stake on whether specific price levels will fill within a time window — speculating on order book microstructure and depth dynamics. Predictions aggregate into a signal that feeds back into the book: more bets create more informed liquidity.

**Why it matters:** Prediction markets are the most efficient known mechanism for aggregating dispersed information. Applied to the order book, they surface hidden liquidity expectations. A market maker seeing a surge of "yes" bets on a deep level gets an early signal to quote there. The book becomes self-aware.

---

### Yield-Bearing Limit Orders

*Your resting order earns while it waits.*

Resting limit orders that sit unfilled serve as collateral for short-duration options elsewhere in DeFi. The order stays available on the book — the maker simply earns a premium for letting their locked capital work across protocols. No action required. No risk to the original order.

**How it works:**
1. Maker places a limit order → funds locked in UserVault PDA
2. Strata writes a covered call or cash-secured put against those locked funds
3. Option expires in minutes to hours — sold to liquidity bettors on Strata's own market
4. If the limit order fills, the option was OTM (no exercise) → maker keeps premium
5. If the limit order doesn't fill, the option resolves normally

**Yield-bearing orders turn every limit order into a dual-purpose position.** The maker is simultaneously providing spot liquidity and selling volatility. The first cross-protocol integration targets Solana lending markets (Kamino, Marginfi, Solend) for the collateral leg.

---

### Ultra-Short Options — Embedded in the Book

*Calls and puts with 30-minute to 4-hour expiries, displayed inline alongside spot orders.*

On Strata, spot and derivatives live in one interface — not two separate products. An ultra-short call at $155 sits on the same book as a spot ask at $155. Traders see both. They can fill either.

This collapses the mental distance between spot and options. A trader who thinks "SOL will hit $155 in the next hour" can:
- **Buy spot** at market and sell at $155 (traditional)
- **Buy a $155 call** expiring in 1 hour (natively, on the same book)
- **Write a put** against their existing spot position

All three are one click. All three sit on the same interface.

**The key insight:** short-duration options are not a separate product category — they're a natural extension of visible depth. If you can see the book, you can bet on where it's going.

---

### Collateral-Concentrated Liquidity Ranges with Leverage

*Concentrated liquidity meets order book market making — with leverage.*

Inspired by Uniswap v3's concentrated liquidity but rebuilt for a CLOB: liquidity providers stake collateral into a **price range** (e.g., $145-$155) rather than a single price level. The order book automatically distributes their depth across that range as segmented virtual orders.

**Leverage:** Because the range bounds the provider's risk, the system can offer leverage — a provider staking $1,000 of collateral can represent $3,000-$5,000 of depth within their chosen range. This is capital-efficient market making without running a bot, without managing inventory, without paying for RPC nodes.

**Range tiles slot into the book alongside everything else.** A trader sees:
- Real orders at discrete price levels
- Intent orders from professional MMs  
- AVL depth from Jupiter
- Range-provided depth spanning a band of prices (labeled)

Liquidity providers earn the spread from fills within their range. If price exits the range, the position is automatically unwound and collateral returned. No impermanent loss in the AMM sense — fills happen at the stated price, exactly like limit orders.

---

### The Self-Sustaining Cycle

```
More games → More volume → Deeper books → Better prices → More traders → More games
```

Five participant types emerge around visible depth:

| Participant | Action | Earns |
|-------------|--------|-------|
| **Spot Traders** | Trade on the unified book | Better fills from aggregated depth |
| **Options Writers** | Limit orders auto-generate covered options | Premium while order stays available |
| **Liquidity Bettors** | Predict whether levels will fill | Payouts on correct microstructure calls |
| **Range Providers** | Concentrate collateral across price bands | Spread from fills + leverage multiplier |
| **Market Makers** | Quote inside AVL spread | Native spread capture at near-zero hedge cost |

Every piece of liquidity becomes a position in a meta-game. The line between trading and gaming dissolves.

No other DEX is building toward this.

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

- **Website:** [stratabook.org](https://stratabook.org)
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
*Phizen & Kaiden · stratabook.org*
