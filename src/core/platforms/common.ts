import type { Account, Credentials, Hosts, Job, RemoteVideo, Settings, Target, Tokens } from '../types';
import type { FileTunnel } from '../tunnel';

export interface Ctx {
  hosts: Hosts;
  creds: Credentials;
  settings: Settings;
  tunnel: FileTunnel;
  log: (msg: string) => void;
  openExternal: (url: string) => void;
}

/** A signed-in account plus a way to get a fresh access token for it. */
export interface Session {
  account: Account;
  token: () => Promise<string>;
}

export interface Connected {
  account: Pick<Account, 'platform' | 'id' | 'name' | 'avatar' | 'extra'>;
  tokens: Tokens;
}

export interface PublishProgress {
  stage: (status: Target['status'], note?: string) => void;
  progress?: (pct: number) => void;
}

export interface PublishResult {
  status: 'done' | 'action';
  resultId?: string;
  resultUrl?: string;
  action?: string;
  handle?: string;
}

export interface PlatformApi {
  /** Pull the newest videos on the account. */
  listRecent(ctx: Ctx, s: Session): Promise<RemoteVideo[]>;
  /** Hand one prepared file to the platform. */
  publish(ctx: Ctx, s: Session, t: Target, job: Job, p: PublishProgress): Promise<PublishResult>;
  /** Exchange a refresh token (or extend a long-lived token). */
  refresh(ctx: Ctx, tokens: Tokens): Promise<Tokens>;
}
