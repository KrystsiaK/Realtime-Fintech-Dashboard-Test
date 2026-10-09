import { computed, DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { emptyStats, toRow, type InstrumentStats } from './metrics';
import { SYMBOLS } from './instruments';
import type { ProducerCommand, ProducerEvent } from './producer.protocol';
import { DEFAULT_SETTINGS, type ProducerSettings } from './settings';

/** The subset of `Worker` the store uses, so tests can drive it with a fake. */
export type ProducerWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

export const PRODUCER_WORKER = new InjectionToken<() => ProducerWorker>('PRODUCER_WORKER', {
  providedIn: 'root',
  factory: () => () => new Worker(new URL('./producer.worker', import.meta.url), { type: 'module' }),
});

export type ProducerStatus = 'initializing' | 'running' | 'paused' | 'error';

/**
 * App-wide singleton: owns the one producer worker, so navigating between pages
 * never creates another producer or loses the active run.
 */
@Injectable({ providedIn: 'root' })
export class MarketDataStore {
  private readonly worker = inject(PRODUCER_WORKER)();
  private runId = 0;
  private readonly stats = signal<InstrumentStats[]>([]);

  readonly settings = signal<ProducerSettings>(DEFAULT_SETTINGS);
  readonly status = signal<ProducerStatus>('initializing');
  readonly error = signal<string | null>(null);
  readonly totalUpdates = signal(0);
  readonly rows = computed(() => this.stats().map((s, i) => toRow(SYMBOLS[i], s)));
  readonly nominalRate = computed(() => {
    const { updatesPerBatch, batchIntervalMs } = this.settings();
    return Math.round((updatesPerBatch * 1000) / batchIntervalMs);
  });

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<ProducerEvent>) => this.onEvent(data);
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.fail(e.message || 'The producer worker failed to start');
    };
    inject(DestroyRef).onDestroy(() => this.worker.terminate());
    this.apply(DEFAULT_SETTINGS);
  }

  /** Starts a fresh run: clears all values/totals and starts generating even if paused. */
  apply(settings: ProducerSettings): void {
    this.runId++;
    this.settings.set({ ...settings });
    this.stats.set(Array.from({ length: settings.instrumentCount }, emptyStats));
    this.totalUpdates.set(0);
    this.error.set(null);
    this.status.set('initializing');
    this.send({ type: 'start', runId: this.runId, settings: { ...settings } });
  }

  pause(): void {
    if (this.status() !== 'running' && this.status() !== 'initializing') return;
    this.status.set('paused');
    this.send({ type: 'pause', runId: this.runId });
  }

  resume(): void {
    if (this.status() !== 'paused') return;
    this.status.set('running');
    this.send({ type: 'resume', runId: this.runId });
  }

  private onEvent(event: ProducerEvent): void {
    if (event.runId !== this.runId) return; // stale result from a replaced run
    switch (event.type) {
      case 'started':
        if (this.status() === 'initializing') this.status.set('running');
        break;
      case 'snapshot':
        this.stats.set(event.stats);
        this.totalUpdates.set(event.totalUpdates);
        break;
      case 'error':
        this.fail(event.message);
        break;
    }
  }

  private fail(message: string): void {
    this.status.set('error');
    this.error.set(message);
  }

  private send(cmd: ProducerCommand): void {
    this.worker.postMessage(cmd);
  }
}
