import { applyBatch, emptyStats, toRow } from './metrics';

// [instrument, priceCents, qty, bidCents, askCents, bidQty, askQty]
const update = (inst: number, price: number, qty: number, bid = 10196, ask = 10200, bq = 600, aq = 400) => [
  inst, price, qty, bid, ask, bq, aq,
];

describe('metrics', () => {
  it('computes the worked example', () => {
    const stats = [emptyStats()];
    applyBatch(stats, [...update(0, 10000, 10), ...update(0, 10200, 30)]);

    const row = toRow('ALFA', stats[0]);
    expect(row.lastPrice).toBe(102);
    expect(row.volume).toBe(40);
    expect(row.vwap).toBeCloseTo(101.5, 10);
    expect(row.spread).toBeCloseTo(0.04, 10);
    expect(row.imbalance).toBeCloseTo(0.2, 10);
  });

  it('shows unavailable values and zero volume before any data', () => {
    expect(toRow('ALFA', emptyStats())).toEqual({
      symbol: 'ALFA', lastPrice: null, spread: null, volume: 0, vwap: null, imbalance: null,
    });
  });

  it('returns null imbalance when both book quantities are zero', () => {
    const stats = [emptyStats()];
    applyBatch(stats, update(0, 100, 1, 99, 100, 0, 0));
    expect(toRow('X', stats[0]).imbalance).toBeNull();
  });

  it('handles fully one-sided books', () => {
    const stats = [emptyStats()];
    applyBatch(stats, update(0, 100, 1, 99, 100, 500, 0));
    expect(toRow('X', stats[0]).imbalance).toBe(1);
  });

  it('keeps instruments isolated', () => {
    const stats = [emptyStats(), emptyStats(), emptyStats()];
    applyBatch(stats, [...update(0, 10000, 10), ...update(2, 500, 4, 499, 501, 1, 3)]);

    expect(toRow('A', stats[0])).toMatchObject({ lastPrice: 100, volume: 10, vwap: 100 });
    expect(toRow('B', stats[1])).toMatchObject({ lastPrice: null, volume: 0, vwap: null, spread: null });
    expect(toRow('C', stats[2])).toMatchObject({ lastPrice: 5, volume: 4, vwap: 5, imbalance: -0.5 });
  });

  it('accumulates across batches and uses the latest book snapshot', () => {
    const stats = [emptyStats()];
    applyBatch(stats, update(0, 10000, 10, 9990, 10000, 100, 300));
    applyBatch(stats, update(0, 10200, 30));
    const row = toRow('X', stats[0]);
    expect(row.volume).toBe(40);
    expect(row.vwap).toBeCloseTo(101.5, 10);
    expect(row.imbalance).toBeCloseTo(0.2, 10);
  });

  it('accepts typed arrays straight from Wasm memory', () => {
    const stats = [emptyStats()];
    applyBatch(stats, Int32Array.from(update(0, 10200, 30)));
    expect(stats[0].volume).toBe(30);
  });
});
