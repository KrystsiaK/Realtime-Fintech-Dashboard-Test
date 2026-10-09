/// <reference lib="webworker" />
import { createProducerEngine, type ProducerExports } from './producer-engine';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';

let compiled: Promise<WebAssembly.Module> | undefined;

/** Compiled once and cached; a failed load is retried on the next start. */
function compile(): Promise<WebAssembly.Module> {
  return (compiled ??= (async () => {
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not supported in this browser');
    // Resolved next to the worker bundle, so it also works under a sub-path (GitHub Pages).
    const response = await fetch(new URL('producer.wasm', self.location.href));
    if (!response.ok) throw new Error(`Could not load producer.wasm (HTTP ${response.status})`);
    return WebAssembly.compileStreaming(response);
  })().catch((e) => {
    compiled = undefined;
    throw e;
  }));
}

async function instantiate(): Promise<ProducerExports> {
  const instance = await WebAssembly.instantiate(await compile());
  return instance.exports as unknown as ProducerExports;
}

const engine = createProducerEngine(instantiate, (event: ProducerEvent) => postMessage(event));
addEventListener('message', ({ data }: MessageEvent<ProducerCommand>) => void engine.dispatch(data));
