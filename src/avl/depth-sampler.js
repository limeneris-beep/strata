/* ============================================
   Step 1 — Jupiter Depth Sampler
   Queries /swap/v1/quote at multiple sizes to build
   a virtual liquidity curve (asks + bids).
   Rate-limited to avoid 429s (2.5s between requests).
   ============================================ */

const DepthSampler = (() => {
    'use strict';

    const BASE = 'https://api.jup.ag/swap/v1';
    const SOL  = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    // ----- size ladders (log-spaced, fewer rungs) -----
    const askLadderSol  = [0.5, 2, 10, 50];     // SOL sells
    const bidLadderUsdc = [50, 200, 1000, 5000]; // USDC buys

    // ----- helpers -----
    const sol  = n => String(BigInt(Math.round(n * 1e9)));
    const usdc = n => String(BigInt(Math.round(n * 1e6)));

    // ----- fetch one side (rate-limited to avoid 429s) -----
    async function fetchSide(inputMint, outputMint, ladder, toUnits) {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const results = [];

        console.log(`[Depth] Fetching ${ladder.length} quotes (2.5s spacing)…`);
        const start = performance.now();

        for (let i = 0; i < ladder.length; i++) {
            const url = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${toUnits(ladder[i])}&slippageBps=50`;
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    console.warn(`[Depth] HTTP ${res.status} on size #${i} (${ladder[i]}) — rate limited, skipping`);
                    results.push(null);
                } else {
                    const j = await res.json();
                    if (j && j.inAmount && j.outAmount) {
                        results.push(j);
                        console.log(`[Depth]   #${i} size=${ladder[i]}: OK (impact=${j.priceImpactPct || 0}%)`);
                    } else {
                        console.warn(`[Depth] Invalid response on size #${i}`);
                        results.push(null);
                    }
                }
            } catch (e) {
                console.warn(`[Depth] fetch error on size #${i}: ${e.message}`);
                results.push(null);
            }
            // 2.5s between requests — safe for Jupiter free tier
            if (i < ladder.length - 1) await delay(2500);
        }

        const valid = results.filter(Boolean);
        console.log(`[Depth] ${valid.length}/${ladder.length} quotes valid (${((performance.now()-start)/1000).toFixed(1)}s)`);
        return valid;
    }

    // ----- build levels from quotes -----
    function buildLevels(quotes, isBidSide) {
        // Accept even single quotes — build what we can
        if (quotes.length === 0) return [];

        const MAX_LEVEL = BigInt(10 * 1e9); // 10 SOL cap

        const parsed = quotes.map(q => ({
            inAmount:  BigInt(q.inAmount),
            outAmount: BigInt(q.outAmount),
            impact:    q.priceImpactPct || 0,
        }));

        // If only 1 quote, use it directly with the quoted size
        if (parsed.length === 1) {
            const q = parsed[0];
            const size = isBidSide
                ? Number(q.outAmount) / 1e9
                : Number(q.inAmount) / 1e9;
            const price = isBidSide
                ? (Number(q.inAmount) / Number(q.outAmount)) * 1000
                : (Number(q.outAmount) / Number(q.inAmount)) * 1000;
            return [{
                price:  +price.toFixed(3),
                size:   Math.min(size, 10),
                impact: q.impact,
                band:   'inner',
            }];
        }

        const levels = [];
        for (let i = 1; i < parsed.length; i++) {
            const prev = parsed[i - 1];
            const curr = parsed[i];

            const rawSize = isBidSide
                ? (curr.outAmount - prev.outAmount)
                : (curr.inAmount - prev.inAmount);
            if (rawSize <= 0n) continue;

            const capped = rawSize > MAX_LEVEL ? MAX_LEVEL : rawSize;

            const price = isBidSide
                ? (Number(curr.inAmount) / Number(curr.outAmount)) * 1000
                : (Number(curr.outAmount) / Number(curr.inAmount)) * 1000;

            levels.push({
                price:  +price.toFixed(3),
                size:   Number(capped) / 1e9,
                impact: curr.impact,
                band:   curr.impact <= 2 ? 'inner' : curr.impact <= 5 ? 'mid' : 'outer',
            });
        }
        return levels;
    }

    // ----- public: sample full curve -----
    async function sample() {
        console.log('[Depth] Sampling…');

        const [askQuotes, bidQuotes] = await Promise.all([
            fetchSide(SOL,  USDC, askLadderSol,  sol),
            fetchSide(USDC, SOL,  bidLadderUsdc, usdc),
        ]);

        const asks = buildLevels(askQuotes, false).sort((a, b) => a.price - b.price);
        const bids = buildLevels(bidQuotes, true).sort((a, b) => b.price - a.price);

        const curve = {
            asks,
            bids,
            ts: Date.now(),
            askCount: asks.length,
            bidCount: bids.length,
        };

        console.log(`[Depth] Done — ${asks.length} asks, ${bids.length} bids`);
        if (asks.length > 0) {
            console.log(`[Depth] Ask range: $${asks[0].price.toFixed(2)} – $${asks[asks.length-1].price.toFixed(2)}`);
        }
        if (bids.length > 0) {
            console.log(`[Depth] Bid range: $${bids[bids.length-1].price.toFixed(2)} – $${bids[0].price.toFixed(2)}`);
        }

        return curve;
    }

    return { sample };

})();
