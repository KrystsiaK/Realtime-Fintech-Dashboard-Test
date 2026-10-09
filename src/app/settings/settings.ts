import { Component, inject, signal } from '@angular/core';
import { form, FormField, submit } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { MarketDataStore } from '../market/market-data.store';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, settingsSchema, type ProducerSettings } from '../market/settings';

@Component({
  selector: 'app-settings',
  imports: [FormField],
  templateUrl: './settings.html',
})
export default class Settings {
  private readonly store = inject(MarketDataStore);
  private readonly router = inject(Router);

  // Local draft: editing never touches the producer until Apply.
  protected readonly model = signal<ProducerSettings>({ ...this.store.settings() });
  protected readonly form = form(this.model, settingsSchema);

  protected readonly fields = [
    { key: 'instrumentCount', label: 'Instrument count', hint: 'Fictional instruments to simulate', unit: '' },
    { key: 'updatesPerBatch', label: 'Updates per batch', hint: 'Market updates across all instruments', unit: '' },
    { key: 'batchIntervalMs', label: 'Batch interval', hint: 'Requested time between batches', unit: 'ms' },
  ] as const;
  protected readonly limits = SETTINGS_LIMITS;

  protected nominalRate(): number | null {
    const { updatesPerBatch, batchIntervalMs } = this.model();
    return this.form().valid() ? Math.round((updatesPerBatch * 1000) / batchIntervalMs) : null;
  }

  protected apply(event: Event): void {
    event.preventDefault();
    void submit(this.form, async () => {
      this.store.apply(this.model());
      await this.router.navigateByUrl('/');
    });
  }

  protected resetToDefaults(): void {
    this.model.set({ ...DEFAULT_SETTINGS });
  }
}
