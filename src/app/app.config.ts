import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation, withViewTransitions } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Hash routing: deep links work on static hosting (GitHub Pages) without a 404 fallback.
    provideRouter(routes, withHashLocation(), withViewTransitions()),
  ],
};
