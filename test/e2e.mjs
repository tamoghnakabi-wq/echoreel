// End-to-end test: the real engine (dist/core.js) against mock YouTube/Instagram/TikTok APIs,
// with real ffmpeg/ffprobe/yt-dlp. Run: npm test  (or ECHOREEL_TOOLS=<dir> to use bundled tools)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startMock } from './mock-platforms.mjs';

process.env.ECHOREEL_POLL_MS = '150';
const require = createRequire(import.meta.url);
const core = require('../dist/core.js');
const { Engine, mockHosts } = core;

const scratch = mkdtempSync(join(process.env.ECHOREEL_SCRATCH ?? tmpdir(), 'echoreel-e2e-'));
const which = (n) => {
  if (process.env.ECHOREEL_TOOLS) return join(process.env.ECHOREEL_TOOLS, n + (process.platform === 'win32' ? '.exe' : ''));
  return execFileSync(process.platform === 'win32' ? 'where' : 'which', [n]).toString().split(/\r?\n/)[0].trim();
};
const tools = { ffmpeg: which('ffmpeg'), ffprobe: which('ffprobe'), ytdlp: which('yt-dlp'), cloudflared: 'cloudflared', ytdlpArgs: [], ytdlpEnv: {} };

// --- test videos: different moving patterns so their fingerprints differ ---
function makeVideo(name, { w, h, secs, src, audio = true }) {
  const out = join(scratch, name);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}size=${w}x${h}:rate=30`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`);
  args.push('-t', String(secs), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(out);
  execFileSync(tools.ffmpeg, args);
  return out;
}
const V = {
  ytOld: makeVideo('yt-old.mp4', { w: 720, h: 1280, secs: 6, src: 'testsrc2' }),
  ytShort: makeVideo('yt-short.mp4', { w: 720, h: 1280, secs: 8, src: 'mandelbrot' }),
  ytLong: makeVideo('yt-long.mp4', { w: 1280, h: 720, secs: 9, src: 'life' }),
  igReel: makeVideo('ig-reel.mp4', { w: 720, h: 1280, secs: 7, src: 'testsrc' }),
  ttWide: makeVideo('tt-wide.mp4', { w: 1280, h: 720, secs: 6, src: 'rgbtestsrc', audio: false }),
  local: makeVideo('local.mp4', { w: 1080, h: 1920, secs: 5, src: 'smptehdbars' }),
  ytApprove: makeVideo('yt-approve.mp4', { w: 720, h: 1280, secs: 5, src: 'zoneplate' }),
};

