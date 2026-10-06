import { EnvironmentProviders, Provider, provideAppInitializer } from '@angular/core';
import { Backend } from '../app/core/backend';
import { MockBackend, SCENARIO } from './mock-backend';
import { SCENARIOS } from './scenarios';

// Replaces src/app/core/backend.provider.ts in the "mock" build configuration.
export const backendProvider: (Provider | EnvironmentProviders)[] = [
  { provide: Backend, useClass: MockBackend },
  provideAppInitializer(mountScenarioPicker),
];

/** A small "MOCK · scenario" picker in the bottom-left corner (hidden with ?picker=0). */
function mountScenarioPicker() {
  if (new URLSearchParams(location.search).get('picker') === '0') return;
  const box = document.createElement('label');
  box.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:99;display:flex;gap:6px;align-items:center;padding:4px 8px;border-radius:6px;' +
    'font:600 11px system-ui;background:#d69e2e;color:#1a1300;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  box.textContent = 'MOCK';
  const sel = document.createElement('select');
  sel.style.cssText = 'font:11px system-ui;padding:1px 4px;border-radius:4px;border:0';
  for (const name of Object.keys(SCENARIOS)) sel.add(new Option(name, name, false, name === SCENARIO));
  sel.onchange = () => {
    const q = new URLSearchParams(location.search);
    q.set('scenario', sel.value);
    location.search = q.toString();
  };
  box.append(sel);
  document.body.append(box);
}
