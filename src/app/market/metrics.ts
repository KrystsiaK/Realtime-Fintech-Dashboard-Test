/** Number of i32 fields per update in a Wasm batch (must match `FIELDS` in wasm/producer). */
export const FIELDS = 7;

/**
 * Running per-instrument state. Only what the metrics need is kept — never the event history.
 * Prices are integer cents; `null` means "no data yet".
 */
export interface InstrumentStats {
  lastCents: number | null;
  bidCents: number | null;
  askCents: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number;
  /** sum(priceCents × quantity). Exact as an integer up to 2^53 (~9e13 dollars traded). */
  notionalCents: number;
}

export interface MetricsRow {
  symbol: string;
  /** Dollars, rounded only at display time. */
  lastPrice: number | null;
  spread: number | null;
  volume: number;
  vwap: number | null;
  /** −1 … +1 */
  imbalance: number | null;
}

export const emptyStats = (): InstrumentStats => ({
  lastCents: null,
  bidCents: null,
  askCents: null,
  bidQty: null,
  askQty: null,
  volume: 0,
  notionalCents: 0,
});

/**
 * Folds a flat batch `[instrument, price, qty, bid, ask, bidQty, askQty, …]` into `stats` in place.
 * Every trade is counted exactly once; book quantities only replace the latest snapshot.
 */
export function applyBatch(stats: InstrumentStats[], batch: ArrayLike<number>): void {
  for (let i = 0; i + FIELDS <= batch.length; i += FIELDS) {
    const s = stats[batch[i]];
    const price = batch[i + 1];
    const qty = batch[i + 2];
    s.lastCents = price;
    s.volume += qty;
    s.notionalCents += price * qty;
    s.bidCents = batch[i + 3];
    s.askCents = batch[i + 4];
    s.bidQty = batch[i + 5];
    s.askQty = batch[i + 6];
  }
}

const dollars = (cents: number | null) => (cents === null ? null : cents / 100);

export function toRow(symbol: string, s: InstrumentStats): MetricsRow {
  const bookTotal = (s.bidQty ?? 0) + (s.askQty ?? 0);
  return {
    symbol,
    lastPrice: dollars(s.lastCents),
    spread: s.bidCents === null || s.askCents === null ? null : dollars(s.askCents - s.bidCents),
    volume: s.volume,
    vwap: s.volume === 0 ? null : s.notionalCents / s.volume / 100,
    imbalance: bookTotal === 0 ? null : ((s.bidQty ?? 0) - (s.askQty ?? 0)) / bookTotal,
  };
}