const mock = await startMock({ dir: join(scratch, 'mock'), ffmpeg: tools.ffmpeg });
const call = async (path, body = {}) => (await fetch(mock.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

const notes = [];
const logs = [];
function makeHost() {
  return {
    dataDir: join(scratch, 'data'),
    encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s.replace(/^enc:/, ''), 'base64').toString(),
    notify: (title, body) => notes.push(`${title}: ${body}`),
    // Plays the browser: follows the sign-in redirect back to Echoreel's loopback address.
    openExternal: (url) => void fetch(url).catch((e) => logs.push('openExternal failed ' + e.message)),
    log: (m) => logs.push(m),
  };
}
let engine = new Engine(makeHost(), tools, mockHosts(mock.base), { tunnelBase: 'http://127.0.0.1:{port}' });
const S = engine.store.state;
Object.assign(engine.settings, { holdMinutes: 0, pollMinutes: 0, youtubeMode: 'api', tiktokMode: 'inbox', youtubeShortsOnly: true, makeVertical: true });

let passed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    console.log(`  ✗ ${name}\n${e.stack}\n--- last log lines ---\n${logs.slice(-25).join('\n')}`);
    process.exitCode = 1;
    throw e;
  }
}
const jobFor = (key) => S.jobs.find((j) => j.source === key);
const probeFile = (f) => JSON.parse(execFileSync(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());
const dims = (f) => {
  const v = probeFile(f).streams.find((s) => s.codec_type === 'video');
  return `${v.width}x${v.height}/${v.codec_name}`;
};
const state = async () => (await fetch(mock.base + '/_test/state')).json();

console.log(`Echoreel e2e in ${scratch}`);
try {
  await step('connect all three accounts; existing videos are recorded, not relayed', async () => {
    await call('/_test/youtube/add', { file: V.ytOld, title: 'Old short', duration: 6, at: Date.now() - 3 * 86400_000 });
    await call('/_test/instagram/add', { file: V.igReel, caption: 'old reel', at: Date.now() - 86400_000, id: 'igold1' });
    engine.setCredentials({ google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'gsecret' }, tiktok: { clientKey: 'ttkey', clientSecret: 'ttsecret' } });
    const yt = await engine.connect('youtube');
    assert.equal(yt.name, 'Mock Channel');
    await assert.rejects(engine.connect('instagram', { token: 'nope' }), /doesn't look like/);
    const ig = await engine.connect('instagram', { token: mock.S.ig.token });
    assert.equal(ig.name, '@mock_creator');
    const tt = await engine.connect('tiktok');
    assert.equal(tt.name, 'Mock Tok');
    for (const p of ['youtube', 'instagram', 'tiktok']) assert.equal(S.accounts[p].baselineDone, true, p);
    assert.equal(S.jobs.length, 0);
    assert.equal(Object.values(S.items).filter((i) => i.status === 'baseline').length, 2);
  });

  let shortJob;
  await step('new YouTube Short → Instagram reel + TikTok inbox draft', async () => {
    const { id } = await call('/_test/youtube/add', { file: V.ytShort, title: 'Fractal zoom 🌀', description: 'A trip into the set\n#math #fractal', duration: 8 });
    await engine.tick();
    shortJob = jobFor(`youtube:${id}`);
    assert.ok(shortJob, 'job created');
    assert.equal(shortJob.status, 'done', JSON.stringify(shortJob.targets.map((t) => [t.platform, t.status, t.error])));
    const ig = shortJob.targets.find((t) => t.platform === 'instagram');
    const tt = shortJob.targets.find((t) => t.platform === 'tiktok');
    assert.equal(ig.status, 'done');
    assert.match(ig.resultUrl, /instagram\.com\/reel\//);
    assert.equal(tt.status, 'action');
    const st = await state();
    const reel = st.ig.media.find((m) => m.id === ig.resultId);
    assert.ok(reel?.viaApi, 'reel published through the API');
    assert.match(reel.caption, /Fractal zoom 🌀\n\nA trip into the set\n#math #fractal/);
    assert.equal(dims(join(scratch, 'mock', `instagram-${ig.resultId}.mp4`)), '720x1280/h264');
    const pub = Object.values(st.tt.publishes)[0];
    assert.equal(pub.mode, 'inbox');
    assert.equal(pub.got, pub.size);
    assert.ok(notes.some((n) => n.startsWith('Finish posting on TikTok')));
  });

  await step('the reel Echoreel posted is recognised on the next check (no loop)', async () => {
    await engine.tick();
    const ig = shortJob.targets.find((t) => t.platform === 'instagram');
    assert.equal(S.items[`instagram:${ig.resultId}`].status, 'echo');
    assert.equal(S.jobs.length, 1);
  });

  await step('finishing the TikTok draft (re-encoded by TikTok) is recognised, not relayed back', async () => {
    const pub = Object.keys((await state()).tt.publishes)[0];
    const { id } = await call('/_test/tiktok/finish-inbox', { publish_id: pub, caption: 'Fractal zoom 🌀 #math' });
    await engine.tick();
    const item = S.items[`tiktok:${id}`];
    assert.equal(item.status, 'echo', JSON.stringify(item));
    assert.equal(shortJob.targets.find((t) => t.platform === 'tiktok').status, 'done');
    assert.equal(S.jobs.filter((j) => j.status !== 'cancelled').length, 1);
  });

  await step('a long landscape YouTube video is skipped (Shorts only)', async () => {
    const { id } = await call('/_test/youtube/add', { file: V.ytLong, title: 'Long one', duration: 9 });
    await engine.tick();
    assert.equal(S.items[`youtube:${id}`].status, 'skipped');
    assert.match(S.items[`youtube:${id}`].reason, /not a Short/);
  });

  let reelJob;
  await step('new Instagram reel → YouTube (API upload) + TikTok', async () => {
    const { id } = await call('/_test/instagram/add', { file: V.igReel, caption: 'Cellular automaton 🧬\nwatch it grow #science' });
    await engine.tick();
    reelJob = jobFor(`instagram:${id}`);
    assert.equal(reelJob.status, 'done', JSON.stringify(reelJob.targets.map((t) => [t.platform, t.status, t.error])));
    const yt = reelJob.targets.find((t) => t.platform === 'youtube');
    assert.equal(yt.title, 'Cellular automaton 🧬');
    assert.match(yt.resultUrl, /youtube\.com\/shorts\//);
    const v = (await state()).yt.videos.find((x) => x.id === yt.resultId);
    assert.equal(v.privacy, 'public');
    assert.equal(v.description, 'Cellular automaton 🧬\nwatch it grow #science');
    await engine.tick();
    assert.equal(S.items[`youtube:${yt.resultId}`].status, 'echo');
  });

  await step('re-uploading the same reel is caught as a duplicate', async () => {
    const { id } = await call('/_test/instagram/add', { file: V.igReel, caption: 'same video again' });
    await engine.tick();
    assert.equal(S.items[`instagram:${id}`].status, 'duplicate');
  });

  await step('landscape TikTok without audio → fitted onto a 1080×1920 frame for Instagram', async () => {
    const { id } = await call('/_test/tiktok/add', { file: V.ttWide, caption: 'colour bars', duration: 6, width: 1280, height: 720 });
    await engine.tick();
    const job = jobFor(`tiktok:${id}`);
    assert.equal(job.status, 'done', JSON.stringify(job.targets.map((t) => [t.platform, t.status, t.error])));
    const ig = job.targets.find((t) => t.platform === 'instagram');
    const f = join(scratch, 'mock', `instagram-${ig.resultId}.mp4`);
    assert.equal(dims(f), '1080x1920/h264');
    assert.ok(probeFile(f).streams.some((s) => s.codec_type === 'audio'), 'silent track added');
    assert.equal(dims(job.targets.find((t) => t.platform === 'youtube').file), '1280x720/h264');
  });

  await step('post a file from the app to all three', async () => {
    const job = engine.post({ file: V.local, title: 'Bars', caption: 'Posted once, everywhere #echoreel', platforms: ['youtube', 'instagram', 'tiktok'] });
    await engine.work();
    assert.equal(job.status, 'done', JSON.stringify(job.targets.map((t) => [t.platform, t.status, t.error])));
    await engine.tick();
    const yt = job.targets.find((t) => t.platform === 'youtube');
    assert.equal(S.items[`youtube:${yt.resultId}`].status, 'echo');
  });

  await step('approval mode waits for an OK, then posts the edited caption', async () => {
    engine.settings.approval = 'ask';
    const { id } = await call('/_test/youtube/add', { file: V.ytApprove, title: 'Zone plate', duration: 5 });
    await engine.tick();
    const job = jobFor(`youtube:${id}`);
    assert.equal(job.status, 'approval');
    engine.approve(job.id, [{ platform: 'instagram', caption: 'Edited caption ✏️' }, { platform: 'tiktok', skip: true }]);
    await engine.work();
    assert.equal(job.status, 'done');
    const ig = job.targets.find((t) => t.platform === 'instagram');
    assert.equal((await state()).ig.media.find((m) => m.id === ig.resultId).caption, 'Edited caption ✏️');
    assert.equal(job.targets.find((t) => t.platform === 'tiktok').status, 'skipped');
    engine.settings.approval = 'auto';
  });

  await step('a temporary platform error is retried; a processing error fails clearly', async () => {
    await call('/_test/fault', { name: 'tt-init' });
    await call('/_test/fault', { name: 'ig-process' });
    const local2 = makeVideo('local2.mp4', { w: 720, h: 1280, secs: 4, src: 'testsrc' });
    const job = engine.post({ file: local2, title: 'Retry me', caption: 'retry', platforms: ['instagram', 'tiktok'] });
    await engine.work();
    const ig = job.targets.find((t) => t.platform === 'instagram');
    const tt = job.targets.find((t) => t.platform === 'tiktok');
    assert.equal(ig.status, 'failed');
    assert.match(ig.error, /couldn't process the video/);
    assert.equal(tt.status, 'pending');
    assert.ok(tt.nextAttemptAt > Date.now());
    tt.nextAttemptAt = 0; // skip the wait
    job.notBefore = 0;
    await engine.work();
    assert.equal(tt.status, 'action');
    assert.equal(job.status, 'partial');
    engine.retry(job.id);
    await engine.work();
    assert.equal(ig.status, 'done');
    assert.equal(job.status, 'done');
  });

  await step('expired tokens are refreshed (Google + TikTok), Instagram extended', async () => {
    for (const p of ['youtube', 'tiktok', 'instagram']) {
      const a = S.accounts[p];
      const t = JSON.parse(engine.host.decrypt(a.tokens));
      t.expiresAt = Date.now() - 1000;
      t.issuedAt = Date.now() - 10 * 86400_000;
      if (p === 'instagram') t.expiresAt = Date.now() + 20 * 86400_000;
      a.tokens = engine.host.encrypt(JSON.stringify(t));
    }
    await engine.tick();
    const st = await state();
    assert.equal(st.google.refreshes, 1);
    assert.equal(st.tt.refreshes, 1);
    assert.equal(st.ig.refreshes, 1);
    for (const p of ['youtube', 'tiktok', 'instagram']) assert.equal(S.accounts[p].lastCheckError, undefined, p);
  });

  await step('a revoked Google sign-in asks the user to reconnect', async () => {
    const a = S.accounts.youtube;
    const t = JSON.parse(engine.host.decrypt(a.tokens));
    t.expiresAt = 0;
    t.refresh = 'revoked';
    a.tokens = engine.host.encrypt(JSON.stringify(t));
    await engine.tick();
    assert.equal(S.accounts.youtube.status, 'reconnect');
    assert.ok(notes.some((n) => n.startsWith('YouTube needs you to reconnect')));
    await engine.connect('youtube');
    assert.equal(S.accounts.youtube.status, 'ok');
  });

  await step('state survives a restart and nothing is relayed twice', async () => {
    engine.stop();
    const before = S.jobs.length;
    engine = new Engine(makeHost(), tools, mockHosts(mock.base), { tunnelBase: 'http://127.0.0.1:{port}' });
    Object.assign(engine.settings, { holdMinutes: 0, pollMinutes: 0 });
    await engine.tick();
    assert.equal(engine.store.state.jobs.length, before);
    assert.ok(engine.view().jobs.length > 0);
    assert.equal(JSON.stringify(engine.view()).includes(mock.S.ig.token), false, 'no tokens in the UI view');
  });

  console.log(`\n${passed} steps passed`);
} finally {
  engine.stop();
  mock.server.close();
  if (!process.exitCode && !process.env.KEEP) rmSync(scratch, { recursive: true, force: true });
}
