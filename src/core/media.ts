import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Platform, Settings, Tools } from './types';
import { PermanentError } from './types';
import { lastLines, run } from './util';

export interface Probe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string | null;
  size: number;
  format: string;
}

export async function probe(tools: Tools, file: string): Promise<Probe> {
  const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new PermanentError(`not a readable video: ${lastLines(r.stderr)}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams?.find((s: any) => s.codec_type === 'video');
  if (!v) throw new PermanentError('the file has no video track');
  const a = j.streams?.find((s: any) => s.codec_type === 'audio');
  let width = Number(v.width);
  let height = Number(v.height);
  // Phone videos are often stored landscape with a rotation flag.
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  if (rot === 90) [width, height] = [height, width];
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(j.format?.duration ?? v.duration ?? 0),
    width,
    height,
    fps: d ? n / d : n || 30,
    vcodec: v.codec_name,
    acodec: a?.codec_name ?? null,
    size: Number(j.format?.size ?? statSync(file).size),
    format: String(j.format?.format_name ?? ''),
  };
}

/** Platform limits Echoreel works within (kept a little inside the documented maximums). */
export const LIMITS: Record<Platform, { maxSeconds: number; minSeconds: number; maxBytes: number }> = {
  youtube: { maxSeconds: 12 * 3600, minSeconds: 1, maxBytes: 256e9 },
  instagram: { maxSeconds: 15 * 60, minSeconds: 3, maxBytes: 300e6 },
  tiktok: { maxSeconds: 10 * 60, minSeconds: 3, maxBytes: 4e9 },
};

export const isVertical = (p: { width: number; height: number }) => p.height > p.width;

/** Codecs an MP4 carries as they are and every platform decodes (a camera's ProRes or PCM aren't). */
const MP4_VIDEO = /^(h264|hevc|vp9|av1)$/;
const MP4_AUDIO = /^(aac|mp3|opus|ac3|eac3)$/;

/**
 * Make the file a destination accepts. Copies the streams when the source already fits
 * (no quality loss), otherwise re-encodes to H.264/AAC; for Instagram/TikTok a non-vertical
 * video can be fitted onto a 1080x1920 frame over a blurred copy of itself.
 */
export async function prepare(tools: Tools, src: string, p: Probe, dest: Platform, settings: Settings, outDir: string, onProgress?: (pct: number) => void): Promise<string> {
  const lim = LIMITS[dest];
  if (p.duration > lim.maxSeconds) throw new PermanentError(`${Math.round(p.duration)} s is longer than ${dest} allows (${lim.maxSeconds} s)`);
  if (p.duration < lim.minSeconds) throw new PermanentError(`${p.duration.toFixed(1)} s is shorter than ${dest} allows (${lim.minSeconds} s)`);
  const out = join(outDir, `${dest}.mp4`);
  const vertical = dest !== 'youtube' && settings.makeVertical && !isVertical(p);
  const tooBig = Math.max(p.width, p.height) > 1920 || p.fps > 60.5 || p.size > lim.maxBytes;
  const compatible = p.vcodec === 'h264' && (p.acodec === 'aac' || (p.acodec === null && dest === 'youtube')) && /mp4|mov/.test(p.format);
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-i', src];
  const total = p.duration * 1e6;
  const ffmpeg = (args: string[]) =>
    run(tools.ffmpeg, args, {
      timeoutMs: Math.max(10 * 60_000, p.duration * 8_000),
      onLine: (l) => {
        const m = l.match(/^out_time_us=(\d+)/);
        if (m && total) onProgress?.(Math.min(99, Math.round((Number(m[1]) / total) * 100)));
      },
    });
  // YouTube re-encodes everything itself, so it gets the original picture (and sound, when an MP4
  // can carry it as it is); the others do too when the source already fits.
  if (!tooBig && (dest === 'youtube' ? MP4_VIDEO.test(p.vcodec) : compatible && !vertical)) {
    const audio = p.acodec === null || MP4_AUDIO.test(p.acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
    const r = await ffmpeg([...base, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', ...audio, '-movflags', '+faststart', out]);
    if (r.code === 0 && existsSync(out)) return out;
    // Something in the source an MP4 can't hold as it is: fall through and re-encode it all.
  }
  const args = [...base];
  const silent = p.acodec === null;
  if (silent) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const fps = p.fps > 60.5 ? ',fps=60' : '';
  if (vertical) {
    args.push(
      '-filter_complex',
      `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[b];` +
        `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p${fps}[v]`,
      '-map',
      '[v]',
    );
  } else {
    const fit = Math.max(p.width, p.height) > 1920 ? (isVertical(p) ? 'scale=-2:1920,' : 'scale=1920:-2,') : '';
    args.push('-vf', `${fit}setsar=1,format=yuv420p${fps}`, '-map', '0:v:0');
  }
  args.push('-map', silent ? '1:a:0' : '0:a:0');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-maxrate', '25M', '-bufsize', '50M');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
  if (silent) args.push('-shortest');
  args.push('-movflags', '+faststart', out);
  const r = await ffmpeg(args);
  if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg failed: ${lastLines(r.stderr)}`);
  return out;
}

