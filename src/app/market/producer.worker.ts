/// <reference lib="webworker" />
import { applyBatch, emptyStats, FIELDS, type InstrumentStats } from './metrics';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';

interface ProducerExports {
  memory: WebAssembly.Memory;
  producer_new(instrumentCount: number, seed: number): number;
  producer_generate(handle: number, count: number): number;
  producer_free(handle: number): void;
}

async function loadWasm(): Promise<ProducerExports> {
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not supported in this browser');
  // Resolved next to the worker bundle, so it also works under a sub-path (GitHub Pages).
  const response = await fetch(new URL('producer.wasm', self.location.href));
  if (!response.ok) throw new Error(`Could not load producer.wasm (HTTP ${response.status})`);
  const { instance } = await WebAssembly.instantiateStreaming(response);
  return instance.exports as unknown as ProducerExports;
}

const wasm = loadWasm();

let runId = 0;
let handle = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let updatesPerBatch = 0;
let intervalMs = 0;
let stats: InstrumentStats[] = [];
let totalUpdates = 0;

const post = (event: ProducerEvent) => postMessage(event);

function stop(): void {
  clearInterval(timer);
  timer = undefined;
}

function tick(ex: ProducerExports): void {
  const ptr = ex.producer_generate(handle, updatesPerBatch);
  // View is created after the call: Wasm memory may have grown and detached older buffers.
  applyBatch(stats, new Int32Array(ex.memory.buffer, ptr, updatesPerBatch * FIELDS));
  totalUpdates += updatesPerBatch;
  post({ type: 'snapshot', runId, stats, totalUpdates });
}

function run(ex: ProducerExports): void {
  stop();
  tick(ex);
  // No catch-up after a pause: setInterval simply restarts from "now".
  timer = setInterval(() => tick(ex), intervalMs);
}

async function handle_(cmd: ProducerCommand): Promise<void> {
  let ex: ProducerExports;
  try {
    ex = await wasm;
  } catch (e) {
    post({ type: 'error', runId: cmd.runId, message: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (cmd.type === 'start') {
    stop();
    ex.producer_free(handle); // free(null) is a no-op
    runId = cmd.runId;
    const { instrumentCount, updatesPerBatch: n, batchIntervalMs } = cmd.settings;
    handle = ex.producer_new(instrumentCount, crypto.getRandomValues(new Uint32Array(1))[0]);
    if (!handle) {
      post({ type: 'error', runId, message: `Invalid instrument count: ${instrumentCount}` });
      return;
    }
    updatesPerBatch = n;
    intervalMs = batchIntervalMs;
    stats = Array.from({ length: instrumentCount }, emptyStats);
    totalUpdates = 0;
    post({ type: 'started', runId });
    run(ex);
  } else if (cmd.runId !== runId || !handle) {
    return; // command for a run that has already been replaced
  } else if (cmd.type === 'pause') {
    stop();
  } else if (cmd.type === 'resume' && timer === undefined) {
    run(ex);
  }
}

// Commands are chained so they are applied strictly in arrival order, even while Wasm is loading.
let queue = Promise.resolve();
addEventListener('message', ({ data }: MessageEvent<ProducerCommand>) => {
  queue = queue.then(() => handle_(data));
});
