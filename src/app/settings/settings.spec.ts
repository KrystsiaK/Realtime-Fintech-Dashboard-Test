import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { provideRouter } from '@angular/router';
import { MarketDataStore } from '../market/market-data.store';
import { DEFAULT_SETTINGS, settingsSchema, type ProducerSettings } from '../market/settings';
import Settings from './settings';

describe('settings validation', () => {
  const validate = (patch: Partial<ProducerSettings>) =>
    TestBed.runInInjectionContext(() => form(signal({ ...DEFAULT_SETTINGS, ...patch }), settingsSchema));

  it('accepts the defaults and the range bounds', () => {
    expect(validate({})().valid()).toBe(true);
    expect(validate({ instrumentCount: 1, updatesPerBatch: 1, batchIntervalMs: 50 })().valid()).toBe(true);
    expect(validate({ instrumentCount: 50, updatesPerBatch: 1000, batchIntervalMs: 2000 })().valid()).toBe(true);
  });

  it.each([
    ['instrumentCount', 0],
    ['instrumentCount', 51],
    ['updatesPerBatch', 0],
    ['updatesPerBatch', 1001],
    ['batchIntervalMs', 49],
    ['batchIntervalMs', 2001],
  ] as const)('rejects %s = %d (out of range)', (key, value) => {
    const f = validate({ [key]: value });
    expect(f[key]().invalid()).toBe(true);
    expect(f().valid()).toBe(false);
  });

  it('rejects non-integers', () => {
    const f = validate({ batchIntervalMs: 100.5 });
    expect(f.batchIntervalMs().errors().map((e) => e.kind)).toContain('integer');
  });

  it('rejects empty values', () => {
    expect(validate({ updatesPerBatch: null as unknown as number }).updatesPerBatch().invalid()).toBe(true);
  });
});

describe('Settings page', () => {
  let store: { settings: ReturnType<typeof signal<ProducerSettings>>; apply: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    store = { settings: signal(DEFAULT_SETTINGS), apply: vi.fn() };
    TestBed.configureTestingModule({
      imports: [Settings],
      providers: [provideRouter([]), { provide: MarketDataStore, useValue: store }],
    });
  });

  const setup = async () => {
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    const type = async (id: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
    };
    const submit = async () => {
      el.querySelector('form')!.dispatchEvent(new Event('submit'));
      await fixture.whenStable();
    };
    return { el, type, submit };
  };

  it('editing does not touch the producer; Apply starts a run with the new settings', async () => {
    const { type, submit } = await setup();
    await type('instrumentCount', '12');
    expect(store.apply).not.toHaveBeenCalled();

    await submit();
    expect(store.apply).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SETTINGS, instrumentCount: 12 });
  });

  it('does not apply invalid settings and shows the error', async () => {
    const { el, type, submit } = await setup();
    await type('batchIntervalMs', '10');
    await submit();

    expect(store.apply).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Must be at least 50');
  });
});
