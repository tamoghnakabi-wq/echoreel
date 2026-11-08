import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { download, fingerprint, isVertical, prepare, probe, sameVideo } from './media';
import type { Connected, Ctx, PlatformApi, Session } from './platforms/common';
import { connectInstagram, instagram } from './platforms/instagram';
import { connectTikTok, tiktok } from './platforms/tiktok';
import { connectYouTube, youtube } from './platforms/youtube';
import { Store } from './store';
import { FileTunnel } from './tunnel';
import {
  AuthError,
  PermanentError,
  PLATFORM_NAMES,
  PLATFORMS,
  type Account,
  type Credentials,
  type Host,
  type Hosts,
  type Item,
  type Job,
  type Platform,
  type RemoteVideo,
  type Settings,
  type Target,
  type Tokens,
  type Tools,
} from './types';
import { clip, newId, titleFrom } from './util';

const APIS: Record<Platform, PlatformApi> = { youtube, instagram, tiktok };
const RETRY_MINUTES = [1, 5, 15, 60, 180];
const SHORTS_ONLY = 'not a Short (Rules → "Only relay YouTube Shorts")';
/** Never relay a video that was already this old when Echoreel first saw it. */
const MAX_AGE_MS = 7 * 86400_000;
/** How long a hand-finished upload (TikTok inbox, YouTube Studio) is expected to show up. */
const ACTION_WINDOW_MS = 7 * 86400_000;

export interface PostRequest {
  file: string;
  title: string;
  caption: string;
  platforms: Platform[];
}

export class Engine {
  store: Store;
  tunnel: FileTunnel;
  private checking = new Set<Platform>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing = new Map<Platform, Promise<string>>();
  /** live progress of the running job, for the UI (not saved) */
  progress: { jobId: string; platform?: Platform; label: string; pct?: number } | null = null;

  constructor(
    public host: Host,
    public tools: Tools,
    public hosts: Hosts,
    opts: { tunnelBase?: string } = {},
  ) {
    this.store = new Store(host);
    this.tunnel = new FileTunnel(tools, (m) => host.log(m), opts.tunnelBase);
    // Jobs that can no longer move (Echoreel 0.1.0 could leave these behind) get their final status.
    for (const j of this.store.state.jobs) if (j.status === 'waiting' && !j.targets.some((t) => t.status === 'pending')) this.settle(j);
  }

  get settings(): Settings {
    return this.store.settings;
  }

  private ctx(): Ctx {
    return {
      hosts: this.hosts,
      creds: this.store.credentials(),
      settings: this.settings,
      tunnel: this.tunnel,
      log: (m) => this.host.log(m),
      openExternal: (u) => this.host.openExternal(u),
    };
  }

