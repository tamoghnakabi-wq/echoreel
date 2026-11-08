export type Platform = 'youtube' | 'instagram' | 'tiktok';
export const PLATFORMS: Platform[] = ['youtube', 'instagram', 'tiktok'];
export const PLATFORM_NAMES: Record<Platform, string> = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };

export interface Tokens {
  access: string;
  refresh?: string;
  /** ms epoch */
  expiresAt?: number;
  refreshExpiresAt?: number;
  /** when the token was issued or last refreshed (Instagram refreshes need it to be 24 h old) */
  issuedAt?: number;
}

export interface Account {
  platform: Platform;
  id: string;
  name: string;
  avatar?: string;
  /** Encrypted JSON of Tokens (see Vault). */
  tokens: string;
  connectedAt: number;
  /** Set once every video that existed at connect time has been recorded as "already there". */
  baselineDone: boolean;
  status: 'ok' | 'reconnect';
  statusMessage?: string;
  lastCheckAt?: number;
  lastCheckError?: string;
  /** Extra per-platform data, e.g. YouTube uploads playlist id. */
  extra?: Record<string, string>;
}

export interface Credentials {
  google?: { clientId: string; clientSecret: string };
  tiktok?: { clientKey: string; clientSecret: string };
}

export interface RemoteVideo {
  platform: Platform;
  id: string;
  url: string;
  /** What to hand the downloader (a URL yt-dlp understands, or a direct file URL). */
  downloadUrl?: string;
  /** True when downloadUrl is a plain file URL that can be fetched without yt-dlp. */
  direct?: boolean;
  title: string;
  caption: string;
  createdAt: number;
  /** seconds, when the API reports it */
  duration?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  /** false = not public yet (private, scheduled, still processing): look again later */
  ready: boolean;
}

export type ItemStatus = 'baseline' | 'echo' | 'duplicate' | 'skipped' | 'queued' | 'relayed' | 'origin' | 'ignored';

export interface Item {
  key: string; // `${platform}:${id}`
  platform: Platform;
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  createdAt: number;
  seenAt: number;
  status: ItemStatus;
  reason?: string;
  jobId?: string;
  /** For echoes/duplicates: the job the video came from. */
  matchJobId?: string;
}

export type TargetStatus = 'pending' | 'preparing' | 'uploading' | 'processing' | 'done' | 'action' | 'failed' | 'skipped';

export interface Target {
  platform: Platform;
  status: TargetStatus;
  /** youtube: api|assisted, tiktok: inbox|direct, instagram: api */
  mode: string;
  title: string;
  caption: string;
  file?: string;
  duration?: number;
  fingerprint?: string[];
  resultId?: string;
  resultUrl?: string;
  /** For 'action' targets: what the user still has to do. */
  action?: string;
  error?: string;
  attempts: number;
  nextAttemptAt?: number;
  doneAt?: number;
  /** The TikTok/YouTube upload handle, kept so a restart can resume checking it. */
  handle?: string;
}

export type JobStatus = 'waiting' | 'approval' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  createdAt: number;
  /** item key, or `upload:<filename>` for videos posted from the app */
  source: string;
  sourcePlatform?: Platform;
  sourceUrl?: string;
  title: string;
  caption: string;
  thumbnail?: string;
  status: JobStatus;
  /** Don't start before this time (the hold after a new upload). */
  notBefore: number;
  file?: string;
  duration?: number;
  width?: number;
  height?: number;
  fingerprint?: string[];
  targets: Target[];
  /** false = wait for the user's OK once the video has been checked */
  approved: boolean;
  /** sourceUrl is a plain file URL (no yt-dlp needed) */
  direct?: boolean;
  /** relay even if it looks like a video Echoreel already knows */
  forced?: boolean;
  log: { t: number; msg: string; level?: 'info' | 'warn' | 'error' }[];
  error?: string;
}

export interface Settings {
  pollMinutes: number;
  holdMinutes: number;
  approval: 'auto' | 'ask';
  routes: Record<Platform, Record<Platform, boolean>>;
  youtubeShortsOnly: boolean;
  makeVertical: boolean;
  youtubeMode: 'assisted' | 'api';
  youtubePrivacy: 'public' | 'unlisted' | 'private';
  tiktokMode: 'inbox' | 'direct';
  tiktokPrivacy: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  addShortsTag: boolean;
  cookiesFromBrowser: '' | 'chrome' | 'safari' | 'firefox' | 'edge' | 'brave';
  keepDays: number;
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  pollMinutes: 5,
  holdMinutes: 5,
  approval: 'auto',
  routes: {
    youtube: { youtube: false, instagram: true, tiktok: true },
    instagram: { youtube: true, instagram: false, tiktok: true },
    tiktok: { youtube: true, instagram: true, tiktok: false },
  },
  youtubeShortsOnly: true,
  makeVertical: true,
  youtubeMode: 'assisted',
  youtubePrivacy: 'public',
  tiktokMode: 'inbox',
  tiktokPrivacy: 'PUBLIC_TO_EVERYONE',
  addShortsTag: false,
  cookiesFromBrowser: '',
  keepDays: 7,
  paused: false,
};

export interface State {
  version: 1;
  settings: Settings;
  credentials: string; // encrypted JSON of Credentials
  accounts: Partial<Record<Platform, Account>>;
  items: Record<string, Item>;
  jobs: Job[];
  /** one-off markers (e.g. "start at login was set up") */
  flags: Record<string, boolean>;
}

/** Things the engine needs from whoever hosts it (Electron, or a test harness). */
export interface Host {
  dataDir: string;
  encrypt(plain: string): string;
  decrypt(blob: string): string;
  notify(title: string, body: string, jobId?: string): void;
  openExternal(url: string): void;
  log(msg: string): void;
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
  ytdlp: string;
  cloudflared: string;
  /** Extra args for yt-dlp (e.g. the JS runtime YouTube needs). */
  ytdlpArgs: string[];
  ytdlpEnv: Record<string, string>;
}

/** API hosts, so tests can point every call at a local mock. */
export interface Hosts {
  googleAuth: string; // https://accounts.google.com
  googleToken: string; // https://oauth2.googleapis.com
  youtube: string; // https://www.googleapis.com
  youtubeWatch: (id: string) => string;
  instagram: string; // https://graph.instagram.com
  tiktokAuth: string; // https://www.tiktok.com
  tiktok: string; // https://open.tiktokapis.com
}

export const REAL_HOSTS: Hosts = {
  googleAuth: 'https://accounts.google.com',
  googleToken: 'https://oauth2.googleapis.com',
  youtube: 'https://www.googleapis.com',
  youtubeWatch: (id) => `https://www.youtube.com/watch?v=${id}`,
  instagram: 'https://graph.instagram.com',
  tiktokAuth: 'https://www.tiktok.com',
  tiktok: 'https://open.tiktokapis.com',
};

export function mockHosts(base: string): Hosts {
  return {
    googleAuth: `${base}/google-auth`,
    googleToken: `${base}/google-token`,
    youtube: `${base}/youtube`,
    youtubeWatch: (id) => `${base}/files/youtube/${id}.mp4`,
    instagram: `${base}/instagram`,
    tiktokAuth: `${base}/tiktok-auth`,
    tiktok: `${base}/tiktok`,
  };
}

/** An error the user has to fix (reconnect, missing permission) — retrying won't help. */
export class AuthError extends Error {}
/** The platform refused this video for good (bad format, too long) — retrying won't help. */
export class PermanentError extends Error {}
