import { EnvironmentProviders, Provider } from '@angular/core';
import { Backend } from './backend';
import { HttpBackend } from './http-backend';

// The real server API. The "mock" build configuration swaps this file for
// src/mock/backend.provider.mock.ts (sample fleets, no server needed).
export const backendProvider: (Provider | EnvironmentProviders)[] = [{ provide: Backend, useClass: HttpBackend }];
