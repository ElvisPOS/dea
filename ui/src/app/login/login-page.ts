import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18n, LANGS, TPipe } from '../core/i18n';
import { Session } from '../core/session';
import { Theme } from '../core/theme';
import { Icon } from '../shared/ui';

@Component({
  selector: 'dea-login',
  imports: [FormsModule, Icon, TPipe],
  host: { class: 'login' },
  template: `<form class="login-card" (ngSubmit)="submit()">
    <img src="dea-logo.png" alt="DEA · Diagnostic Elvis Agent" class="login-logo logo-light" />
    <img src="dea-logo-dark.png" alt="DEA · Diagnostic Elvis Agent" class="login-logo logo-dark" />
    <p class="muted">{{ 'login.tagline' | t }}</p>
    <label>
      <span>{{ 'login.user' | t }}</span>
      <input name="user" autocomplete="username" required [(ngModel)]="user" />
    </label>
    <label>
      <span>{{ 'login.password' | t }}</span>
      <input name="password" type="password" autocomplete="current-password" required autofocus [(ngModel)]="password" />
    </label>
    <button type="submit" class="btn primary" [disabled]="busy()">{{ 'login.signin' | t }}</button>
    @if (error()) {
      <p class="error">{{ error() }}</p>
    }
    <div class="login-prefs">
      <label class="login-lang">
        <span>{{ 'lang.label' | t }}</span>
        <select class="lang-select rt-input" name="lang" [ngModel]="i18n.lang()" (ngModelChange)="i18n.lang.set($event)">
          @for (l of langs; track l) {
            <option [value]="l">{{ l === 'en' ? 'English' : 'Italiano' }}</option>
          }
        </select>
      </label>
      <button type="button" class="rt-btn is-ghost theme-btn" [title]="'theme.toggle' | t" (click)="theme.toggle()">
        <dea-icon [name]="theme.name() === 'light' ? 'moon' : 'sun'" />
      </button>
    </div>
  </form>`,
})
export class LoginPage {
  private session = inject(Session);
  protected i18n = inject(I18n);
  protected theme = inject(Theme);
  protected langs = LANGS;

  protected user = 'admin';
  protected password = '';
  protected busy = signal(false);
  protected error = signal('');

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.session.login(this.user, this.password);
      this.password = '';
    } catch (e) {
      this.error.set(this.i18n.err((e as Error).message));
    } finally {
      this.busy.set(false);
    }
  }
}
