import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { ConfirmationService } from '@openng/optimus-ui/api';
import { provideOptimus } from '@openng/optimus-ui/config';
import { backendProvider } from './core/backend.provider';
import { DeaPreset } from './core/optimus-theme';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // Optimus UI components (buttons, inputs, selects, dialog, menu, tables), themed from the design tokens
    provideOptimus({ theme: { preset: DeaPreset, options: { darkModeSelector: '[data-theme="dark"]' } }, ripple: false }),
    ConfirmationService,
    ...backendProvider,
  ],
};
