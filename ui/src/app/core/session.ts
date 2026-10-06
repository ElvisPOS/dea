import { Injectable, inject, signal } from '@angular/core';
import { Backend, Unauthorized } from './backend';
import { Me } from './models';

/** Login state: 'checking' at startup, then the login page or the app. */
@Injectable({ providedIn: 'root' })
export class Session {
  private backend = inject(Backend);
  readonly state = signal<'checking' | 'login' | 'app'>('checking');
  readonly me = signal<Me | null>(null);

  async start() {
    try {
      this.me.set(await this.backend.me());
      this.state.set('app');
    } catch {
      this.state.set('login');
    }
  }

  async login(user: string, password: string) {
    await this.backend.login(user, password);
    this.me.set(await this.backend.me());
    this.state.set('app');
  }

  async logout() {
    await this.backend.logout().catch(() => {});
    this.state.set('login');
  }

  /** Any call that finds the session expired sends the user back to the login page. */
  handle(e: unknown) {
    if (e instanceof Unauthorized) this.state.set('login');
  }
}
