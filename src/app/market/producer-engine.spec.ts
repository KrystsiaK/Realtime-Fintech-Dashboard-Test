import { FIELDS } from './metrics';
import { createProducerEngine, type ProducerExports } from './producer-engine';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';
import type { ProducerSettings } from './settings';

/** Fake Wasm module: every update is a trade of 1 unit at $1.00 on instrument (i % count). */
class FakeWasm implements ProducerExports {
  memory = new WebAssembly.Memory({ initial: 1 });
  generateCalls = 0;
  freed: number[] = [];
  failNew = false;
  failGenerateOnCall = Infinity;
  private nextHandle = 1;
  private counts = new Map<number, number>();

  producer_new(count: number): number {
    if (this.failNew) throw new Error('unreachable executed');
    if (count === 0) return 0;
    this.counts.set(this.nextHandle, count);
    return this.nextHandle++;
  }

  producer_generate(handle: number, n: number): number {
    if (++this.generateCalls >= this.failGenerateOnCall) throw new Error('trap in generate');
    const count = this.counts.get(handle)!;
    const view = new Int32Array(this.memory.buffer, 0, n * FIELDS);
    for (let i = 0; i < n; i++) view.set([i % count, 100, 1, 99, 101, 10, 10], i * FIELDS);
    return 0;
  }

  producer_free(handle: number): void {
    this.freed.push(handle);
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const settings = (patch: Partial<ProducerSettings> = {}): ProducerSettings => ({
  instrumentCount: 2,
  updatesPerBatch: 10,
  batchIntervalMs: 100,
  ...patch,
});

describe('producer engine (worker logic)', () => {
  let wasm: FakeWasm; // the first instance; later ones are created on demand
  let instances: FakeWasm[];
  let events: ProducerEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    wasm = new FakeWasm();
    instances = [];
    events = [];
  });

  const instantiate = () => {
    const next = instances.length === 0 ? wasm : new FakeWasm();
    instances.push(next);
    return Promise.resolve(next);
  };
  afterEach(() => vi.useRealTimers());

  const snapshots = (runId?: number) =>
    events.filter((e) => e.type === 'snapshot' && (runId === undefined || e.runId === runId)) as Extract<
      ProducerEvent,
      { type: 'snapshot' }
    >[];
  const lastSnapshot = () => snapshots().at(-1)!;

  /** Engine with Wasm already loaded; `send` waits until the command has been applied. */
  const loaded = () => {
    const engine = createProducerEngine(instantiate, (e) => events.push(structuredClone(e)), () => 1);
    return (cmd: ProducerCommand) => engine.dispatch(cmd);
  };

  it('generates one batch immediately, then one per interval', async () => {
    const send = loaded();
    await send({ type: 'start', runId: 1, settings: settings() });
    expect(events[0]).toEqual({ type: 'started', runId: 1 });
    expect(snapshots()).toHaveLength(1);

    vi.advanceTimersByTime(350);
    expect(snapshots()).toHaveLength(4);
    expect(lastSnapshot()).toMatchObject({ runId: 1, totalUpdates: 40 });
    expect(lastSnapshot().stats.map((s) => s.volume)).toEqual([20, 20]);
  });

  it('pause stops generation entirely', async () => {
    const send = loaded();
    await send({ type: 'start', runId: 1, settings: settings() });
    vi.advanceTimersByTime(100);
    await send({ type: 'pause', runId: 1 });
    const calls = wasm.generateCalls;

    vi.advanceTimersByTime(10_000);
    expect(wasm.generateCalls).toBe(calls);
    expect(snapshots()).toHaveLength(2);
  });

  it('resume keeps totals and does not catch up on the paused interval', async () => {
    const send = loaded();
    await send({ type: 'start', runId: 1, settings: settings() });
    vi.advanceTimersByTime(100); // 2 batches
    await send({ type: 'pause', runId: 1 });
    vi.advanceTimersByTime(60_000); // would be 600 batches if it caught up

    await send({ type: 'resume', runId: 1 });
    expect(lastSnapshot().totalUpdates).toBe(30); // 2 before + 1 immediate on resume
    vi.advanceTimersByTime(100);
    expect(lastSnapshot().totalUpdates).toBe(40);
    expect(lastSnapshot().stats.map((s) => s.volume)).toEqual([20, 20]);
  });

  it('ignores a duplicate resume while running', async () => {
    const send = loaded();
    await send({ type: 'start', runId: 1, settings: settings() });
    await send({ type: 'resume', runId: 1 });
    vi.advanceTimersByTime(100);
    expect(snapshots()).toHaveLength(2);
  });

  it('a new start frees the old generator and resets totals', async () => {
    const send = loaded();
    await send({ type: 'start', runId: 1, settings: settings() });
    vi.advanceTimersByTime(200);
    await send({ type: 'start', runId: 2, settings: settings({ instrumentCount: 3 }) });

    expect(wasm.freed).toEqual([1]);
    expect(instances).toHaveLength(1); // healthy runs share one instance
    expect(lastSnapshot()).toMatchObject({ runId: 2, totalUpdates: 10 });
    expect(lastSnapshot().stats).toHaveLength(3);

    const before = snapshots(1).length;
    vi.advanceTimersByTime(1_000);
    expect(snapshots(1)).toHaveLength(before); // old run's timer is gone
  });

  it('ignores pause/resume addressed to a replaced run', async () => {
    const send = loaded();
    await send({ type: 'start', runId: 1, settings: settings() });
    await send({ type: 'start', runId: 2, settings: settings() });
    await send({ type: 'pause', runId: 1 });
    vi.advanceTimersByTime(100);
    expect(snapshots(2)).toHaveLength(2);
  });

  describe('while Wasm is loading', () => {
    it('queues commands and applies them in order once loaded', async () => {
      const load = deferred<ProducerExports>();
      const engine = createProducerEngine(() => load.promise, (e) => events.push(e), () => 1);
      engine.dispatch({ type: 'start', runId: 1, settings: settings() });
      engine.dispatch({ type: 'start', runId: 2, settings: settings() });
      const done = engine.dispatch({ type: 'pause', runId: 2 });

      vi.advanceTimersByTime(1_000);
      expect(events).toEqual([]);

      load.resolve(wasm);
      await done;
      vi.advanceTimersByTime(1_000);
      // run 1 was replaced and freed; run 2 produced its first batch and was then paused.
      expect(wasm.freed).toEqual([1]);
      expect(snapshots(2)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'snapshot', runId: 2 });
    });

    it('reports a load failure and retries loading on the next start', async () => {
      const load = deferred<ProducerExports>();
      const loads = vi.fn().mockReturnValueOnce(load.promise).mockResolvedValueOnce(wasm);
      const engine = createProducerEngine(loads, (e) => events.push(e), () => 1);
      const done = engine.dispatch({ type: 'start', runId: 1, settings: settings() });
      load.reject(new Error('Could not load producer.wasm (HTTP 404)'));
      await done;
      expect(events).toEqual([{ type: 'error', runId: 1, message: 'Could not load producer.wasm (HTTP 404)' }]);

      await engine.dispatch({ type: 'start', runId: 2, settings: settings() });
      expect(loads).toHaveBeenCalledTimes(2);
      expect(events.at(-1)).toMatchObject({ type: 'snapshot', runId: 2 });
    });
  });

