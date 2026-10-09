import { TestBed } from '@angular/core/testing';
import { emptyStats, type InstrumentStats } from './metrics';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';
import { MarketDataStore, PRODUCER_WORKER, type ProducerWorker } from './market-data.store';
import { DEFAULT_SETTINGS } from './settings';

class FakeWorker implements ProducerWorker {
  sent: ProducerCommand[] = [];
  terminated = false;
  onmessage: ProducerWorker['onmessage'] = null;
  onerror: ProducerWorker['onerror'] = null;
  postMessage(cmd: ProducerCommand) {
    this.sent.push(cmd);
  }
  terminate() {
    this.terminated = true;
  }
  emit(event: ProducerEvent) {
    this.onmessage?.call(this as unknown as Worker, { data: event } as MessageEvent);
  }
  get lastRunId() {
    return this.sent.filter((c) => c.type === 'start').at(-1)!.runId;
  }
}

const statsWith = (count: number, patch: Partial<InstrumentStats>) =>
  Array.from({ length: count }, () => ({ ...emptyStats(), ...patch }));

describe('MarketDataStore', () => {
  let worker: FakeWorker;
  let workersCreated: number;
  let store: MarketDataStore;

  beforeEach(() => {
    worker = new FakeWorker();
    workersCreated = 0;
    TestBed.configureTestingModule({
      providers: [{ provide: PRODUCER_WORKER, useValue: () => (workersCreated++, worker) }],
    });
    store = TestBed.inject(MarketDataStore);
  });

  it('starts a run with the defaults and shows empty rows', () => {
    expect(worker.sent).toEqual([{ type: 'start', runId: 1, settings: DEFAULT_SETTINGS }]);
    expect(store.rows()).toHaveLength(5);
    expect(store.rows()[0]).toMatchObject({ symbol: 'ALFA', lastPrice: null, volume: 0 });
    expect(store.status()).toBe('initializing');
  });

  it('is a singleton that creates exactly one worker', () => {
    expect(TestBed.inject(MarketDataStore)).toBe(store);
    expect(workersCreated).toBe(1);
  });

  it('applies snapshots of the current run', () => {
    worker.emit({ type: 'started', runId: 1 });
    worker.emit({ type: 'snapshot', runId: 1, stats: statsWith(5, { lastCents: 10200, volume: 40 }), totalUpdates: 100 });
    expect(store.status()).toBe('running');
    expect(store.rows()[0]).toMatchObject({ lastPrice: 102, volume: 40 });
    expect(store.totalUpdates()).toBe(100);
  });

  describe('pause / resume', () => {
    beforeEach(() => worker.emit({ type: 'started', runId: 1 }));

    it('sends pause and resume for the current run', () => {
      store.pause();
      expect(store.status()).toBe('paused');
      store.resume();
      expect(store.status()).toBe('running');
      expect(worker.sent.slice(1)).toEqual([
        { type: 'pause', runId: 1 },
        { type: 'resume', runId: 1 },
      ]);
    });

    it('preserves values and totals across pause/resume', () => {
      worker.emit({ type: 'snapshot', runId: 1, stats: statsWith(5, { volume: 40, notionalCents: 406000 }), totalUpdates: 7 });
      store.pause();
      store.resume();
      expect(store.rows()[0]).toMatchObject({ volume: 40, vwap: 101.5 });
      expect(store.totalUpdates()).toBe(7);
    });

    it('ignores redundant pause/resume calls', () => {
      store.resume();
      store.pause();
      store.pause();
      expect(worker.sent.slice(1)).toEqual([{ type: 'pause', runId: 1 }]);
    });

    it('stays paused when paused before the worker confirms the start', () => {
      store.apply(DEFAULT_SETTINGS);
      store.pause();
      worker.emit({ type: 'started', runId: 2 });
      expect(store.status()).toBe('paused');
    });
  });

  describe('apply', () => {
    it('starts a new run, clears totals, and resumes generation when paused', () => {
      worker.emit({ type: 'started', runId: 1 });
      worker.emit({ type: 'snapshot', runId: 1, stats: statsWith(5, { volume: 40 }), totalUpdates: 100 });
      store.pause();

      const next = { instrumentCount: 3, updatesPerBatch: 10, batchIntervalMs: 50 };
      store.apply(next);

      expect(worker.sent.at(-1)).toEqual({ type: 'start', runId: 2, settings: next });
      expect(store.settings()).toEqual(next);
      expect(store.status()).toBe('initializing');
      expect(store.totalUpdates()).toBe(0);
      expect(store.rows()).toHaveLength(3);
      expect(store.rows().every((r) => r.volume === 0 && r.lastPrice === null)).toBe(true);
    });

    it('rejects results from a previous run', () => {
      store.apply({ ...DEFAULT_SETTINGS, instrumentCount: 2 });
      worker.emit({ type: 'started', runId: 1 });
      worker.emit({ type: 'snapshot', runId: 1, stats: statsWith(5, { volume: 999 }), totalUpdates: 999 });
      worker.emit({ type: 'error', runId: 1, message: 'old' });

      expect(store.status()).toBe('initializing');
      expect(store.rows()).toHaveLength(2);
      expect(store.totalUpdates()).toBe(0);
      expect(store.error()).toBeNull();
    });

    it('tags pause/resume with the new run id', () => {
      store.apply(DEFAULT_SETTINGS);
      store.pause();
      expect(worker.sent.at(-1)).toEqual({ type: 'pause', runId: worker.lastRunId });
    });
  });

  it('surfaces initialization errors', () => {
    worker.emit({ type: 'error', runId: 1, message: 'Could not load producer.wasm (HTTP 404)' });
    expect(store.status()).toBe('error');
    expect(store.error()).toContain('producer.wasm');
  });

  it('terminates the worker when the app is destroyed', () => {
    TestBed.resetTestingModule();
    expect(worker.terminated).toBe(true);
  });
});