/**
 * A fingerprint is eight 16x16 greyscale thumbnails taken evenly through the video
 * (base64, 256 bytes each). Comparing them by correlation survives re-encoding and
 * resizing, so a video that comes back from a platform is recognised even though its
 * bytes changed. Flat frames (black, one colour) carry no evidence and are ignored.
 */
const FRAMES = 8;
const SIDE = 16;
export async function fingerprint(tools: Tools, file: string, duration: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = Math.max(0, duration * ((i + 0.5) / FRAMES) - 0.02);
    const r = await rawFrame(tools, file, t);
    out.push(r && r.length >= SIDE * SIDE ? r.subarray(0, SIDE * SIDE).toString('base64') : '');
  }
  return out;
}

function rawFrame(tools: Tools, file: string, t: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(tools.ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${SIDE}:${SIDE}:flags=area,format=gray`, '-f', 'rawvideo', '-'], {
      windowsHide: true,
    });
    const bufs: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => bufs.push(d));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(Buffer.concat(bufs)));
  });
}

function stats(px: Buffer) {
  let sum = 0;
  for (const v of px) sum += v;
  const mean = sum / px.length;
  let sq = 0;
  for (const v of px) sq += (v - mean) ** 2;
  return { mean, std: Math.sqrt(sq / px.length) };
}

export interface Similarity {
  /** frames that had enough detail to compare */
  frames: number;
  /** average and worst per-frame distance: (1 - correlation) * 100 + brightness gap / 2 */
  avg: number;
  worst: number;
}

export function compare(a?: string[], b?: string[]): Similarity {
  const none = { frames: 0, avg: 100, worst: 100 };
  if (!a?.length || !b?.length || a.length !== b.length) return none;
  const ds: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (!a[i] || !b[i]) continue;
    const x = Buffer.from(a[i], 'base64');
    const y = Buffer.from(b[i], 'base64');
    const sx = stats(x);
    const sy = stats(y);
    if (sx.std < 4 || sy.std < 4) continue; // flat frame: no evidence either way
    let cov = 0;
    for (let k = 0; k < x.length; k++) cov += (x[k] - sx.mean) * (y[k] - sy.mean);
    const corr = cov / x.length / (sx.std * sy.std);
    ds.push((1 - corr) * 100 + Math.abs(sx.mean - sy.mean) / 2);
  }
  if (ds.length < Math.ceil(a.length * 0.6)) return { ...none, frames: ds.length };
  return { frames: ds.length, avg: ds.reduce((s, d) => s + d, 0) / ds.length, worst: Math.max(...ds) };
}

/**
 * strict: the same video, re-encoded (correlation ~0.99 on every frame).
 * loose: for a hand-finished upload Echoreel is expecting anyway (TikTok may have re-cut it slightly).
 */
export function sameVideo(a: string[] | undefined, b: string[] | undefined, loose = false): boolean {
  const s = compare(a, b);
  return loose ? s.avg <= 8 && s.worst <= 25 : s.avg <= 3 && s.worst <= 8;
}

/** Download a remote video into dir; returns the file path. */
export async function download(tools: Tools, url: string, direct: boolean, dir: string, settings: Settings, onProgress?: (pct: number) => void): Promise<string> {
  mkdirSync(dir, { recursive: true });
  if (direct) {
    const out = join(dir, 'source.mp4');
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let got = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        got += chunk.byteLength;
        if (total) onProgress?.(Math.round((got / total) * 100));
        ctl.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as any), createWriteStream(out));
    return out;
  }
  const args = [
    ...tools.ytdlpArgs,
    '--no-playlist',
    '--no-progress',
    '--newline',
    '--progress-template',
    'download:PCT %(progress._percent_str)s',
    '-f',
    'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format',
    'mp4',
    '--ffmpeg-location',
    tools.ffmpeg,
    '-o',
    join(dir, 'source.%(ext)s'),
  ];
  if (settings.cookiesFromBrowser) args.push('--cookies-from-browser', settings.cookiesFromBrowser);
  args.push(url);
  const r = await run(tools.ytdlp, args, {
    timeoutMs: 60 * 60_000,
    env: tools.ytdlpEnv,
    onLine: (l) => {
      const m = l.match(/PCT\s+([\d.]+)%/);
      if (m) onProgress?.(Math.round(Number(m[1])));
    },
  });
  // Only the finished file: not yt-dlp's partial or per-stream files (source.f137.mp4, source.temp.mp4).
  const file = readdirSync(dir).find((f) => /^source\.(mp4|mkv|webm|mov|m4v)$/i.test(f));
  if (r.code !== 0 || !file) {
    const why = lastLines(r.stderr || r.stdout, 3);
    if (/Sign in to confirm|not a bot|cookies/i.test(why)) throw new Error(`YouTube asked for a sign-in before downloading. In Settings, pick the browser you're signed in to YouTube with. (${why})`);
    throw new Error(`could not download the video: ${why}`);
  }
  return join(dir, file);
}