  describe('errors', () => {
    it('reports a failing start and still applies the next command', async () => {
      const send = loaded();
      wasm.failNew = true;
      await send({ type: 'start', runId: 1, settings: settings() });
      expect(events).toEqual([{ type: 'error', runId: 1, message: 'unreachable executed' }]);

      await send({ type: 'start', runId: 2, settings: settings() });
      expect(instances).toHaveLength(2);
      expect(lastSnapshot()).toMatchObject({ runId: 2, totalUpdates: 10 });
    });

    it('reports an invalid instrument count', async () => {
      const send = loaded();
      await send({ type: 'start', runId: 1, settings: settings({ instrumentCount: 0 }) });
      expect(events).toEqual([{ type: 'error', runId: 1, message: 'Invalid instrument count: 0' }]);
    });

    it('a failing first batch stops the timer and reports the error', async () => {
      const send = loaded();
      wasm.failGenerateOnCall = 1;
      await send({ type: 'start', runId: 1, settings: settings() });
      expect(events.at(-1)).toEqual({ type: 'error', runId: 1, message: 'trap in generate' });

      vi.advanceTimersByTime(1_000);
      expect(wasm.generateCalls).toBe(1);
    });

    it('a failing periodic batch stops the run; resume is ignored; a new start recovers', async () => {
      const send = loaded();
      wasm.failGenerateOnCall = 3;
      await send({ type: 'start', runId: 1, settings: settings() });
      vi.advanceTimersByTime(1_000);

      expect(wasm.generateCalls).toBe(3);
      expect(events.at(-1)).toEqual({ type: 'error', runId: 1, message: 'trap in generate' });

      await send({ type: 'resume', runId: 1 });
      expect(wasm.generateCalls).toBe(3);

      await send({ type: 'start', runId: 2, settings: settings() });
      vi.advanceTimersByTime(100);
      expect(snapshots(2)).toHaveLength(2);
    });

    it('discards the trapped Wasm instance and runs the next start on a fresh one', async () => {
      const send = loaded();
      wasm.failGenerateOnCall = 2;
      await send({ type: 'start', runId: 1, settings: settings() });
      vi.advanceTimersByTime(100);
      expect(events.at(-1)).toMatchObject({ type: 'error', runId: 1 });

      await send({ type: 'start', runId: 2, settings: settings() });
      vi.advanceTimersByTime(300);

      expect(instances).toHaveLength(2);
      const [trapped, fresh] = instances;
      expect(trapped.generateCalls).toBe(2); // not used after the trap
      expect(trapped.freed).toEqual([]); // and not freed either
      expect(fresh.generateCalls).toBe(4);
      expect(lastSnapshot()).toMatchObject({ runId: 2, totalUpdates: 40 });
    });

    it('repeated failures never accumulate generators in a live instance', async () => {
      const send = loaded();
      for (let run = 1; run <= 20; run++) {
        await send({ type: 'start', runId: run, settings: settings() });
        instances.at(-1)!.failGenerateOnCall = 0; // next batch traps
        vi.advanceTimersByTime(100);
        expect(events.at(-1)).toMatchObject({ type: 'error', runId: run });
      }
      await send({ type: 'start', runId: 21, settings: settings() });

      expect(instances).toHaveLength(21); // one instance per failed run, each dropped whole
      expect(instances.at(-1)!.generateCalls).toBe(1);
      expect(lastSnapshot()).toMatchObject({ runId: 21, totalUpdates: 10 });
    });
  });
});
