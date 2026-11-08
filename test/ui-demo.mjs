// Seeds a realistic Echoreel state against the mock platforms, then (optionally) opens the real
// app on it. Usage: node test/ui-demo.mjs <dataDir> [--shots <dir>] [--open]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startMock } from './mock-platforms.mjs';

process.env.ECHOREEL_POLL_MS = '100';
const require = createRequire(import.meta.url);
const { Engine, mockHosts } = require('../dist/core.js');
const dataDir = process.argv[2];
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
rmSync(dataDir, { recursive: true, force: true });
const vids = join(dataDir, '..', 'demo-videos');
mkdirSync(vids, { recursive: true });
const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp', cloudflared: 'cloudflared', ytdlpArgs: [], ytdlpEnv: {} };
const make = (name, src, w, h, secs) => {
  const out = join(vids, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}size=${w}x${h}:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${secs}`, '-t', String(secs), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', out]);
  return out;
};
const mock = await startMock({ dir: join(dataDir, '..', 'mock') });
const call = async (path, body = {}) => (await fetch(mock.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const host = { dataDir, encrypt: (s) => 'b64:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString(), notify() {}, openExternal: (u) => void fetch(u).catch(() => {}), log() {} };
const e = new Engine(host, tools, mockHosts(mock.base), { tunnelBase: 'http://127.0.0.1:{port}' });
Object.assign(e.settings, { holdMinutes: 0, pollMinutes: 0, youtubeMode: 'assisted', tiktokMode: 'inbox' });
await call('/_test/youtube/add', { file: make('a.mp4', 'testsrc2', 720, 1280, 6), title: 'Studio tour (old)', duration: 6, at: Date.now() - 5 * 86400_000 });
await call('/_test/instagram/add', { file: make('b.mp4', 'smptebars', 720, 1280, 5), caption: 'Throwback reel', at: Date.now() - 3 * 86400_000 });
e.setCredentials({ google: { clientId: '1234-demo.apps.googleusercontent.com', clientSecret: 'x' }, tiktok: { clientKey: 'sbawdemo', clientSecret: 'y' } });
await e.connect('youtube');
await e.connect('instagram', { token: mock.S.ig.token });
await e.connect('tiktok');
// 1. A Short relayed to Instagram (done) and TikTok (waiting in the inbox).
await call('/_test/youtube/add', { file: make('c.mp4', 'mandelbrot', 720, 1280, 8), title: 'Into the fractal 🌀 60 seconds of infinite zoom', description: 'Rendered on my laptop.\n#math #fractal #shorts', duration: 8 });
await e.tick();
// 2. A reel relayed to TikTok, with YouTube prepared for Studio.
await call('/_test/instagram/add', { file: make('d.mp4', 'gradients=seed=3:speed=0.03', 720, 1280, 7), caption: 'Sunset colour study 🎨\nwhich palette wins? #art #colour' });
await e.tick();
// 3. A long landscape upload that is skipped.
await call('/_test/youtube/add', { file: make('e.mp4', 'testsrc', 1280, 720, 9), title: 'Full livestream replay', duration: 9 });
await e.tick();
// 4. Approval mode: one waiting for an OK (DEMO_NO_APPROVAL=1 leaves it out, for website shots).
if (!process.env.DEMO_NO_APPROVAL) e.settings.approval = 'ask';
await call('/_test/tiktok/add', { file: make('f.mp4', 'gradients=seed=9:speed=0.05', 720, 1280, 6), caption: 'POV: your render finishes at 3am #blender #3d', duration: 6, width: 720, height: 1280 });
await e.tick();
e.settings.approval = 'auto';
e.settings.pollMinutes = 5; // the seeding above checked on every tick
e.stop();
console.log(JSON.stringify({ base: mock.base, jobs: e.store.state.jobs.map((j) => [j.id, j.status]) }));
if (shots || process.argv.includes('--open')) {
  const electron = require('electron');
  const env = { ...process.env, ECHOREEL_DATA_DIR: dataDir, ECHOREEL_MOCK: mock.base };
  if (shots) env.ECHOREEL_SHOTS = shots;
  if (process.env.SHOT_PAGES) env.ECHOREEL_SHOT_PAGES = process.env.SHOT_PAGES.replace('{approval}', e.store.state.jobs.find((j) => j.status === 'approval')?.id ?? '');
  const child = spawn(electron, ['.', '--use-mock-keychain'], { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    mock.server.close();
    process.exit(code ?? 0);
  });
} else mock.server.close();
