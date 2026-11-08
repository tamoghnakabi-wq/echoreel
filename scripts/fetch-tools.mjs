// Downloads the command-line tools Echoreel ships with, for one OS/arch, into tools/<platform>-<arch>/.
//   node scripts/fetch-tools.mjs [darwin|win32] [arm64|x64]   (defaults to this machine)
// ffmpeg/ffprobe come from the ffmpeg-static release builds, yt-dlp and cloudflared from their
// official GitHub releases. yt-dlp is checked against its published SHA2-256SUMS.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`unsupported target ${platform}-${arch}`);
if (platform === 'win32' && arch !== 'x64') throw new Error('Windows builds are x64 only');

const FFMPEG = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const CLOUDFLARED = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const exe = platform === 'win32' ? '.exe' : '';
const dir = join('tools', `${platform}-${arch}`);
mkdirSync(dir, { recursive: true });

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 4) throw new Error(`download failed: ${url}: ${e.message}`);
      console.log(`  retry ${attempt} for ${url} (${e.message})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function save(name, buf) {
  const p = join(dir, name);
  writeFileSync(p, buf);
  if (platform !== 'win32') chmodSync(p, 0o755);
  console.log(`  ${name}  ${(buf.length / 1e6).toFixed(1)} MB`);
}

console.log(`Fetching tools for ${platform}-${arch} into ${dir}`);
for (const tool of ['ffmpeg', 'ffprobe']) {
  if (existsSync(join(dir, tool + exe))) { console.log(`  ${tool}${exe} (cached)`); continue; }
  save(tool + exe, gunzipSync(await get(`${FFMPEG}/${tool}-${platform}-${arch}.gz`)));
}

// yt-dlp_macos is a universal binary; yt-dlp.exe is the Windows x64 build.
const ytName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_macos';
const sums = (await get(`${YTDLP}/SHA2-256SUMS`)).toString();
const want = sums.split('\n').find((l) => l.trim().endsWith(` ${ytName}`))?.split(/\s+/)[0];
if (!want) throw new Error(`no checksum for ${ytName}`);
const yt = await get(`${YTDLP}/${ytName}`);
const got = createHash('sha256').update(yt).digest('hex');
if (got !== want) throw new Error(`yt-dlp checksum mismatch: ${got} != ${want}`);
save('yt-dlp' + exe, yt);

if (!existsSync(join(dir, 'cloudflared' + exe))) {
  if (platform === 'win32') save('cloudflared.exe', await get(`${CLOUDFLARED}/cloudflared-windows-amd64.exe`));
  else {
    const tgz = join(dir, 'cloudflared.tgz');
    writeFileSync(tgz, await get(`${CLOUDFLARED}/cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`));
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    rmSync(tgz);
    chmodSync(join(dir, 'cloudflared'), 0o755);
    console.log(`  cloudflared  ${(readFileSync(join(dir, 'cloudflared')).length / 1e6).toFixed(1)} MB`);
  }
} else console.log(`  cloudflared${exe} (cached)`);
console.log('done');
