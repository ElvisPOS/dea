import {
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ButtonModule } from '@openng/optimus-ui/button';
import { TableModule } from '@openng/optimus-ui/table';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { Backend } from '../core/backend';
import { FleetStore } from '../core/fleet-store';
import { I18n, TPipe } from '../core/i18n';
import { LogFile } from '../core/models';
import { Session } from '../core/session';

function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** A POS's log files under /usr/share/elvispos, downloadable as one .tar.gz. */
@Component({
  selector: 'dea-logs-page',
  imports: [ButtonModule, TableModule, TooltipModule, TPipe],
  templateUrl: './logs-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'pane-body logs' },
})
export class LogsPage implements OnInit {
  private backend = inject(Backend);
  private session = inject(Session);
  protected fleet = inject(FleetStore);
  protected i18n = inject(I18n);

  readonly agentKey = input.required<string>();
  readonly label = input.required<string>();

  protected files = signal<LogFile[] | null>(null);
  protected error = signal('');
  protected selected = signal<Set<string>>(new Set());
  protected busy = signal('');
  protected humanSize = humanSize;

  /** Files with their folder (the table groups rows by it) and base name. */
  protected rows = computed(() =>
    (this.files() || []).map((f) => ({
      ...f,
      dir: f.path.slice(0, f.path.lastIndexOf('/')),
      base: f.name.slice(f.name.lastIndexOf('/') + 1),
    })),
  );
  protected selection = computed(() => this.rows().filter((f) => this.selected().has(f.path)));

  protected status = computed(() => {
    if (this.busy()) return this.busy();
    const files = this.files() || [];
    const sel = files.filter((f) => this.selected().has(f.path));
    return sel.length
      ? this.i18n.t('logs.selected', {
          n: sel.length,
          size: humanSize(sel.reduce((s, f) => s + f.size, 0)),
        })
      : this.i18n.t('logs.count', {
          n: files.length,
          size: humanSize(files.reduce((s, f) => s + f.size, 0)),
        });
  });

  ngOnInit() {
    this.load();
  }

  async load() {
    this.files.set(null);
    this.error.set('');
    try {
      const files = await this.backend.logs(this.agentKey());
      this.files.set(files);
      const known = new Set(files.map((f) => f.path));
      this.selected.set(new Set([...this.selected()].filter((p) => known.has(p))));
    } catch (e) {
      this.session.handle(e);
      this.files.set([]);
      this.error.set(this.i18n.err((e as Error).message));
    }
  }

  protected select(files: LogFile[]) {
    this.selected.set(new Set(files.map((f) => f.path)));
  }

  protected downloadSelected() {
    this.download([...this.selected()]);
  }

  async download(paths: string[] | null) {
    this.busy.set(this.i18n.t('logs.compressing'));
    try {
      const { name, blob } = await this.backend.downloadLogs(this.agentKey(), paths, (got) =>
        this.busy.set(this.i18n.t('logs.downloading', { size: humanSize(got) })),
      );
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.busy.set('');
      this.flash(this.i18n.t('logs.saved', { name, size: humanSize(blob.size) }));
    } catch (e) {
      this.session.handle(e);
      this.busy.set('');
      this.flash(this.i18n.t('logs.failed', { msg: this.i18n.err((e as Error).message) }));
    }
  }

  protected note = signal('');
  private flash(text: string) {
    this.note.set(text);
    setTimeout(() => this.note() === text && this.note.set(''), 8000);
  }
}
