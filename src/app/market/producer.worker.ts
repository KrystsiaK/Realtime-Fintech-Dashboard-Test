/// <reference lib="webworker" />
import { createProducerEngine, type ProducerExports } from './producer-engine';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';

async function loadWasm(): Promise<ProducerExports> {
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not supported in this browser');
  // Resolved next to the worker bundle, so it also works under a sub-path (GitHub Pages).
  const response = await fetch(new URL('producer.wasm', self.location.href));
  if (!response.ok) throw new Error(`Could not load producer.wasm (HTTP ${response.status})`);
  const { instance } = await WebAssembly.instantiateStreaming(response);
  return instance.exports as unknown as ProducerExports;
}

const wasm = loadWasm();
wasm.catch(() => {}); // reported per command by the engine; avoid an unhandled-rejection log

const engine = createProducerEngine(wasm, (event: ProducerEvent) => postMessage(event));
addEventListener('message', ({ data }: MessageEvent<ProducerCommand>) => void engine.dispatch(data));
