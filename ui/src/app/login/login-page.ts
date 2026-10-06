import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18n, LANGS, TPipe } from '../core/i18n';
import { Session } from '../core/session';
import { Theme } from '../core/theme';
import { ButtonModule } from '@openng/optimus-ui/button';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { PasswordModule } from '@openng/optimus-ui/password';
import { SelectModule } from '@openng/optimus-ui/select';
import { TooltipModule } from '@openng/optimus-ui/tooltip';

@Component({
  selector: 'dea-login',
  imports: [FormsModule, ButtonModule, InputTextModule, PasswordModule, SelectModule, TooltipModule, TPipe],
  host: { class: 'login' },
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `<form class="login-card" (ngSubmit)="submit()">
    <img src="dea-logo.png" alt="DEA · Diagnostic Elvis Agent" class="login-logo logo-light" />
    <img src="dea-logo-dark.png" alt="DEA · Diagnostic Elvis Agent" class="login-logo logo-dark" />
    <p class="muted">{{ 'login.tagline' | t }}</p>
    <label>
      <span>{{ 'login.user' | t }}</span>
      <input pInputText name="user" autocomplete="username" required [(ngModel)]="user" />
    </label>
    <label>
      <span>{{ 'login.password' | t }}</span>
      <p-password
        name="password"
        inputId="password"
        autocomplete="current-password"
        [required]="true"
        [autofocus]="true"
        [feedback]="false"
        [toggleMask]="true"
        [fluid]="true"
        [(ngModel)]="password"
      />
    </label>
    <button pButton type="submit" [loading]="busy()">{{ 'login.signin' | t }}</button>
    @if (error()) {
      <p class="error">{{ error() }}</p>
    }
    <div class="login-prefs">
      <label class="login-lang" for="login-lang">{{ 'lang.label' | t }}</label>
      <p-select
        inputId="login-lang"
        name="lang"
        size="small"
        [options]="langOptions"
        optionLabel="label"
        optionValue="value"
        [ngModel]="i18n.lang()"
        (ngModelChange)="i18n.lang.set($event)"
      />
      <button
        pButton
        type="button"
        severity="secondary"
        [text]="true"
        [icon]="theme.name() === 'light' ? 'pi pi-moon' : 'pi pi-sun'"
        [pTooltip]="'theme.toggle' | t"
        [attr.aria-label]="'theme.toggle' | t"
        (click)="theme.toggle()"
      ></button>
    </div>
  </form>`,
})
export class LoginPage {
  private session = inject(Session);
  protected i18n = inject(I18n);
  protected theme = inject(Theme);
  protected langOptions = LANGS.map((value) => ({ value, label: value === 'en' ? 'English' : 'Italiano' }));

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
