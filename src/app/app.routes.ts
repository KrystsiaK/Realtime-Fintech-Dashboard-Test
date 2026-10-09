import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', title: 'Dashboard · Realtime Fintech', loadComponent: () => import('./dashboard/dashboard') },
  { path: 'settings', title: 'Settings · Realtime Fintech', loadComponent: () => import('./settings/settings') },
  { path: '**', redirectTo: '' },
];
