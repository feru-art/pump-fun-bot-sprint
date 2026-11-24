// V9 — Tightest ultra-short sniper, small stake, for agent-fun/replay/v2 (pump.fun bonding curves).
//
// The tightest member of the sniper family: same clean-launch filter as V6
// (first 3 slots only, real SOL reserve >= 0.5 SOL, creator's own buys in the
// create slot <= 1 SOL, at most 3 distinct non-creator buyers, creator not sold,
// price run up at most +200% from create), but with the tightest buy slippage
// cap of the ladder — 300 bps — so any launch whose price jumps more than 3%
// during the 2-slot latency is rejected for free, and the smallest stake, 0.03 SOL,
// topped up with at most 2 adds. Exits are the fastest of the ladder: take profit
// at +8%, cut at -10%, never hold past 40 slots, leave at once when the creator
// sells. The smaller stake and tighter filter trade fewer, cleaner fills for less
// fee bleed per coin; at most 50 coins are entered. Pure function of the batches
// it is fed: no clock, no randomness, no I/O.

import {
  runBot,
  BPS,
  type BotState,
  type Batch,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

const FEE_BPS = 125n; // protocol 95 + creator 30 bps, per side

const P = {
  maxAge: 3,
  stakeLamports: 30_000_000n,
  minBuyLamports: 2_000_000n,
  maxAdds: 2,
  addDelay: 2,
  minRealSol: 500_000_000n,
  maxDevBuy: 1_000_000_000n,
  maxBuyers: 3,
  maxRunupBps: 30000n,
  buySlippageBps: 300,
  tpBps: 800n,
  slBps: 1000n,
  maxHold: 40,
  maxEntries: 50,
};

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  devSold: boolean;
  trades: number;
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuyRq: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
}

/** Net SOL selling `tokens` against (vq, vt) would pay, after the 125 bps curve fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

function hasPending(state: BotState, mint: Pubkey, side: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();
let entries = 0;

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        buyers: new Set(),
        devSold: false,
        trades: 0,
        buysSent: 0,
        spentSent: 0n,
        lastBuyVq: 0n,
        lastBuyVt: 1n,
        lastBuyRq: 0n,
        lastBuySlot: 0,
        done: false,
        complete: false,
      });
    } else if (e.event === "TradeEvent") {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.trades += 1;
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      }
    } else {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
    }
  }
}

await runBot({
  onBatch(state, batch) {
    readEvents(batch);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    for (const f of batch.fills) {
      if (f.client_id.startsWith("_")) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== "rejected" && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === "buy" && f.status === "filled" && h === undefined) {
        held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports) });
      }
    }
    for (const mint of [...selling]) {
      if (!hasPending(state, mint, "sell")) selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, "buy")) {
        held.delete(mint);
      }
    }

    // Exits first.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx };
        held.set(mint, h);
      }
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + P.tpBps)) exit = true;
        if (value * BPS <= basis * (BPS - P.slBps)) exit = true;
      }
      if (state.slot - h.openedSlot >= P.maxHold) exit = true;
      const c = coins.get(mint);
      if (c !== undefined && c.devSold) exit = true;
      if (!exit) continue;
      // Dust guard: when the net proceeds would not even cover the sell's own
      // tx fee, leave the position for the end-of-run flatten (which writes
      // dust off for free) instead of paying to sell it.
      if (value <= 0n) {
        if (c !== undefined) c.done = true;
        continue;
      }
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // Entries and adds.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete) continue;
      const age = state.slot - c.createSlot;
      const isAdd = c.buysSent > 0;
      if (!isAdd && age > P.maxAge) {
        c.done = true;
        continue;
      }
      if (!isAdd && entries >= P.maxEntries) continue;
      if (!isAdd && open >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold) {
        if (!isAdd) c.done = true;
        continue;
      }
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      const rq = curve.real_quote_reserves;
      if (isAdd) {
        if (c.buysSent > P.maxAdds) continue;
        if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, "buy")) continue;
        if (state.slot - c.lastBuySlot < P.addDelay) continue;
        if (vq * c.lastBuyVt < c.lastBuyVq * vt) continue;
        if (rq <= c.lastBuyRq) continue;
        const room = P.stakeLamports - c.spentSent;
        if (room < P.minBuyLamports) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: "buy", mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuyRq = rq;
        c.lastBuySlot = state.slot;
        continue;
      }
      if (rq < P.minRealSol) continue;
      if (c.devBuy > P.maxDevBuy) continue;
      if (c.buyers.size > P.maxBuyers) continue;
      if (c.vq0 > 0n && c.vt0 > 0n) {
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > P.maxRunupBps) {
          c.done = true;
          continue;
        }
      }
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = P.stakeLamports < maxBuy ? P.stakeLamports : maxBuy;
      if (amount < P.minBuyLamports) continue;
      if (free < amount + tx) continue;
      orders.push({ side: "buy", mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
      free -= amount + tx;
      c.buysSent += 1;
      c.spentSent += amount;
      c.lastBuyVq = vq;
      c.lastBuyVt = vt;
      c.lastBuyRq = rq;
      c.lastBuySlot = state.slot;
      entries += 1;
      open += 1;
    }
    return orders;
  },
});
