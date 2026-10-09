//! Simulated market-data producer, compiled to WebAssembly.
//!
//! The JS host talks to it through a tiny C ABI (no wasm-bindgen):
//! it owns an opaque `*mut Producer` handle and reads each batch straight
//! out of linear memory as an `Int32Array` — no serialization.
//!
//! Each update is `FIELDS` consecutive i32 values:
//! `[instrument, priceCents, tradeQuantity, bidCents, askCents, bidQuantity, askQuantity]`.

pub const FIELDS: usize = 7;

const MIN_MID_CENTS: i64 = 100; // keep prices comfortably positive ($1 floor)
const MAX_BOOK_QTY: i64 = 2_000;
const MAX_TRADE_QTY: i64 = 100;

/// xorshift64* — small, fast, deterministic for a given seed.
struct Rng(u64);

impl Rng {
    fn new(seed: u32) -> Self {
        // splitmix64 scramble so nearby seeds diverge and the state is never 0.
        let mut z = (seed as u64).wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Rng((z ^ (z >> 31)) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform integer in `lo..=hi` (modulo bias is irrelevant for a simulation).
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo + 1) as u64) as i64
    }

    fn coin(&mut self) -> bool {
        self.next() >> 63 == 1
    }
}

struct Instrument {
    mid_cents: i64,
    bid_qty: i64,
    ask_qty: i64,
}

pub struct Producer {
    rng: Rng,
    instruments: Vec<Instrument>,
    out: Vec<i32>,
}

impl Producer {
    pub fn new(instrument_count: usize, seed: u32) -> Self {
        let mut rng = Rng::new(seed);
        let instruments = (0..instrument_count)
            .map(|_| Instrument {
                mid_cents: rng.range(2_000, 50_000),
                bid_qty: rng.range(100, 1_000),
                ask_qty: rng.range(100, 1_000),
            })
            .collect();
        Producer { rng, instruments, out: Vec::new() }
    }

    /// Generates `count` updates; the returned slice is valid until the next call.
    pub fn generate(&mut self, count: usize) -> &[i32] {
        self.out.clear();
        self.out.reserve(count * FIELDS);
        for _ in 0..count {
            let index = self.rng.range(0, self.instruments.len() as i64 - 1) as usize;
            let rng = &mut self.rng;
            let inst = &mut self.instruments[index];

            // Random walk of up to ±0.1% per update, so prices evolve from previous values.
            let step = (inst.mid_cents / 1_000).max(1);
            inst.mid_cents = (inst.mid_cents + rng.range(-step, step)).max(MIN_MID_CENTS);

            // Spread of 1 cent .. ~0.1% of price; bid < ask always.
            let spread = rng.range(1, (inst.mid_cents / 1_000).max(1));
            let bid = inst.mid_cents - spread / 2;
            let ask = bid + spread;

            let book_step = 50;
            inst.bid_qty = (inst.bid_qty + rng.range(-book_step, book_step)).clamp(0, MAX_BOOK_QTY);
            inst.ask_qty = (inst.ask_qty + rng.range(-book_step, book_step)).clamp(0, MAX_BOOK_QTY);

            // Simplified model: the trade executes at the bid (seller hits) or the ask (buyer lifts).
            let price = if rng.coin() { bid } else { ask };
            let qty = rng.range(1, MAX_TRADE_QTY);

            self.out.extend_from_slice(&[
                index as i32,
                price as i32,
                qty as i32,
                bid as i32,
                ask as i32,
                inst.bid_qty as i32,
                inst.ask_qty as i32,
            ]);
        }
        &self.out
    }
}

// ---- C ABI for the JS host ----

/// Returns null for an invalid instrument count.
#[unsafe(no_mangle)]
pub extern "C" fn producer_new(instrument_count: u32, seed: u32) -> *mut Producer {
    if instrument_count == 0 {
        return core::ptr::null_mut();
    }
    Box::into_raw(Box::new(Producer::new(instrument_count as usize, seed)))
}

/// Returns a pointer to `count * FIELDS` i32 values in linear memory.
/// Memory may grow during the call, so the host must re-create its views afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn producer_generate(producer: *mut Producer, count: u32) -> *const i32 {
    let producer = unsafe { &mut *producer };
    producer.generate(count as usize).as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn producer_free(producer: *mut Producer) {
    if !producer.is_null() {
        drop(unsafe { Box::from_raw(producer) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn updates(batch: &[i32]) -> impl Iterator<Item = &[i32]> {
        batch.chunks_exact(FIELDS)
    }

    #[test]
    fn returns_requested_batch_size() {
        let mut p = Producer::new(5, 42);
        for n in [1, 100, 1_000] {
            assert_eq!(p.generate(n).len(), n * FIELDS);
        }
    }

    #[test]
    fn generated_values_are_valid() {
        let mut p = Producer::new(50, 7);
        for _ in 0..200 {
            for u in updates(p.generate(1_000)) {
                let [inst, price, qty, bid, ask, bid_qty, ask_qty] = u.try_into().unwrap();
                assert!((0..50).contains(&inst));
                assert!(bid > 0 && bid < ask, "bid {bid} ask {ask}");
                assert!(price == bid || price == ask);
                assert!(qty > 0);
                assert!(bid_qty >= 0 && ask_qty >= 0);
            }
        }
    }

    #[test]
    fn prices_evolve_from_previous_values() {
        let mut p = Producer::new(1, 1);
        let mut prev_bid: Option<i64> = None;
        for _ in 0..1_000 {
            let bid = p.generate(1)[3] as i64;
            if let Some(prev) = prev_bid {
                // bid = mid - spread/2, both bounded by ~0.1% of price per step.
                assert!((bid - prev).abs() <= prev / 200 + 2, "jump {prev} -> {bid}");
            }
            prev_bid = Some(bid);
        }
    }

    #[test]
    fn every_instrument_receives_updates() {
        let mut p = Producer::new(3, 9);
        let mut seen = [false; 3];
        for u in updates(p.generate(300)) {
            seen[u[0] as usize] = true;
        }
        assert!(seen.iter().all(|&s| s));
    }

    #[test]
    fn same_seed_is_deterministic() {
        let a = Producer::new(5, 123).generate(50).to_vec();
        let b = Producer::new(5, 123).generate(50).to_vec();
        assert_eq!(a, b);
    }

    #[test]
    fn ffi_rejects_zero_instruments_and_round_trips() {
        assert!(producer_new(0, 1).is_null());
        let p = producer_new(2, 1);
        let ptr = unsafe { producer_generate(p, 10) };
        assert!(!ptr.is_null());
        unsafe { producer_free(p) };
    }
}
