import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify, type Hash } from 'node:crypto';
import { accessSync, constants, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Self-updater (same design as Wren's). Every GitHub release carries `echoreel-update.json`:
// per platform the installer's URL, sha256, size and an ed25519 signature over
// `echoreel-update:v1:<version>:<platform>:<sha256>:<size>`, checked against the public key built
// into the app, so only builds signed with the release key are ever installed. Downloads go through
// Chromium's network stack (`net.fetch`: system proxy, OS certificates), resume after a drop, and
// install by swapping the app bundle after quit (macOS) or running the per-user installer silently
// (Windows). The app then opens again on its own.

const REPO = 'tamoghnakabi-wq/echoreel';
const FEED = process.env.ECHOREEL_UPDATE_URL || `https://github.com/${REPO}/releases/latest/download/echoreel-update.json`;
/** Where installers may come from: this repository's releases (or, when testing with ECHOREEL_UPDATE_URL, that server). */
const DOWNLOAD_PREFIX = process.env.ECHOREEL_UPDATE_URL ? new URL('/', process.env.ECHOREEL_UPDATE_URL).href : `https://github.com/${REPO}/releases/download/`;

const PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAur+WCUJrjDgOmZfHiS0W0iaYgxKITcbuEFL38gffU9s=
-----END PUBLIC KEY-----`);

/** A download that receives nothing for this long is dropped and resumed later. */
const STALL_MS = 2 * 60_000;
/** Waits before trying again after a failure: 5 minutes, 15 minutes, then hourly. */
const RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface UpdateInfo {
  version: string;
  notes?: string;
  url: string;
  sha256: string;
  size: number;
  signature: string;
}

/** What the window shows. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  /** The newer version being downloaded or ready. */
  version?: string;
  notes?: string;
  received?: number;
  total?: number;
  error?: string;
  /** When the next try after a failure runs (ms since the epoch). */
  retryAt?: number;
  checkedAt?: number;
  /** Why installing can't happen from where the app runs (e.g. still on the disk image). */
  blocked?: string;
}

export interface UpdaterHost {
  dataDir: () => string;
  log: (msg: string) => void;
  onChange: () => void;
  /** Stop starting new work and wait for the upload in progress. True once nothing is running. */
  drain: (timeoutMs: number) => Promise<boolean>;
  /** Undo drain() when the install doesn't go ahead. */
  resume: () => void;
  /** Quit for good (the installer takes over). */
  quit: () => void;
}

export const platformKey = () => `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function signedPayload(u: Pick<UpdateInfo, 'version' | 'sha256' | 'size'>, platform = platformKey()) {
  return `echoreel-update:v1:${u.version}:${platform}:${u.sha256}:${u.size}`;
}

function verifySignature(u: UpdateInfo, platform = platformKey()): boolean {
  try {
    return verify(null, Buffer.from(signedPayload(u, platform)), PUBLIC_KEY, Buffer.from(u.signature, 'base64'));
  } catch {
    return false;
  }
}

/** Feed the first `bytes` bytes of `file` into `hash`. */
async function hashFile(hash: Hash, file: string, bytes: number) {
  if (bytes <= 0) return;
  await pipeline(
    createReadStream(file, { end: bytes - 1 }),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
}

/** Rename, retrying for a few seconds: on Windows an antivirus scan can hold a just-written file. */
async function renameSettled(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Why this copy of the app can't replace itself, or null if it can. */
export function installBlocked(): string | null {
  if (!app.isPackaged) return 'Updates install only in the packaged app.';
  if (process.platform === 'win32') return null;
  if (process.platform !== 'darwin') return 'Automatic updates are for macOS and Windows.';
  const bundle = resolve(dirname(process.execPath), '..', '..');
  if (!bundle.endsWith('.app')) return 'Echoreel isn’t running from its app bundle.';
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/'))
    return 'Echoreel is running from the downloaded disk image or Downloads folder. Move it to Applications so it can update itself.';
  try {
    accessSync(dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
  } catch {
    return `Echoreel can’t replace itself in ${dirname(bundle)} (no permission). Move it to your Applications folder.`;
  }
  return null;
}

interface Pending {
  version: string;
  pid?: number;
  at: number;
  /** Show the window once the new version opens (the user asked for the restart). */
  show: boolean;
}

export class Updater {
  state: UpdateState = { status: 'idle' };
  private ready?: { version: string; file: string; sha256: string; size: number };
  private busy = false;
  private failures = 0;
  private retryTimer?: NodeJS.Timeout;
  private reportedAt = 0;
  private installing = false;

  constructor(private readonly host: UpdaterHost) {}

  private get dir() {
    return this.host.dataDir();
  }
  private pendingPath() {
    return join(this.dir, 'update-pending.json');
  }

  /**
   * At startup. Returns 'installer-running' when an installer from the last run may still be at work
   * (the app should get out of its way), and whether the window should show after an update.
   * Also reports an install that didn't happen and deletes downloads of versions already installed.
   */
  startup(): { installerRunning: boolean; showAfterUpdate?: boolean } {
    let pending: Pending | null = null;
    try {
      pending = JSON.parse(readFileSync(this.pendingPath(), 'utf8'));
    } catch {
      /* no update was installed */
    }
    // The swap script writes update-failed.txt before it reopens the old version: then it's done.
    if (pending && pending.pid && pending.pid !== process.pid && !existsSync(join(this.dir, 'update-failed.txt')) && Date.now() - pending.at < 2 * 60_000 && compareVersions(app.getVersion(), pending.version) < 0) {
      try {
        process.kill(pending.pid, 0);
        return { installerRunning: true }; // it reopens the app when done
      } catch {
        /* gone */
      }
    }
    let showAfterUpdate: boolean | undefined;
    if (pending) {
      if (compareVersions(app.getVersion(), pending.version) < 0) {
        let why = '';
        try {
          why = readFileSync(join(this.dir, 'update-failed.txt'), 'utf8').trim();
        } catch {
          /* the installer left no reason */
        }
        this.state = { status: 'error', error: `Installing ${pending.version} didn’t work${why ? ` (${why})` : ''}. Echoreel will try again.` };
        this.host.log(`update: install of ${pending.version} failed: ${why || 'unknown reason'}`);
      } else {
        showAfterUpdate = pending.show;
        this.host.log(`update: now running ${app.getVersion()}`);
      }
      rmSync(this.pendingPath(), { force: true });
      rmSync(join(this.dir, 'update-failed.txt'), { force: true });
    }
    try {
      for (const d of readdirSync(this.dir)) if (/^install-/.test(d)) rmSync(join(this.dir, d), { recursive: true, force: true });
      const root = join(this.dir, 'updates');
      if (existsSync(root)) for (const v of readdirSync(root)) if (/^\d+\.\d+\.\d+/.test(v) && compareVersions(v, app.getVersion()) <= 0) rmSync(join(root, v), { recursive: true, force: true });
    } catch {
      /* clean-up is best effort */
    }
    return { installerRunning: false, showAfterUpdate };
  }

  /** The signed update for this platform from the newest release, or null if there's no release yet. */
  private async latest(): Promise<UpdateInfo | null> {
    const res = await net.fetch(FEED, { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Couldn’t check for updates (HTTP ${res.status}).`);
    const m = (await res.json()) as { version?: string; notes?: string; platforms?: Record<string, Omit<UpdateInfo, 'version' | 'notes'>> };
    const p = m.platforms?.[platformKey()];
    if (!m.version || !p) return null;
    const info: UpdateInfo = { version: m.version, notes: m.notes, url: p.url, sha256: p.sha256, size: p.size, signature: p.signature };
    if (typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.sha256) || !Number.isSafeInteger(info.size) || info.size <= 0) throw new Error('The update information is malformed.');
    if (!verifySignature(info)) throw new Error('The update failed signature verification and was ignored.');
    return info;
  }

  /** Look for a newer release and download it in the background. Returns once that's decided. */
  async check(): Promise<UpdateState> {
    if (this.busy || this.installing) return this.state;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return this.state;
    this.busy = true;
    let downloading = false;
    const prev = this.state;
    if (!this.ready) this.state = { ...prev, status: 'checking' };
    this.host.onChange();
    try {
      const info = await this.latest();
      // A validly signed *older* (or the same) release is never installed.
      if (!info || compareVersions(info.version, app.getVersion()) <= 0) {
        this.succeeded();
        if (!this.ready) this.state = { status: 'idle', checkedAt: Date.now() };
        return this.state;
      }
      if (this.ready && compareVersions(info.version, this.ready.version) <= 0) {
        this.state = { ...this.state, checkedAt: Date.now() };
        return this.state;
      }
      this.state = { status: 'downloading', version: info.version, notes: info.notes, received: 0, total: info.size, checkedAt: Date.now() };
      downloading = true;
      void this.fetchUpdate(info);
      return this.state;
    } catch (e) {
      this.host.log(`update: check failed: ${(e as Error).message}`);
      if (!this.ready) this.state = { status: 'error', error: (e as Error).message, retryAt: this.retryLater(), checkedAt: Date.now() };
      return this.state;
    } finally {
      if (!downloading) this.busy = false;
      this.host.onChange();
    }
  }

  private async fetchUpdate(info: UpdateInfo) {
    try {
      const file = await this.download(info);
      this.succeeded();
      this.ready = { version: info.version, file, sha256: info.sha256, size: info.size };
      this.state = { status: 'ready', version: info.version, notes: info.notes, checkedAt: Date.now(), blocked: installBlocked() ?? undefined };
      this.host.log(`update: ${info.version} downloaded`);
    } catch (e) {
      this.host.log(`update: download of ${info.version} failed: ${(e as Error).message}`);
      this.state = { status: 'error', version: info.version, error: (e as Error).message, retryAt: this.retryLater() };
    } finally {
      this.busy = false;
      this.host.onChange();
    }
  }

  get readyVersion(): string | null {
    return this.ready?.version ?? null;
  }

  private retryLater(): number {
    clearTimeout(this.retryTimer);
    const wait = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => void this.check(), wait);
    return Date.now() + wait;
  }

  private succeeded() {
    this.failures = 0;
    clearTimeout(this.retryTimer);
  }

  private progress(received: number) {
    this.state.received = received;
    if (Date.now() - this.reportedAt < 1000) return;
    this.reportedAt = Date.now();
    this.host.onChange();
  }

  private async download(info: UpdateInfo): Promise<string> {
    if (!info.url.startsWith(DOWNLOAD_PREFIX)) throw new Error('The update points somewhere unexpected and was ignored.');
    const dir = join(this.dir, 'updates', info.version);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, basename(new URL(info.url).pathname).replace(/[^\w.\-]/g, '_'));
    // Downloaded earlier but not installed yet: reuse it if it still checks out.
    if (existsSync(file)) {
      const hash = createHash('sha256');
      if (statSync(file).size === info.size) await hashFile(hash, file, info.size);
      if (hash.digest('hex') === info.sha256) return file;
      rmSync(file, { force: true });
    }
    // Bytes land in a .part file named after the signed hash, so a dropped connection resumes
    // where it stopped, and a re-published file never resumes from another file's bytes.
    const part = `${file}.${info.sha256.slice(0, 12)}.part`;
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have >= info.size) {
      rmSync(part, { force: true });
      have = 0;
    }
    const ctl = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        ctl.abort();
      }, STALL_MS);
    };
    let discard = false;
    try {
      alive();
      const res = await net.fetch(info.url, { signal: ctl.signal, cache: 'no-store', headers: have ? { Range: `bytes=${have}-` } : undefined });
      if (res.status === 206) {
        if (!(res.headers.get('content-range') ?? '').startsWith(`bytes ${have}-`)) {
          discard = true;
          throw new Error('The download server sent the wrong part of the file.');
        }
      } else if (res.ok) {
        have = 0; // the whole file is coming
      } else {
        discard = res.status === 416;
        throw new Error(`Download failed (HTTP ${res.status}).`);
      }
      if (!res.body) throw new Error('Download failed (empty response).');
      const hash = createHash('sha256');
      await hashFile(hash, part, have);
      let received = have;
      if (have) this.progress(have);
      const onBytes = (n: number) => this.progress(n);
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          alive();
          received += chunk.length;
          if (received > info.size) {
            discard = true;
            return cb(new Error('The download is larger than the signed update.'));
          }
          hash.update(chunk);
          onBytes(received);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(part, { flags: have ? 'a' : 'w' }));
      if (received < info.size) throw new Error('The connection closed before the download finished.');
      if (hash.digest('hex') !== info.sha256) {
        discard = true;
        throw new Error('The downloaded update didn’t match its signed checksum.');
      }
    } catch (e) {
      if (discard) rmSync(part, { force: true });
      if (stalled) throw new Error(`The download stopped receiving data for ${STALL_MS / 60_000} minutes.`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    await renameSettled(part, file);
    return file;
  }

  /** `--selftest --update`: fetch and verify the newest release for this platform through the real code path. */
  async selfTestDownload(): Promise<string> {
    const info = await this.latest();
    if (!info) return 'no release published yet';
    const file = await this.download(info);
    const bytes = statSync(file).size;
    rmSync(dirname(file), { recursive: true, force: true });
    return `${info.version}: ${(bytes / 1e6).toFixed(1)} MB, signature and checksum ok`;
  }

  /**
   * Install the downloaded update and reopen. Waits (up to `waitMs`) for an upload in progress to
   * finish first, so nothing is cut off halfway. `show`: open the window afterwards.
   */
  async install(show: boolean, waitMs = 15 * 60_000): Promise<'started' | 'failed' | 'busy'> {
    const r = this.ready;
    if (!r || this.installing) return 'busy';
    const blocked = installBlocked();
    if (blocked) {
      this.state = { ...this.state, blocked };
      this.host.onChange();
      return 'failed';
    }
    this.installing = true;
    this.state = { ...this.state, status: 'installing', error: undefined };
    this.host.onChange();
    let handedOff = false;
    try {
      if (!(await this.host.drain(waitMs))) throw new Error('An upload is still in progress. Echoreel will update once it finishes.');
      // Install from a private copy, hashed as it is made, so what runs is exactly what was signed.
      const priv = mkdtempSync(join(this.dir, 'install-'));
      const copy = join(priv, basename(r.file));
      const hash = createHash('sha256');
      let n = 0;
      await pipeline(
        createReadStream(r.file),
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            n += chunk.length;
            cb(null, chunk);
          },
        }),
        createWriteStream(copy, { flags: 'wx', mode: 0o700 }),
      );
      if (hash.digest('hex') !== r.sha256 || n !== r.size) {
        rmSync(r.file, { force: true });
        this.ready = undefined;
        throw new Error('The downloaded update changed on disk and was discarded. It will be downloaded again.');
      }
      handedOff = await this.launch(copy, r, show);
      return handedOff ? 'started' : 'failed';
    } catch (e) {
      this.host.log(`update: install failed: ${(e as Error).message}`);
      this.state = this.ready ? { status: 'ready', version: r.version, notes: this.state.notes, error: (e as Error).message } : { status: 'error', error: (e as Error).message };
      return 'failed';
    } finally {
      this.installing = false;
      if (!handedOff) {
        this.host.resume();
        this.host.onChange();
      }
    }
  }

  private async launch(copy: string, r: NonNullable<Updater['ready']>, show: boolean): Promise<boolean> {
    let cmd: string;
    let args: string[];
    if (process.platform === 'win32') {
      // The per-user NSIS installer: silent, reopens the app when done.
      cmd = copy;
      args = ['--updated', '/S', '--force-run'];
    } else {
      // macOS: swap <bundle> for the new one after this process exits. Paths are passed as
      // arguments, never pasted into the script. Any failure puts the old app back, reopens it
      // and leaves the reason for the next start.
      const bundle = resolve(dirname(process.execPath), '..', '..');
      const priv = dirname(copy);
      const script = join(priv, 'install.sh');
      writeFileSync(
        script,
        `#!/bin/bash
PID="$1"; FILE="$2"; STAGING="$3"; BUNDLE="$4"; SHA="$5"; REPORT="$6"; shift 6; REOPEN=("$@")
fail() { echo "$1" > "$REPORT"; [ -d "$BUNDLE" ] || { [ -d "$BUNDLE.old" ] && mv "$BUNDLE.old" "$BUNDLE"; }; /usr/bin/open "\${REOPEN[@]}"; exit 1; }
for i in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
kill -0 "$PID" 2>/dev/null && fail "the old version did not quit"
[ "$(/usr/bin/shasum -a 256 "$FILE" | /usr/bin/cut -d' ' -f1)" = "$SHA" ] || fail "the downloaded file changed on disk"
{ rm -rf "$STAGING" && mkdir -p "$STAGING"; } || fail "the update could not be prepared"
/usr/bin/ditto -x -k "$FILE" "$STAGING" || fail "the update could not be unpacked"
NEW="$(/usr/bin/find "$STAGING" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$NEW" ] || fail "the update did not contain the app"
[ "$(/usr/bin/defaults read "$NEW/Contents/Info.plist" CFBundleIdentifier 2>/dev/null)" = "app.echoreel.desktop" ] || fail "the update is not Echoreel"
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "$BUNDLE.old"
mv "$BUNDLE" "$BUNDLE.old" || fail "the current app could not be moved aside"
mv "$NEW" "$BUNDLE" || fail "the new app could not be put in place"
rm -rf "$BUNDLE.old" "$STAGING" "$FILE"
/usr/bin/open "\${REOPEN[@]}"
`,
        { mode: 0o700, flag: 'wx' },
      );
      // Reopen the way this copy was started: a copy with its own data folder (tests, portable use)
      // keeps it. On Windows the installer's child inherits the environment anyway.
      const env = ['ECHOREEL_DATA_DIR', 'ECHOREEL_UPDATE_URL', 'ECHOREEL_NO_NOTIFY'].filter((k) => process.env[k]).flatMap((k) => ['--env', `${k}=${process.env[k]}`]);
      const pass = process.argv.includes('--use-mock-keychain') ? ['--args', '--use-mock-keychain'] : [];
      cmd = '/bin/bash';
      args = [script, String(process.pid), copy, join(priv, 'staging'), bundle, r.sha256, join(this.dir, 'update-failed.txt'), ...env, bundle, ...pass];
    }
    rmSync(join(this.dir, 'update-failed.txt'), { force: true });
    const pending: Pending = { version: r.version, at: Date.now(), show };
    writeFileSync(this.pendingPath(), JSON.stringify(pending));
    const failed = await new Promise<Error | null>((done) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', done);
      child.once('spawn', () => {
        child.unref();
        try {
          writeFileSync(this.pendingPath(), JSON.stringify({ ...pending, pid: child.pid }));
        } catch {
          /* best effort: the marker above still says an install was started */
        }
        done(null);
      });
    });
    if (failed) {
      rmSync(this.pendingPath(), { force: true });
      throw new Error(`The installer couldn’t be started (${failed.message}).`);
    }
    this.host.log(`update: handing over to the installer for ${r.version}`);
    this.host.quit();
    return true;
  }
}
