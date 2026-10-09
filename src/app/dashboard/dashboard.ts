import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MarketDataStore } from '../market/market-data.store';

@Component({
  selector: 'app-dashboard',
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './dashboard.html',
})
export default class Dashboard {
  protected readonly store = inject(MarketDataStore);
}
