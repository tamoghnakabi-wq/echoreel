// A stand-in for the YouTube, Instagram and TikTok APIs (the endpoints Echoreel uses),
// strict about the parts that matter: auth headers, upload byte ranges, PKCE, URLs it must fetch.
// Test controls live under /_test/.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function startMock({ dir, ffmpeg = 'ffmpeg', ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') }) {
  mkdirSync(dir, { recursive: true });
  let seq = 1000;
  const id = (p) => `${p}${++seq}`;
  const S = {
    calls: [],
    faults: {}, // name -> count of failures to inject
    google: { codes: new Set(), refreshes: 0, access: 'ya29.mock-' + Date.now() },
    yt: { channel: { id: 'UCmockchannel0000000000', uploads: 'UUmockchannel0000000000', title: 'Mock Channel' }, videos: [], sessions: {} },
    ig: { user_id: '17841400000000001', username: 'mock_creator', token: 'IGAAmock' + 'x'.repeat(60), media: [], containers: {}, refreshes: 0 },
    tt: { open_id: 'tt-open-1', codes: new Map(), access: 'act.mock', refresh: 'rft.mock', videos: [], publishes: {}, refreshes: 0 },
  };
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const fault = (name) => {
    if (S.faults[name] > 0) {
      S.faults[name]--;
      return true;
    }
    return false;
  };
  const fileFor = (platform, vid) => join(dir, `${platform}-${vid}.mp4`);

  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }
  function parse(req, buf) {
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('json')) return JSON.parse(buf.toString() || '{}');
    if (ct.includes('urlencoded')) return Object.fromEntries(new URLSearchParams(buf.toString()));
    return {};
  }
  const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    S.calls.push(`${req.method} ${path}`);
    try {
      // ---------- files ----------
      let m = path.match(/^\/files\/(youtube|instagram|tiktok)\/([\w.-]+)\.mp4$/);
      if (m) {
        const f = fileFor(m[1], m[2]);
        if (!existsSync(f)) return json(res, 404, { error: 'no such file' });
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': statSync(f).size });
        return createReadStream(f).pipe(res);
      }

      // ---------- test controls ----------
      if (path.startsWith('/_test/')) {
        const body = parse(req, await readBody(req));
        if (path === '/_test/state') return json(res, 200, S);
        if (path === '/_test/fault') {
          S.faults[body.name] = (S.faults[body.name] ?? 0) + (body.count ?? 1);
          return json(res, 200, { ok: true });
        }
        if (path === '/_test/youtube/add') {
          const vid = body.id ?? id('yt');
          copyFileSync(body.file, fileFor('youtube', vid));
          S.yt.videos.unshift({ id: vid, title: body.title, description: body.description ?? '', publishedAt: new Date(body.at ?? Date.now()).toISOString(), duration: body.duration, privacy: body.privacy ?? 'public' });
          return json(res, 200, { id: vid });
        }
        if (path === '/_test/instagram/add') {
          const vid = body.id ?? id('ig');
          copyFileSync(body.file, fileFor('instagram', vid));
          S.ig.media.unshift({ id: vid, caption: body.caption, timestamp: new Date(body.at ?? Date.now()).toISOString(), media_type: 'VIDEO' });
          return json(res, 200, { id: vid });
        }
        if (path === '/_test/tiktok/add') {
          const vid = body.id ?? id('7');
          copyFileSync(body.file, fileFor('tiktok', vid));
          S.tt.videos.unshift({ id: vid, desc: body.caption, create_time: Math.floor((body.at ?? Date.now()) / 1000), duration: body.duration, width: body.width, height: body.height });
          return json(res, 200, { id: vid });
        }
        // The user opens the TikTok inbox draft and posts it: TikTok re-encodes it smaller.
        if (path === '/_test/tiktok/finish-inbox') {
          const p = S.tt.publishes[body.publish_id];
          if (!p || p.status !== 'SEND_TO_USER_INBOX') return json(res, 400, { error: 'no inbox draft' });
          const vid = id('7');
          execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', p.file, '-vf', 'scale=576:-2', '-c:v', 'libx264', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', fileFor('tiktok', vid)]);
          const dur = Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fileFor('tiktok', vid)]).toString());
          S.tt.videos.unshift({ id: vid, desc: body.caption ?? 'posted from inbox', create_time: Math.floor(Date.now() / 1000), duration: Math.round(dur) });
          p.status = 'PUBLISHED_BY_USER';
          return json(res, 200, { id: vid });
        }
        return json(res, 404, {});
      }

      // ---------- Google OAuth ----------
      if (path === '/google-auth/o/oauth2/v2/auth') {
        if (!u.searchParams.get('code_challenge') || u.searchParams.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'pkce required' });
        if (u.searchParams.get('access_type') !== 'offline') return json(res, 400, { error: 'offline access expected' });
        const code = 'gcode-' + ++seq;
        S.google.codes.add(code);
        res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}&scope=${encodeURIComponent(u.searchParams.get('scope'))}` });
        return res.end();
      }
      if (path === '/google-token/token') {
        const b = parse(req, await readBody(req));
        if (!b.client_id || !b.client_secret) return json(res, 401, { error: 'invalid_client' });
        if (b.grant_type === 'authorization_code') {
          if (!S.google.codes.delete(b.code) || !b.code_verifier) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, { access_token: S.google.access, refresh_token: 'g-refresh', expires_in: 3599, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly', token_type: 'Bearer' });
        }
        if (b.grant_type === 'refresh_token') {
          if (b.refresh_token !== 'g-refresh') return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          S.google.refreshes++;
          S.google.access = 'ya29.mock-' + Date.now();
          return json(res, 200, { access_token: S.google.access, expires_in: 3599 });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }

      // ---------- YouTube ----------
      if (path.startsWith('/youtube/')) {
        if (bearer(req) !== S.google.access) return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
        if (path === '/youtube/youtube/v3/channels') return json(res, 200, { items: [{ id: S.yt.channel.id, snippet: { title: S.yt.channel.title, thumbnails: { default: { url: 'https://example.invalid/a.jpg' } } }, contentDetails: { relatedPlaylists: { uploads: S.yt.channel.uploads } } }] });
        if (path === '/youtube/youtube/v3/playlistItems') {
          if (u.searchParams.get('playlistId') !== S.yt.channel.uploads) return json(res, 404, { error: { message: 'playlistNotFound' } });
          return json(res, 200, { items: S.yt.videos.slice(0, Number(u.searchParams.get('maxResults') ?? 5)).map((v) => ({ contentDetails: { videoId: v.id } })) });
        }
        if (path === '/youtube/youtube/v3/videos' && req.method === 'GET') {
          const ids = (u.searchParams.get('id') ?? '').split(',');
          return json(res, 200, {
            items: S.yt.videos
              .filter((v) => ids.includes(v.id))
              .map((v) => ({
                id: v.id,
                snippet: { title: v.title, description: v.description, publishedAt: v.publishedAt, liveBroadcastContent: 'none', thumbnails: { medium: { url: 'https://example.invalid/t.jpg' } } },
                contentDetails: { duration: `PT${Math.floor(v.duration / 60)}M${v.duration % 60}S` },
                status: { privacyStatus: v.privacy, uploadStatus: 'processed' },
              })),
          });
        }
        if (path === '/youtube/upload/youtube/v3/videos' && req.method === 'POST') {
          if (u.searchParams.get('uploadType') !== 'resumable') return json(res, 400, { error: { message: 'resumable expected' } });
          const meta = JSON.parse((await readBody(req)).toString());
          if (!meta.snippet?.title || meta.snippet.title.length > 100 || /[<>]/.test(meta.snippet.title)) return json(res, 400, { error: { message: 'invalidTitle' } });
          const sid = 'sess' + ++seq;
          S.yt.sessions[sid] = { meta, size: Number(req.headers['x-upload-content-length']), got: 0 };
          res.writeHead(200, { Location: `${base()}/youtube/upload-session/${sid}` });
          return res.end();
        }
        m = path.match(/^\/youtube\/upload-session\/(\w+)$/);
        if (m && req.method === 'PUT') {
          const sess = S.yt.sessions[m[1]];
          if (!sess) return json(res, 404, { error: { message: 'session not found' } });
          const buf = await readBody(req);
          // "bytes */size" asks how far an upload got: finished (200, the video again) or not (308).
          if (/^bytes \*\//.test(req.headers['content-range'] ?? '')) {
            if (sess.result) return json(res, 200, sess.result);
            res.writeHead(308);
            return res.end();
          }
          if (fault('youtube-put')) return json(res, 503, { error: { message: 'backendError' } });
          if (buf.length !== sess.size) return json(res, 400, { error: { message: `expected ${sess.size} bytes, got ${buf.length}` } });
          const vid = id('ytup');
          writeFileSync(fileFor('youtube', vid), buf);
          const dur = Math.round(Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fileFor('youtube', vid)]).toString()));
          S.yt.videos.unshift({ id: vid, title: sess.meta.snippet.title, description: sess.meta.snippet.description, publishedAt: new Date().toISOString(), duration: dur, privacy: sess.meta.status.privacyStatus, viaApi: true });
          sess.result = { id: vid, snippet: sess.meta.snippet, status: { privacyStatus: sess.meta.status.privacyStatus, uploadStatus: 'uploaded' } };
          return json(res, 200, sess.result);
        }
      }

      // ---------- Instagram ----------
      if (path.startsWith('/instagram/')) {
        const buf = await readBody(req);
        const b = { ...Object.fromEntries(u.searchParams), ...parse(req, buf) };
        if (path === '/instagram/refresh_access_token') {
          if (b.access_token !== S.ig.token) return json(res, 400, { error: { message: 'Invalid OAuth access token', code: 190 } });
          S.ig.refreshes++;
          return json(res, 200, { access_token: S.ig.token, token_type: 'bearer', expires_in: 5183944 });
        }
        if (b.access_token !== S.ig.token) return json(res, 400, { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } });
        if (path === '/instagram/v24.0/me') return json(res, 200, { id: 'app-scoped-1', user_id: S.ig.user_id, username: S.ig.username, account_type: 'MEDIA_CREATOR', profile_picture_url: 'https://example.invalid/p.jpg' });
        if (path === '/instagram/v24.0/me/media')
          return json(res, 200, {
            data: S.ig.media.map((x) => ({ id: x.id, caption: x.caption, media_type: x.media_type, media_product_type: 'REELS', media_url: `${base()}/files/instagram/${x.id}.mp4`, permalink: `https://www.instagram.com/reel/${x.id}/`, timestamp: x.timestamp })),
          });
        if (path === `/instagram/v24.0/${S.ig.user_id}/media` && req.method === 'POST') {
          if (b.media_type !== 'REELS' || !b.video_url) return json(res, 400, { error: { message: 'media_type REELS and video_url required' } });
          if (fault('ig-create')) return json(res, 500, { error: { message: 'An unexpected error has occurred. Please retry your request later.', is_transient: true } });
          // Like Meta: fetch the video from the public URL.
          const r = await fetch(b.video_url);
          if (!r.ok) return json(res, 400, { error: { message: `could not fetch video_url (${r.status})` } });
          const cid = 'c' + ++seq;
          const f = join(dir, `ig-container-${cid}.mp4`);
          writeFileSync(f, Buffer.from(await r.arrayBuffer()));
          S.ig.containers[cid] = { file: f, caption: b.caption, polls: 0, fail: fault('ig-process') };
          return json(res, 200, { id: cid });
        }
        if (path === `/instagram/v24.0/${S.ig.user_id}/media_publish`) {
          const c = S.ig.containers[b.creation_id];
          if (!c || c.status !== 'FINISHED') return json(res, 400, { error: { message: 'Media ID is not available' } });
          const mid = id('18');
          copyFileSync(c.file, fileFor('instagram', mid));
          S.ig.media.unshift({ id: mid, caption: c.caption, timestamp: new Date().toISOString(), media_type: 'VIDEO', viaApi: true });
          c.published = mid;
          return json(res, 200, { id: mid });
        }
        m = path.match(/^\/instagram\/v24\.0\/(\w+)$/);
        if (m && S.ig.containers[m[1]]) {
          const c = S.ig.containers[m[1]];
          c.polls++;
          c.status = c.fail ? 'ERROR' : c.polls >= 2 ? 'FINISHED' : 'IN_PROGRESS';
          return json(res, 200, { status_code: c.status, status: c.fail ? 'Error: 2207026 — unsupported video format' : c.status, id: m[1] });
        }
        if (m) return json(res, 200, { id: m[1], permalink: `https://www.instagram.com/reel/${m[1]}/` });
      }

      // ---------- TikTok ----------
      if (path === '/tiktok-auth/v2/auth/authorize/') {
        const ch = u.searchParams.get('code_challenge') ?? '';
        if (!/^[0-9a-f]{64}$/.test(ch)) return json(res, 400, { error: 'code_challenge must be hex SHA-256 for desktop' });
        const code = 'tcode-' + ++seq;
        S.tt.codes.set(code, { challenge: ch, scope: u.searchParams.get('scope') });
        res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}&scopes=${u.searchParams.get('scope')}` });
        return res.end();
      }
      if (path.startsWith('/tiktok/')) {
        const buf = await readBody(req);
        if (path === '/tiktok/v2/oauth/token/') {
          const b = parse(req, buf);
          if (b.grant_type === 'authorization_code') {
            const c = S.tt.codes.get(b.code);
            const { createHash } = await import('node:crypto');
            if (!c || createHash('sha256').update(b.code_verifier ?? '').digest('hex') !== c.challenge) return json(res, 200, { error: 'invalid_grant', error_description: 'bad code or verifier' });
            S.tt.codes.delete(b.code);
            return json(res, 200, { access_token: S.tt.access, expires_in: 86400, open_id: S.tt.open_id, refresh_token: S.tt.refresh, refresh_expires_in: 31536000, scope: c.scope, token_type: 'Bearer' });
          }
          if (b.grant_type === 'refresh_token') {
            if (b.refresh_token !== S.tt.refresh) return json(res, 200, { error: 'invalid_grant', error_description: 'refresh token invalid' });
            S.tt.refreshes++;
            S.tt.access = 'act.mock-' + Date.now();
            return json(res, 200, { access_token: S.tt.access, expires_in: 86400, open_id: S.tt.open_id, refresh_token: S.tt.refresh, refresh_expires_in: 31536000 });
          }
        }
        m = path.match(/^\/tiktok\/upload\/(\w+)$/);
        if (m && req.method === 'PUT') {
          const p = S.tt.publishes[m[1]];
          const r = (req.headers['content-range'] ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!p || !r) return json(res, 400, { error: { code: 'invalid_params', message: 'bad Content-Range' } });
          const [s0, e0, total] = r.slice(1).map(Number);
          if (total !== p.size || s0 !== p.got || e0 - s0 + 1 !== buf.length) return json(res, 400, { error: { code: 'invalid_params', message: `range ${s0}-${e0}/${total} does not follow ${p.got}/${p.size}` } });
          appendFileSync(p.file, buf);
          p.got += buf.length;
          p.chunks++;
          return res.writeHead(p.got === p.size ? 201 : 206).end();
        }
        if (bearer(req) !== S.tt.access) return json(res, 401, { error: { code: 'access_token_invalid', message: 'The access token is invalid or not found in the request.' } });
        const b = parse(req, buf);
        const ok = (data) => json(res, 200, { data, error: { code: 'ok', message: '', log_id: 'log' } });
        if (path === '/tiktok/v2/user/info/') return ok({ user: { open_id: S.tt.open_id, display_name: 'Mock Tok', avatar_url: 'https://example.invalid/tt.jpg' } });
        if (path === '/tiktok/v2/video/list/')
          return ok({
            videos: S.tt.videos.slice(0, b.max_count ?? 10).map((v) => ({ id: v.id, create_time: v.create_time, title: v.desc, video_description: v.desc, duration: v.duration, width: v.width, height: v.height, share_url: `${base()}/files/tiktok/${v.id}.mp4`, cover_image_url: 'https://example.invalid/c.jpg' })),
            cursor: 0,
            has_more: false,
          });
        if (path === '/tiktok/v2/post/publish/creator_info/query/') return ok({ creator_username: 'mocktok', privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 600 });
        if (path === '/tiktok/v2/post/publish/inbox/video/init/' || path === '/tiktok/v2/post/publish/video/init/') {
          if (fault('tt-init')) return json(res, 500, { error: { code: 'internal_error', message: 'Something went wrong' } });
          const si = b.source_info ?? {};
          const { video_size, chunk_size, total_chunk_count } = si;
          if (si.source !== 'FILE_UPLOAD' || !video_size || !chunk_size || !total_chunk_count) return json(res, 400, { error: { code: 'invalid_params', message: 'source_info incomplete' } });
          if (video_size >= 5 * 1048576 && (chunk_size < 5 * 1048576 || chunk_size > 64 * 1048576)) return json(res, 400, { error: { code: 'invalid_params', message: 'chunk_size out of range' } });
          if (Math.floor(video_size / chunk_size) !== total_chunk_count && video_size >= 5 * 1048576) return json(res, 400, { error: { code: 'invalid_params', message: 'total_chunk_count mismatch' } });
          const direct = path.includes('/video/init/') && !path.includes('inbox');
          if (direct && b.post_info?.privacy_level !== 'SELF_ONLY') return json(res, 403, { error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'Please review our integration guidelines' } });
          const pid = 'v_pub_' + ++seq;
          S.tt.publishes[pid] = { mode: direct ? 'direct' : 'inbox', size: video_size, got: 0, chunks: 0, expectChunks: total_chunk_count, file: join(dir, `tt-upload-${pid}.mp4`), polls: 0, caption: b.post_info?.title };
          writeFileSync(S.tt.publishes[pid].file, '');
          return ok({ publish_id: pid, upload_url: `${base()}/tiktok/upload/${pid}` });
        }
        if (path === '/tiktok/v2/post/publish/status/fetch/') {
          const p = S.tt.publishes[b.publish_id];
          if (!p) return json(res, 400, { error: { code: 'invalid_publish_id', message: '' } });
          if (p.got !== p.size || p.chunks !== p.expectChunks) return ok({ status: 'PROCESSING_UPLOAD', uploaded_bytes: p.got });
          p.polls++;
          if (p.polls < 2) return ok({ status: 'PROCESSING_DOWNLOAD' });
          if (p.mode === 'inbox') {
            p.status ??= 'SEND_TO_USER_INBOX';
            return ok({ status: 'SEND_TO_USER_INBOX' });
          }
          return ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] });
        }
      }
      json(res, 404, { error: { message: `mock has no route ${req.method} ${path}` } });
    } catch (e) {
      json(res, 500, { error: { message: String(e?.stack ?? e) } });
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, S, base: base() })));
}
