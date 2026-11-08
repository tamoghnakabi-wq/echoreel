import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Credentials, type Host, type Settings, type State } from './types';

/** All of Echoreel's state, kept in one JSON file in the data folder and written atomically. */
export class Store {
  state: State;
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();

  constructor(private host: Host) {
    mkdirSync(host.dataDir, { recursive: true });
    this.file = join(host.dataDir, 'echoreel-state.json');
    this.state = this.load();
  }

  private load(): State {
    const fresh: State = { version: 1, settings: { ...DEFAULT_SETTINGS }, credentials: '', accounts: {}, items: {}, jobs: [], flags: {} };
    if (!existsSync(this.file)) return fresh;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as State;
      // Fill in settings added in later versions.
      s.settings = { ...DEFAULT_SETTINGS, ...s.settings, routes: { ...DEFAULT_SETTINGS.routes, ...s.settings?.routes } };
      s.accounts ??= {};
      s.items ??= {};
      s.jobs ??= [];
      s.flags ??= {};
      // A job that was running when the app quit starts over from its first unfinished step.
      for (const j of s.jobs) if (j.status === 'running') j.status = 'waiting';
      return s;
    } catch (e) {
      // Keep the broken file for inspection rather than overwriting it.
      const bad = this.file + '.broken-' + Date.now();
      renameSync(this.file, bad);
      this.host.log(`state file was unreadable (${(e as Error).message}); moved to ${bad}`);
      return fresh;
    }
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mark state changed: listeners hear now, the file is written shortly after. */
  changed() {
    for (const fn of this.listeners) fn();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.file);
  }

  get settings(): Settings {
    return this.state.settings;
  }

  credentials(): Credentials {
    if (!this.state.credentials) return {};
    try {
      return JSON.parse(this.host.decrypt(this.state.credentials)) as Credentials;
    } catch {
      return {};
    }
  }

  setCredentials(c: Credentials) {
    this.state.credentials = this.host.encrypt(JSON.stringify(c));
    this.changed();
  }
}
