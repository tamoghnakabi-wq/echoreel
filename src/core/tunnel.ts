import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tools } from './types';
import { sleep } from './util';

/**
 * Instagram's API only accepts a video by URL, so while a video is being handed to
 * Instagram it is served from this computer through a temporary Cloudflare quick tunnel
 * (https://<random>.trycloudflare.com). Each file gets an unguessable path, only that
 * file is served, and the tunnel closes once nothing needs it.
 */
export class FileTunnel {
  private server: Server | null = null;
  private port = 0;
  private proc: ChildProcess | null = null;
  private base: Promise<string> | null = null;
  private files = new Map<string, string>();
  private users = 0;
  private idle: NodeJS.Timeout | null = null;

  /** fixedBase: skip cloudflared and use this base URL (tests). */
  constructor(
    private tools: Tools,
    private log: (m: string) => void,
    private fixedTemplate?: string,
  ) {}

  private get fixedBase() {
    return this.fixedTemplate?.replace('{port}', String(this.port));
  }

  async share(file: string): Promise<{ url: string; done: () => void }> {
    this.users++;
    if (this.idle) clearTimeout(this.idle);
    try {
      await this.listen();
      const token = randomBytes(18).toString('base64url');
      this.files.set(token, file);
      const base = this.fixedBase ?? (await this.start());
      let released = false;
      return {
        url: `${base}/v/${token}.mp4`,
        done: () => {
          if (released) return;
          released = true;
          this.files.delete(token);
          this.release();
        },
      };
    } catch (e) {
      this.release();
      throw e;
    }
  }

  private release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) this.idle = setTimeout(() => this.close(), 60_000);
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        const m = req.url?.match(/^\/v\/([A-Za-z0-9_-]+)\.mp4$/);
        const file = m && this.files.get(m[1]);
        if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
          res.writeHead(404).end();
          return;
        }
        const size = statSync(file).size;
        const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
        let start = 0;
        let end = size - 1;
        if (range) {
          start = range[1] ? Number(range[1]) : size - Number(range[2]);
          end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
            return;
          }
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file, { start, end }).pipe(res);
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        this.port = (srv.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private start(): Promise<string> {
    if (this.base) return this.base;
    this.base = new Promise<string>((resolve, reject) => {
      this.log('opening a temporary public link (Cloudflare quick tunnel)');
      const proc = spawn(this.tools.cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { windowsHide: true });
      this.proc = proc;
      let found = false;
      const timer = setTimeout(() => fail(new Error('Cloudflare did not open a tunnel within 60 s')), 60_000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        this.stopProc();
        reject(e);
      };
      const onData = async (d: Buffer) => {
        const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (!m || found) return;
        found = true;
        // The hostname takes a few seconds to start answering.
        for (let i = 0; i < 30; i++) {
          try {
            const r = await fetch(`${m[0]}/v/ping.mp4`, { signal: AbortSignal.timeout(5000) });
            if (r.status === 404) {
              clearTimeout(timer);
              this.log(`public link ready: ${m[0]}`);
              resolve(m[0]);
              return;
            }
          } catch {
            /* not yet */
          }
          await sleep(1500);
        }
        fail(new Error('the Cloudflare tunnel opened but never became reachable'));
      };
      proc.stderr?.on('data', onData);
      proc.stdout?.on('data', onData);
      proc.on('error', (e) => fail(new Error(`could not start cloudflared: ${e.message}`)));
      proc.on('exit', (code) => {
        if (!found) fail(new Error(`cloudflared exited (${code})`));
        this.proc = null;
        this.base = null;
      });
    });
    this.base.catch(() => (this.base = null));
    return this.base;
  }

  private stopProc() {
    this.proc?.kill();
    this.proc = null;
    this.base = null;
  }

  close() {
    if (this.users > 0) return;
    this.stopProc();
    this.server?.close();
    this.server = null;
  }
}
