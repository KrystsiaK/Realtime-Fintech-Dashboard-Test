# Tickstream — Realtime Fintech Dashboard

Angular 22 dashboard that streams simulated market data from a **Rust → WebAssembly** generator running inside a **Web Worker**.

**Live demo:** https://krystsiak.github.io/Realtime-Fintech-Dashboard-Test/

## Stack

| Layer | Choice |
|---|---|
| UI | Angular 22 (standalone, zoneless, signals, Signal Forms), Tailwind CSS v4 |
| Generator | Rust (`wasm32-unknown-unknown`, plain C ABI — no wasm-bindgen) |
| Concurrency | One module Web Worker that owns the Wasm instance and aggregates metrics |
| Tests | Vitest (Angular unit-test builder) + `cargo test` |
| CI/CD | GitHub Actions → GitHub Pages on every push to `main` |

## Run locally

Requirements: Node ≥ 24.15 (see `.nvmrc`), Rust with the Wasm target:

```bash
rustup target add wasm32-unknown-unknown
npm ci
npm start          # builds the Wasm module, then `ng serve` on http://localhost:4200
```

| Command | What it does |
|---|---|
| `npm run build` | Wasm release build → `public/producer.wasm`, then production `ng build` |
| `npm test` | TypeScript unit tests (Vitest, single run) |
| `npm run test:wasm` | Rust generator tests (`cargo test`) |
| `npm run test:all` | Both |

## Architecture

```
┌──────────── main thread ─────────────┐        ┌──────────────── Web Worker ────────────────┐
│ Dashboard / Settings (routes)        │        │ producer.worker.ts                         │
│        ▲ signals                     │ start/ │ producer-engine.ts (pure, testable)        │
│                                      │        │  setInterval(batchInterval):               │
│ MarketDataStore (root singleton) ────┼─pause/─▶   ptr = producer_generate(handle, n) ──┐    │
│  • runId, status, settings           │ resume │   Int32Array view on Wasm memory       │    │
│  • rows = computed(toRow(stats))     ◀────────┼── applyBatch(stats, view)  ◀───────────┘    │
│  • drops events with stale runId     │snapshot│   postMessage({runId, stats, total})       │
└──────────────────────────────────────┘        │ producer.wasm (Rust): RNG + price walk     │
                                                └────────────────────────────────────────────┘
```

- **Wasm owns randomness and price evolution.** `wasm/producer/src/lib.rs` keeps per-instrument state (mid price, book quantities) between calls: a bounded random walk (≤ 0.1 % per update), spread ≥ 1 cent so `bid < ask`, trade price = bid or ask, quantities positive / non-negative, `$1` price floor. PRNG is seeded xorshift64*, so tests are deterministic.
- **Zero-copy transport Wasm → worker.** The generator writes 7 × i32 per update into a reusable `Vec<i32>`; the worker reads it through an `Int32Array` view (re-created after every call, since memory growth detaches old buffers).
- **Metrics are aggregated in the worker** (`metrics.ts → applyBatch`) as running totals only — last trade, latest bid/ask/quantities, `volume`, `Σ price×qty` in integer cents. No event history is kept, every trade counts once. The UI receives a tiny snapshot (≤ 50 objects) per batch, so the main thread does O(instruments) work regardless of the update rate. Prices are converted to dollars only in `toRow` / display.
- **Runs and staleness.** Each Apply increments `runId`. The worker tags every message with it; the store ignores anything from an older run, and the worker ignores pause/resume for a replaced run.
- **Pause/resume** clears / restarts the interval — no catch-up for the paused period; totals are untouched.
- **One producer for the app lifetime.** `MarketDataStore` is `providedIn: 'root'`, so route changes never create another worker. Applying a run frees the previous Wasm generator (`producer_free`); the worker is terminated when the app is destroyed.
- **Errors** (Wasm unsupported / fetch failed / trap in `producer_new` or in any periodic batch / worker crash) stop the run's timer and surface as a status + alert banner. Commands are queued in arrival order (also while Wasm is loading); a failing command never blocks the next one, so Apply always recovers. After a failure the whole Wasm instance is discarded (a trapped instance isn't trusted, so its generator isn't freed — dropping the instance releases all its memory); the next Apply instantiates a fresh one from the cached compiled `WebAssembly.Module`. A failed download isn't cached, so Apply also retries the load.
- **Worker logic lives in `producer-engine.ts`**, free of worker globals; `producer.worker.ts` only loads Wasm and wires `postMessage`. This lets the real pause/resume/error behaviour be tested with fake timers and a controllable Wasm load.
- The worker is injected through the `PRODUCER_WORKER` token, so store tests drive it with a fake worker — no real timers or waits.

At max settings (50 instruments, 1000 updates / 50 ms ≈ 20 000 updates/s) the main thread shows no long tasks.

## Tests

- `src/app/market/metrics.spec.ts` — worked example, zero denominators, one-sided book, instrument isolation, accumulation across batches.
- `src/app/settings/settings.spec.ts` — range / integer / required validation; editing doesn't affect the producer; Apply sends new settings; invalid form isn't applied.
- `src/app/market/producer-engine.spec.ts` — the actual worker logic with fake timers and a fake Wasm module: one batch per interval, pause stops generation, resume preserves totals with no catch-up, commands queued during Wasm loading apply in order, old runs are freed / ignored, load failure is retried, failing start / periodic batch are reported, the trapped Wasm instance is replaced (never reused or freed) and repeated failures don't accumulate generators.
- `src/app/market/market-data.store.spec.ts` — pause/resume, values preserved, Apply resets and restarts when paused, stale-run results rejected, single worker, cleanup.
- `wasm/producer/src/lib.rs` (`cargo test`) — batch sizes, value invariants over 200k updates, price continuity, determinism, FFI null handling.

## Deployment

`.github/workflows/deploy.yml` tests, builds and deploys every push to `main` to GitHub Pages.
One-time setup: **Settings → Pages → Source: GitHub Actions**.
Hash-based routing is used so deep links work on static hosting without a 404 fallback.