  start(tickMs = 15_000) {
    if (this.timer) return;
    const tick = () => {
      void this.tick().finally(() => (this.timer = setTimeout(tick, tickMs)));
    };
    this.timer = setTimeout(tick, 1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.tunnel.close();
    this.store.flush();
  }

  /** One pass: look at accounts that are due, then work through due jobs. */
  async tick() {
    if (!this.settings.paused) {
      const due = Date.now() - this.settings.pollMinutes * 60_000;
      for (const p of PLATFORMS) {
        const a = this.store.state.accounts[p];
        if (a && a.status === 'ok' && (a.lastCheckAt ?? 0) < due) await this.check(p).catch(() => {});
      }
    }
    await this.work();
    this.cleanup();
  }

  // ---------- accounts ----------

  /** Save developer-app credentials; an empty/missing field keeps the saved value. */
  setCredentials(c: { google?: Partial<NonNullable<Credentials['google']>>; tiktok?: Partial<NonNullable<Credentials['tiktok']>> }) {
    const cur = this.store.credentials();
    const keep = <T extends object>(old: T | undefined, next: Partial<T> | undefined): T | undefined => {
      if (!next) return old;
      const out: any = { ...old };
      for (const [k, v] of Object.entries(next)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      return out;
    };
    this.store.setCredentials({ google: keep(cur.google, c.google), tiktok: keep(cur.tiktok, c.tiktok) });
  }

  async connect(platform: Platform, input?: { token?: string }) {
    const ctx = this.ctx();
    let c: Connected;
    if (platform === 'youtube') c = await connectYouTube(ctx);
    else if (platform === 'tiktok') c = await connectTikTok(ctx);
    else c = await connectInstagram(ctx, input?.token ?? '');
    const prev = this.store.state.accounts[platform];
    const same = prev?.id === c.account.id;
    const account: Account = {
      ...c.account,
      tokens: this.host.encrypt(JSON.stringify(c.tokens)),
      connectedAt: same ? prev!.connectedAt : Date.now(),
      baselineDone: same ? prev!.baselineDone : false,
      status: 'ok',
    };
    this.store.state.accounts[platform] = account;
    this.store.changed();
    this.host.log(`connected ${PLATFORM_NAMES[platform]} as ${account.name}`);
    // Record what's already there so it is never relayed.
    await this.check(platform).catch((e) => this.host.log(`first check of ${platform} failed: ${e.message}`));
    return account;
  }

  disconnect(platform: Platform) {
    delete this.store.state.accounts[platform];
    this.store.changed();
  }

  private tokens(a: Account): Tokens {
    return JSON.parse(this.host.decrypt(a.tokens));
  }

  private session(p: Platform): Session {
    const account = this.store.state.accounts[p];
    if (!account) throw new AuthError(`${PLATFORM_NAMES[p]} isn't connected`);
    return { account, token: () => this.accessToken(p) };
  }

  /** A valid access token, refreshing it first when it is close to expiring. */
  private accessToken(p: Platform): Promise<string> {
    const a = this.store.state.accounts[p];
    if (!a) return Promise.reject(new AuthError(`${PLATFORM_NAMES[p]} isn't connected`));
    const t = this.tokens(a);
    const stale =
      p === 'instagram'
        ? Date.now() - (t.issuedAt ?? 0) > 5 * 86400_000 || (t.expiresAt ?? Infinity) < Date.now() + 86400_000
        : (t.expiresAt ?? 0) < Date.now() + 5 * 60_000;
    if (!stale) return Promise.resolve(t.access);
    let pending = this.refreshing.get(p);
    if (!pending) {
      pending = APIS[p]
        .refresh(this.ctx(), t)
        .then((fresh) => {
          const cur = this.store.state.accounts[p];
          if (cur) {
            cur.tokens = this.host.encrypt(JSON.stringify(fresh));
            this.store.changed();
          }
          return fresh.access;
        })
        .catch((e) => {
          // An Instagram token that can't be extended yet is still usable until it expires.
          if (p === 'instagram' && !(e instanceof AuthError) && (t.expiresAt ?? 0) > Date.now()) return t.access;
          throw e;
        })
        .finally(() => this.refreshing.delete(p));
      this.refreshing.set(p, pending);
    }
    return pending;
  }

  private authFailed(p: Platform, e: Error) {
    const a = this.store.state.accounts[p];
    if (!a || a.status === 'reconnect') return;
    a.status = 'reconnect';
    a.statusMessage = e.message;
    this.store.changed();
    this.host.notify(`${PLATFORM_NAMES[p]} needs you to reconnect`, e.message);
  }

  // ---------- watching ----------

  /** Look for new videos on one account. */
  async check(p: Platform) {
    if (this.checking.has(p)) return;
    const a = this.store.state.accounts[p];
    if (!a) return;
    this.checking.add(p);
    try {
      const vids = await APIS[p].listRecent(this.ctx(), this.session(p));
      a.lastCheckAt = Date.now();
      a.lastCheckError = undefined;
      // Oldest first, so jobs are created in posting order.
      for (const v of vids.sort((x, y) => x.createdAt - y.createdAt)) this.consider(a, v);
      if (!a.baselineDone) {
        a.baselineDone = true;
        this.host.log(`${PLATFORM_NAMES[p]}: ${vids.length} existing video(s) marked as already posted`);
      }
      this.store.changed();
    } catch (e) {
      a.lastCheckAt = Date.now();
      a.lastCheckError = (e as Error).message;
      this.store.changed();
      if (e instanceof AuthError) this.authFailed(p, e);
      this.host.log(`check ${p} failed: ${(e as Error).message}`);
      throw e;
    } finally {
      this.checking.delete(p);
    }
  }

  private consider(a: Account, v: RemoteVideo) {
    const key = `${v.platform}:${v.id}`;
    if (this.store.state.items[key]) return;
    const base: Item = { key, platform: v.platform, id: v.id, url: v.url, title: v.title, thumbnail: v.thumbnail, createdAt: v.createdAt, seenAt: Date.now(), status: 'baseline' };
    const save = (status: Item['status'], reason?: string, extra: Partial<Item> = {}) => {
      this.store.state.items[key] = { ...base, status, reason, ...extra };
    };
    if (!a.baselineDone) return save('baseline', 'was already on the account when it was connected');
    if (v.createdAt < a.connectedAt - 60_000 || Date.now() - v.createdAt > MAX_AGE_MS) return save('baseline', 'older than the connection');
    // A video Echoreel itself posted there.
    const mine = this.targetById(v.platform, v.id);
    if (mine) return save('echo', `Echoreel posted this from ${this.describeSource(mine.job)}`, { matchJobId: mine.job.id });
    // Not public yet: look again next time.
    if (!v.ready) return;

    const dests = this.destinations(v.platform);
    if (!dests.length) return save('skipped', 'no other connected platform is switched on for it in Rules');
    // Too long to be a Short: no need to download it to find that out.
    if (v.platform === 'youtube' && this.settings.youtubeShortsOnly && (v.duration ?? 0) > 180.5) return save('skipped', SHORTS_ONLY);
    const job = this.newJob({
      source: key,
      sourcePlatform: v.platform,
      sourceUrl: v.url,
      title: v.title,
      caption: v.caption,
      thumbnail: v.thumbnail,
      duration: v.duration,
      width: v.width,
      height: v.height,
      platforms: dests,
      remote: v,
    });
    save('queued', undefined, { jobId: job.id });
  }

  private destinations(from: Platform): Platform[] {
    return PLATFORMS.filter((to) => to !== from && this.settings.routes[from]?.[to] && this.store.state.accounts[to]);
  }

  private targetById(p: Platform, id: string) {
    for (const job of this.store.state.jobs) for (const t of job.targets) if (t.platform === p && t.resultId === id) return { job, t };
    return null;
  }

  private describeSource(job: Job) {
    return job.sourcePlatform ? PLATFORM_NAMES[job.sourcePlatform] : 'the app';
  }

  // ---------- jobs ----------

  private newJob(o: {
    source: string;
    sourcePlatform?: Platform;
    sourceUrl?: string;
    title: string;
    caption: string;
    thumbnail?: string;
    duration?: number;
    width?: number;
    height?: number;
    platforms: Platform[];
    remote?: RemoteVideo;
    file?: string;
    approved?: boolean;
  }): Job {
    const s = this.settings;
    const job: Job = {
      id: newId(),
      createdAt: Date.now(),
      source: o.source,
      sourcePlatform: o.sourcePlatform,
      sourceUrl: o.remote?.downloadUrl ?? o.sourceUrl,
      title: o.title,
      caption: o.caption,
      thumbnail: o.thumbnail,
      status: 'waiting',
      approved: !!o.approved || s.approval === 'auto',
      direct: !!o.remote?.direct,
      notBefore: o.approved ? Date.now() : Date.now() + s.holdMinutes * 60_000,
      file: o.file,
      duration: o.duration,
      width: o.width,
      height: o.height,
      targets: o.platforms.map((p) => this.newTarget(p, o.title, o.caption)),
      log: [],
    };
    this.store.state.jobs.unshift(job);
    this.store.changed();
    return job;
  }

  private newTarget(p: Platform, title: string, caption: string): Target {
    const s = this.settings;
    const mode = p === 'youtube' ? s.youtubeMode : p === 'tiktok' ? s.tiktokMode : 'api';
    let t = titleFrom(title || caption);
    if (p === 'youtube' && s.addShortsTag && !/#shorts/i.test(t) && t.length < 92) t += ' #Shorts';
    return { platform: p, status: 'pending', mode, title: t, caption: caption.trim() || title, attempts: 0 };
  }

  /** Post a file from this computer to the chosen platforms. */
  async post(req: PostRequest): Promise<Job> {
    if (!existsSync(req.file)) throw new Error('That file no longer exists.');
    const platforms = req.platforms.filter((p) => this.store.state.accounts[p]);
    if (!platforms.length) throw new Error('Pick at least one connected platform.');
    const job = this.newJob({ source: `upload:${basename(req.file)}`, title: req.title, caption: req.caption, platforms, approved: true });
    // Copy the video first (a large file takes a while), and keep the job out of the queue meanwhile.
    job.status = 'running';
    this.logJob(job, 'copying the video');
    this.store.changed();
    const dest = join(this.jobDir(job), 'source' + (extname(req.file) || '.mp4'));
    try {
      await copyFile(req.file, dest);
    } catch (e) {
      this.store.state.jobs = this.store.state.jobs.filter((j) => j !== job);
      this.store.changed();
      throw new Error(`Couldn't copy the video: ${(e as Error).message}`);
    }
    job.file = dest;
    job.status = 'waiting';
    this.store.changed();
    void this.work();
    return job;
  }

  approve(jobId: string, edits?: { platform: Platform; title?: string; caption?: string; skip?: boolean }[]) {
    const job = this.job(jobId);
    for (const e of edits ?? []) {
      const t = job.targets.find((x) => x.platform === e.platform);
      if (!t) continue;
      if (e.title !== undefined) t.title = e.title;
      if (e.caption !== undefined) t.caption = e.caption;
      if (e.skip && t.status === 'pending') t.status = 'skipped';
    }
    job.approved = true;
    if (job.status === 'approval') {
      job.status = 'waiting';
      job.notBefore = Date.now();
      this.settle(job);
      if ((job.status as Job['status']) === 'cancelled') {
        this.logJob(job, 'not relayed: every destination was switched off');
        const item = this.store.state.items[job.source];
        if (item) item.status = 'ignored';
      }
    }
    this.store.changed();
    void this.work();
  }

  cancel(jobId: string) {
    const job = this.job(jobId);
    if (job.status === 'running') throw new Error('It is being posted right now; cancel once this step finishes.');
    job.status = 'cancelled';
    this.logJob(job, 'cancelled by you');
    const item = this.store.state.items[job.source];
    if (item) item.status = 'ignored';
    this.store.changed();
  }

  retry(jobId: string) {
    const job = this.job(jobId);
    for (const t of job.targets)
      if (t.status === 'failed') {
        t.status = 'pending';
        t.attempts = 0;
        t.nextAttemptAt = undefined;
        t.error = undefined;
      }
    job.status = 'waiting';
    job.notBefore = Date.now();
    job.error = undefined;
    this.store.changed();
    void this.work();
  }

  /** The user finished a hand-off target (TikTok inbox / YouTube Studio) themselves. */
  markDone(jobId: string, platform: Platform) {
    const t = this.job(jobId).targets.find((x) => x.platform === platform);
    if (t && t.status === 'action') {
      t.status = 'done';
      t.doneAt = Date.now();
      this.settle(this.job(jobId));
      this.store.changed();
    }
  }

  /** Relay a video that Echoreel recorded as already posted / skipped. */
  relayItem(key: string) {
    const item = this.store.state.items[key];
    if (!item) throw new Error('unknown video');
    const dests = this.destinations(item.platform);
    if (!dests.length) throw new Error('No other connected platform is switched on for it in Rules.');
    const job = this.newJob({
      source: key,
      sourcePlatform: item.platform,
      sourceUrl: item.platform === 'youtube' ? this.hosts.youtubeWatch(item.id) : item.url,
      title: item.title,
      caption: item.title,
      thumbnail: item.thumbnail,
      platforms: dests,
      approved: true,
    });
    job.forced = true;
    item.status = 'queued';
    item.jobId = job.id;
    this.store.changed();
    void this.work();
    return job;
  }

  job(id: string) {
    const j = this.store.state.jobs.find((x) => x.id === id);
    if (!j) throw new Error('unknown job');
    return j;
  }

  private jobDir(job: Job) {
    const d = join(this.host.dataDir, 'media', job.id);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private logJob(job: Job, msg: string, level: 'info' | 'warn' | 'error' = 'info') {
    job.log.push({ t: Date.now(), msg, level });
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    this.host.log(`[${job.id}] ${msg}`);
    this.store.changed();
  }

  private setProgress(job: Job, label: string, platform?: Platform, pct?: number) {
    this.progress = { jobId: job.id, platform, label, pct };
    this.store.changed();
  }

  /** Set while an update waits to install: no new job starts. */
  private holding = false;

  /** Whether a job is being worked on right now. */
  get working(): boolean {
    return !!this.workLoop;
  }

  /** Stop starting jobs and wait (up to `timeoutMs`) for the one in progress. True once nothing runs. */
  async drain(timeoutMs: number): Promise<boolean> {
    this.holding = true;
    const until = Date.now() + timeoutMs;
    while (this.workLoop && Date.now() < until) await Promise.race([this.workLoop.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    return !this.workLoop;
  }

  /** Undo drain(). */
  resume() {
    this.holding = false;
    void this.work();
  }

  /** Run due jobs one at a time. Calling it while it runs returns the same run (which picks up new jobs). */
  private workLoop: Promise<void> | null = null;
  work(): Promise<void> {
    if (!this.workLoop) this.workLoop = this.loop().finally(() => (this.workLoop = null));
    return this.workLoop;
  }

  private async loop() {
    try {
      for (;;) {
        const now = Date.now();
        const job = this.store.state.jobs
          .slice()
          .reverse()
          .find((j) => j.status === 'waiting' && j.notBefore <= now && j.targets.some((t) => t.status === 'pending' && (t.nextAttemptAt ?? 0) <= now));
        if (!job || this.settings.paused || this.holding) break;
        await this.runJob(job);
      }
    } finally {
      this.progress = null;
      this.store.changed();
    }
  }

  private async runJob(job: Job) {
    job.status = 'running';
    this.store.changed();
    const dir = this.jobDir(job);
    try {
      // 1. Get the video.
      if (!job.file || !existsSync(job.file)) {
        if (!job.sourceUrl) throw new PermanentError('the video file is missing; post it again');
        this.logJob(job, `downloading from ${this.describeSource(job)}`);
        this.setProgress(job, 'Downloading');
        job.file = await download(this.tools, job.sourceUrl, !!job.direct, dir, this.settings, (pct) => this.setProgress(job, 'Downloading', undefined, pct));
      }
      // 2. Look at it.
      const info = await probe(this.tools, job.file);
      job.duration = info.duration;
      job.width = info.width;
      job.height = info.height;
      if (!job.fingerprint?.length) job.fingerprint = await fingerprint(this.tools, job.file, info.duration);
      this.logJob(job, `video: ${info.width}×${info.height}, ${info.duration.toFixed(1)} s, ${(info.size / 1e6).toFixed(1)} MB`);

      // 3. Is it really new? (A copy Echoreel posted coming back, or a re-upload.)
      if (job.sourcePlatform && !job.forced) {
        const match = this.findEcho(job);
        if (match) {
          const item = this.store.state.items[job.source];
          job.status = 'cancelled';
          this.logJob(job, `not relayed: ${match.reason}`);
          if (item) {
            item.status = match.kind;
            item.reason = match.reason;
            item.matchJobId = match.job.id;
          }
          if (match.target && match.target.status === 'action') {
            match.target.status = 'done';
            match.target.doneAt = Date.now();
            match.target.resultId = item?.id;
            match.target.resultUrl = item?.url;
            this.settle(match.job);
          }
          this.store.changed();
          return;
        }
        if (job.sourcePlatform === 'youtube' && this.settings.youtubeShortsOnly && !(isVertical(info) && info.duration <= 180.5)) {
          job.status = 'cancelled';
          const item = this.store.state.items[job.source];
          if (item) {
            item.status = 'skipped';
            item.reason = SHORTS_ONLY;
          }
          this.logJob(job, 'skipped: not a Short (vertical and up to 3 minutes)');
          return;
        }
      }

      // 4. Wait for the user's OK if Rules ask for it.
      if (!job.approved) {
        job.status = 'approval';
        this.logJob(job, 'waiting for your OK');
        this.host.notify(`New ${job.sourcePlatform ? PLATFORM_NAMES[job.sourcePlatform] : ''} video`, `"${clip(job.title, 60)}" is waiting for your OK to be relayed.`, job.id);
        return;
      }

      // 5. Post to each destination.
      for (const t of job.targets) {
        if (t.status !== 'pending' || (t.nextAttemptAt ?? 0) > Date.now()) continue;
        if (this.settings.paused) break;
        await this.runTarget(job, t, info, dir);
      }
      const item = this.store.state.items[job.source];
      if (item && item.status === 'queued') item.status = 'relayed';
    } catch (e) {
      const err = e as Error;
      // Failing before any destination (download/probe): retry the whole job later.
      if (e instanceof PermanentError) {
        for (const t of job.targets) if (t.status === 'pending') ((t.status = 'failed'), (t.error = err.message));
        this.logJob(job, err.message, 'error');
      } else {
        const n = Math.max(...job.targets.map((t) => t.attempts)) + 1;
        for (const t of job.targets) if (t.status === 'pending') t.attempts = n;
        const wait = RETRY_MINUTES[Math.min(n - 1, RETRY_MINUTES.length - 1)];
        if (n > RETRY_MINUTES.length) {
          for (const t of job.targets) if (t.status === 'pending') ((t.status = 'failed'), (t.error = err.message));
          this.logJob(job, `giving up: ${err.message}`, 'error');
        } else {
          job.notBefore = Date.now() + wait * 60_000;
          this.logJob(job, `${err.message} — trying again in ${wait} min`, 'warn');
        }
      }
    } finally {
      this.settle(job);
      this.store.changed();
    }
  }

  private async runTarget(job: Job, t: Target, info: Awaited<ReturnType<typeof probe>>, dir: string) {
    const name = PLATFORM_NAMES[t.platform];
    try {
      t.status = 'preparing';
      this.setProgress(job, `Preparing for ${name}`, t.platform);
      if (!t.file || !existsSync(t.file)) {
        t.file = await prepare(this.tools, job.file!, info, t.platform, this.settings, dir, (pct) => this.setProgress(job, `Preparing for ${name}`, t.platform, pct));
        const out = await probe(this.tools, t.file);
        t.duration = out.duration;
        t.fingerprint = t.file === job.file ? job.fingerprint : await fingerprint(this.tools, t.file, out.duration);
      }
      const result = await APIS[t.platform].publish(this.ctx(), this.session(t.platform), t, job, {
        stage: (status, note) => {
          t.status = status;
          this.setProgress(job, note ?? `${status === 'uploading' ? 'Uploading to' : 'Waiting for'} ${name}`, t.platform);
        },
        progress: (pct) => this.setProgress(job, `Uploading to ${name}`, t.platform, pct),
      });
      t.status = result.status;
      t.resultId = result.resultId;
      t.resultUrl = result.resultUrl;
      t.action = result.action;
      t.handle = result.handle ?? t.handle;
      t.error = undefined;
      if (result.status === 'done') t.doneAt = Date.now();
      this.logJob(job, result.status === 'done' ? `posted to ${name}${result.resultUrl ? ': ' + result.resultUrl : ''}` : `${name}: ready for you to finish`);
      if (result.status === 'action') this.host.notify(`Finish posting on ${name}`, `"${clip(t.title, 50)}" — ${result.action}`, job.id);
    } catch (e) {
      const err = e as Error;
      t.error = err.message;
      if (e instanceof AuthError) {
        t.status = 'failed';
        this.authFailed(t.platform, err);
        this.logJob(job, `${name}: ${err.message}`, 'error');
      } else if (e instanceof PermanentError) {
        t.status = 'failed';
        this.logJob(job, `${name}: ${err.message}`, 'error');
      } else {
        t.attempts++;
        if (t.attempts > RETRY_MINUTES.length) {
          t.status = 'failed';
          this.logJob(job, `${name}: giving up after ${t.attempts} tries: ${err.message}`, 'error');
        } else {
          const wait = RETRY_MINUTES[t.attempts - 1];
          t.status = 'pending';
          t.nextAttemptAt = Date.now() + wait * 60_000;
          this.logJob(job, `${name}: ${err.message} — trying again in ${wait} min`, 'warn');
        }
      }
    }
  }

  /** Work out a job's overall status from its targets. */
  private settle(job: Job) {
    if (job.status === 'cancelled' || job.status === 'approval') return;
    const ts = job.targets;
    // Every destination switched off: nothing to post.
    if (ts.every((t) => t.status === 'skipped')) {
      job.status = 'cancelled';
      return;
    }
    if (ts.some((t) => t.status === 'pending')) {
      job.status = 'waiting';
      const next = Math.min(...ts.filter((t) => t.status === 'pending').map((t) => t.nextAttemptAt ?? 0));
      job.notBefore = Math.max(job.notBefore, next);
      return;
    }
    const prev = job.status;
    const failed = ts.filter((t) => t.status === 'failed').length;
    const ok = ts.filter((t) => t.status === 'done' || t.status === 'action' || t.status === 'skipped').length;
    job.status = failed === 0 ? 'done' : ok > 0 ? 'partial' : 'failed';
    if (prev !== job.status && prev === 'running') {
      const posted = ts.filter((t) => t.status === 'done').map((t) => PLATFORM_NAMES[t.platform]);
      if (job.status === 'done' && posted.length) this.host.notify('Relayed', `"${clip(job.title, 50)}" is now on ${posted.join(' and ')}.`, job.id);
      if (failed) this.host.notify(job.status === 'failed' ? 'Relay failed' : 'Relay partly failed', `"${clip(job.title, 50)}": ${ts.find((t) => t.status === 'failed')?.error ?? ''}`, job.id);
    }
  }

  /**
   * Is this "new" video one Echoreel already knows? Checks, newest first:
   *  - a hand-finished upload (TikTok inbox / YouTube Studio) on this platform with the same length,
   *  - any recent video (source or a prepared copy) whose frames match.
   */
  private findEcho(job: Job): { kind: 'echo' | 'duplicate'; job: Job; target?: Target; reason: string } | null {
    const p = job.sourcePlatform!;
    const now = Date.now();
    for (const other of this.store.state.jobs) {
      if (other.id === job.id || now - other.createdAt > 30 * 86400_000) continue;
      for (const t of other.targets) {
        if (t.platform !== p || !t.duration || !job.duration) continue;
        const gap = Math.abs(t.duration - job.duration);
        if (t.status === 'action' && now - other.createdAt < ACTION_WINDOW_MS && gap <= 2 && sameVideo(t.fingerprint, job.fingerprint, true))
          return { kind: 'echo', job: other, target: t, reason: `this is the copy you finished posting from Echoreel (from ${this.describeSource(other)})` };
        if (gap <= 1 && sameVideo(t.fingerprint, job.fingerprint)) return { kind: 'echo', job: other, target: t, reason: `Echoreel already posted this video here (from ${this.describeSource(other)})` };
      }
      if (other.duration && job.duration && Math.abs(other.duration - job.duration) <= 1 && sameVideo(other.fingerprint, job.fingerprint))
        return { kind: 'duplicate', job: other, reason: `same video as one already relayed from ${this.describeSource(other)}` };
    }
    return null;
  }

  /** Delete downloaded/prepared files after a while and keep the history a sensible size. */
  private lastCleanup = 0;
  cleanup(force = false) {
    if (!force && Date.now() - this.lastCleanup < 3600_000) return;
    this.lastCleanup = Date.now();
    const keep = this.settings.keepDays * 86400_000;
    const media = join(this.host.dataDir, 'media');
    const busy = new Set(this.store.state.jobs.filter((j) => ['waiting', 'running', 'approval'].includes(j.status) || j.targets.some((t) => t.status === 'action')).map((j) => j.id));
    if (existsSync(media))
      for (const d of readdirSync(media)) {
        const p = join(media, d);
        try {
          if (!busy.has(d) && Date.now() - statSync(p).mtimeMs > keep) rmSync(p, { recursive: true, force: true });
        } catch {
          /* in use */
        }
      }
    const jobs = this.store.state.jobs;
    if (jobs.length > 300) this.store.state.jobs = jobs.filter((j, i) => i < 300 || busy.has(j.id));
    const items = Object.values(this.store.state.items).sort((a, b) => b.seenAt - a.seenAt);
    if (items.length > 2000) for (const it of items.slice(2000)) delete this.store.state.items[it.key];
    this.store.changed();
  }

  /** Snapshot for the UI (no secrets). */
  view() {
    const s = this.store.state;
    const creds = this.store.credentials();
    return {
      settings: s.settings,
      credentials: {
        google: creds.google ? { clientId: creds.google.clientId, hasSecret: !!creds.google.clientSecret } : null,
        tiktok: creds.tiktok ? { clientKey: creds.tiktok.clientKey, hasSecret: !!creds.tiktok.clientSecret } : null,
      },
      accounts: Object.fromEntries(
        PLATFORMS.map((p) => {
          const a = s.accounts[p];
          if (!a) return [p, null];
          const { tokens, ...rest } = a;
          let expiresAt: number | undefined;
          try {
            expiresAt = this.tokens(a).expiresAt;
          } catch {
            /* unreadable */
          }
          return [p, { ...rest, tokenExpiresAt: p === 'instagram' ? expiresAt : undefined }];
        }),
      ),
      jobs: s.jobs.slice(0, 100),
      items: Object.values(s.items)
        .sort((a, b) => b.seenAt - a.seenAt)
        .slice(0, 60),
      progress: this.progress,
      checking: [...this.checking],
    };
  }
}
