import { spawn } from 'node:child_process';
import { AuthError, PermanentError } from './types';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How often to ask a platform whether it has finished processing (tests shorten it). */
export const POLL_MS = Number(process.env.ECHOREEL_POLL_MS) || 5000;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

/** fetch + JSON with a timeout and readable errors. */
export async function http<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] ??= 'application/json; charset=UTF-8';
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new Error(`network error contacting ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new HttpError(`${new URL(url).host} ${res.status}: ${describe(json)}`, res.status, json);
  return json as T;
}

/** Pull the human message out of the usual Google / Meta / TikTok error shapes. */
export function describe(body: any): string {
  if (typeof body === 'string') return body.slice(0, 300);
  const e = body?.error;
  if (typeof e === 'string') return body.error_description ? `${e}: ${body.error_description}` : e;
  if (e?.message) return e.message + (e.error_user_msg ? ` (${e.error_user_msg})` : '');
  if (e?.code && e.code !== 'ok') return `${e.code}: ${e.message ?? ''}`;
  return JSON.stringify(body).slice(0, 300);
}

/** Turn an HTTP failure into the engine's error kinds. */
export function classify(e: unknown): Error {
  if (e instanceof HttpError) {
    const meta = (e.body as any)?.error;
    // Meta: code 190 = token invalid/expired, 10/200-299 = permission missing.
    if (meta && typeof meta === 'object' && (meta.code === 190 || meta.code === 10 || (meta.code >= 200 && meta.code < 300))) return new AuthError(e.message);
    if (e.status === 401) return new AuthError(e.message);
    if (e.status === 403 && /scope|permission|access_token|unaudited|insufficient/i.test(e.message)) return new AuthError(e.message);
    if (e.status === 400 && /invalid_grant|token/i.test(e.message)) return new AuthError(e.message);
  }
  return e as Error;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program; resolves with its output (never throws on a non-zero exit). */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string>; onLine?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let partial = '';
    const feed = (chunk: string) => {
      if (!opts.onLine) return;
      partial += chunk;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine(l);
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (stdout.length < 4_000_000) stdout += s;
      feed(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      if (stderr.length < 200_000) stderr += s;
      feed(s);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          stderr += `\n[killed after ${opts.timeoutMs} ms]`;
        }, opts.timeoutMs)
      : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`could not start ${cmd}: ${e.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export function lastLines(s: string, n = 4) {
  return s.trim().split(/\r?\n/).slice(-n).join(' | ');
}

/** First line of a caption, cleaned up to work as a video title. */
export function titleFrom(caption: string, fallback = 'New video'): string {
  const line = caption
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.replace(/#[\p{L}\p{N}_]+/gu, '').trim().length > 0);
  let t = (line ?? '').replace(/\s+/g, ' ').trim();
  if (!t) t = caption.match(/#[\p{L}\p{N}_]+/gu)?.slice(0, 3).join(' ') ?? fallback;
  t = t.replace(/[<>]/g, '');
  return t.length > 100 ? t.slice(0, 97).trimEnd() + '…' : t || fallback;
}

export function clip(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function permanent(msg: string) {
  return new PermanentError(msg);
}
