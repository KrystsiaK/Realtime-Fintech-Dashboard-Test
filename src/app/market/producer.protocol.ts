import type { InstrumentStats } from './metrics';
import type { ProducerSettings } from './settings';

/** Main thread → worker. `runId` lets both sides ignore anything from a replaced run. */
export type ProducerCommand =
  | { type: 'start'; runId: number; settings: ProducerSettings }
  | { type: 'pause'; runId: number }
  | { type: 'resume'; runId: number };

/** Worker → main thread. */
export type ProducerEvent =
  | { type: 'started'; runId: number }
  | { type: 'snapshot'; runId: number; stats: InstrumentStats[]; totalUpdates: number }
  | { type: 'error'; runId: number; message: string };
