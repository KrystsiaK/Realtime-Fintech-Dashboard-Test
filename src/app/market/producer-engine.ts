import { applyBatch, emptyStats, FIELDS, type InstrumentStats } from './metrics';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';

/** Exports of wasm/producer (see its C ABI). */
export interface ProducerExports {
  memory: WebAssembly.Memory;
  producer_new(instrumentCount: number, seed: number): number;
  producer_generate(handle: number, count: number): number;
  producer_free(handle: number): void;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The worker's logic, free of worker globals so it can be tested with fake timers and a fake Wasm module.
 * `dispatch` applies commands strictly in arrival order, even while Wasm is still loading,
 * and a failing command never blocks the ones after it.
 */
export function createProducerEngine(
  wasm: Promise<ProducerExports>,
  post: (event: ProducerEvent) => void,
  seed: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
) {
  let runId = 0;
  let handle = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let updatesPerBatch = 0;
  let intervalMs = 0;
  let stats: InstrumentStats[] = [];
  let totalUpdates = 0;

  function stop(): void {
    clearInterval(timer);
    timer = undefined;
  }

  /** Stops the run for good. The handle is dropped, not freed: after a trap the instance isn't trusted. */
  function fail(id: number, e: unknown): void {
    stop();
    handle = 0;
    post({ type: 'error', runId: id, message: errorMessage(e) });
  }

  function tick(ex: ProducerExports): void {
    try {
      const ptr = ex.producer_generate(handle, updatesPerBatch);
      // View is created after the call: Wasm memory may have grown and detached older buffers.
      applyBatch(stats, new Int32Array(ex.memory.buffer, ptr, updatesPerBatch * FIELDS));
      totalUpdates += updatesPerBatch;
      post({ type: 'snapshot', runId, stats, totalUpdates });
    } catch (e) {
      fail(runId, e);
    }
  }

  function run(ex: ProducerExports): void {
    stop();
    // No catch-up after a pause: generation simply restarts from "now".
    timer = setInterval(() => tick(ex), intervalMs);
    tick(ex);
  }

  async function handle_(cmd: ProducerCommand): Promise<void> {
    const ex = await wasm;

    if (cmd.type === 'start') {
      stop();
      if (handle) ex.producer_free(handle);
      handle = 0;
      runId = cmd.runId;
      const { instrumentCount, updatesPerBatch: n, batchIntervalMs } = cmd.settings;
      handle = ex.producer_new(instrumentCount, seed());
      if (!handle) throw new Error(`Invalid instrument count: ${instrumentCount}`);
      updatesPerBatch = n;
      intervalMs = batchIntervalMs;
      stats = Array.from({ length: instrumentCount }, emptyStats);
      totalUpdates = 0;
      post({ type: 'started', runId });
      run(ex);
    } else if (cmd.runId !== runId || !handle) {
      return; // command for a replaced or failed run
    } else if (cmd.type === 'pause') {
      stop();
    } else if (cmd.type === 'resume' && timer === undefined) {
      run(ex);
    }
  }

  let queue = Promise.resolve();
  return {
    dispatch(cmd: ProducerCommand): Promise<void> {
      queue = queue.then(() => handle_(cmd)).catch((e) => fail(cmd.runId, e));
      return queue;
    },
  };
}
