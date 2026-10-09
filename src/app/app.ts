import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MarketDataStore } from './market/market-data.store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(MarketDataStore);
  protected readonly nav = [
    { path: '/', label: 'Dashboard', exact: true },
    { path: '/settings', label: 'Settings', exact: false },
  ];
  protected readonly statusStyle = {
    initializing: { label: 'Starting', dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300' },
    running: { label: 'Live', dot: 'bg-emerald-400 animate-pulse', text: 'text-emerald-300' },
    paused: { label: 'Paused', dot: 'bg-amber-400', text: 'text-amber-300' },
    error: { label: 'Error', dot: 'bg-rose-500', text: 'text-rose-300' },
  } as const;
}
