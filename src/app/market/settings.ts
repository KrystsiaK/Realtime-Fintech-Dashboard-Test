import { max, min, required, schema, validate } from '@angular/forms/signals';

export interface ProducerSettings {
  instrumentCount: number;
  updatesPerBatch: number;
  batchIntervalMs: number;
}

export const DEFAULT_SETTINGS: ProducerSettings = {
  instrumentCount: 5,
  updatesPerBatch: 100,
  batchIntervalMs: 500,
};

export const SETTINGS_LIMITS: Record<keyof ProducerSettings, { min: number; max: number }> = {
  instrumentCount: { min: 1, max: 50 },
  updatesPerBatch: { min: 1, max: 1000 },
  batchIntervalMs: { min: 50, max: 2000 },
};

/** Signal Forms schema: every field required, integer and within its range. */
export const settingsSchema = schema<ProducerSettings>((path) => {
  for (const key of Object.keys(SETTINGS_LIMITS) as (keyof ProducerSettings)[]) {
    const limits = SETTINGS_LIMITS[key];
    required(path[key], { message: 'Required' });
    min(path[key], limits.min, { message: `Must be at least ${limits.min}` });
    max(path[key], limits.max, { message: `Must be at most ${limits.max}` });
    validate(path[key], ({ value }) =>
      Number.isInteger(value()) ? undefined : { kind: 'integer', message: 'Must be a whole number' },
    );
  }
});
