import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { TIKTOK_REDIRECT, newState, pkce, waitForCode } from '../oauth';
import type { RemoteVideo, Settings, Tokens } from '../types';
import { AuthError, PermanentError } from '../types';
import { classify, clip, http, HttpError, POLL_MS, sleep, titleFrom } from '../util';
import type { Connected, Ctx, PlatformApi, PublishResult } from './common';

export const tiktokScopes = (s: Settings) => ['user.info.basic', 'video.list', s.tiktokMode === 'direct' ? 'video.publish' : 'video.upload'];

/** TikTok answers 200 with {error:{code}} for many failures. */
async function tt<T = any>(url: string, opts: Parameters<typeof http>[1]): Promise<T> {
  let r: any;
  try {
    r = await http(url, opts);
  } catch (e) {
    throw classify(e);
  }
  const code = r?.error?.code;
  if (code && code !== 'ok') {
    const msg = `TikTok: ${code}${r.error.message ? ' — ' + r.error.message : ''}`;
    if (/access_token_invalid|scope_not_authorized|scope_permission_missing/.test(code)) throw new AuthError(msg);
    if (/unaudited_client|privacy_level_option_mismatch|spam_risk|reached_active_user_cap/.test(code)) throw new PermanentError(msg);
    throw new HttpError(msg, 400, r);
  }
  return r;
}

export async function connectTikTok(ctx: Ctx): Promise<Connected> {
  const c = ctx.creds.tiktok;
  if (!c?.clientKey || !c.clientSecret) throw new Error('Add your TikTok client key and secret first (Connections → TikTok → Set up).');
  // TikTok's desktop flow wants the PKCE challenge hex-encoded (not base64url).
  const { verifier, challenge } = pkce('hex');
  const state = newState();
  const url =
    `${ctx.hosts.tiktokAuth}/v2/auth/authorize/?` +
    new URLSearchParams({
      client_key: c.clientKey,
      response_type: 'code',
      scope: tiktokScopes(ctx.settings).join(','),
      redirect_uri: TIKTOK_REDIRECT,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  const code = await waitForCode('/tiktok/callback/', state, () => ctx.openExternal(url));
  const tok = await tt(`${ctx.hosts.tiktok}/v2/oauth/token/`, {
    form: { client_key: c.clientKey, client_secret: c.clientSecret, code, grant_type: 'authorization_code', redirect_uri: TIKTOK_REDIRECT, code_verifier: verifier },
  });
  if (!tok.access_token) throw new Error(`TikTok sign-in failed: ${tok.error_description ?? tok.error ?? 'no token returned'}`);
  const granted = String(tok.scope ?? '');
  for (const s of tiktokScopes(ctx.settings)) if (granted && !granted.includes(s)) throw new Error(`TikTok didn't grant "${s}". Add that scope to your TikTok app, then connect again.`);
  const tokens: Tokens = {
    access: tok.access_token,
    refresh: tok.refresh_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
    refreshExpiresAt: Date.now() + (tok.refresh_expires_in ?? 31_536_000) * 1000,
    issuedAt: Date.now(),
  };
  const me = await tt(`${ctx.hosts.tiktok}/v2/user/info/?fields=open_id,display_name,avatar_url`, { headers: { Authorization: `Bearer ${tokens.access}` } });
  const u = me.data?.user ?? {};
  return { account: { platform: 'tiktok', id: u.open_id ?? tok.open_id, name: u.display_name ?? 'TikTok', avatar: u.avatar_url }, tokens };
}

const MB = 1024 * 1024;
/**
 * TikTok's chunk rules: up to 64 MB goes in one piece (under 5 MB it must); bigger files go in
 * 5–64 MB chunks, total_chunk_count = floor(size / chunk_size), and the last chunk takes the
 * remainder (up to 128 MB). At most 1000 chunks.
 */
export function chunkPlan(size: number) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  let chunkSize = 10 * MB;
  while (Math.floor(size / chunkSize) > 1000) chunkSize += 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

export const tiktok: PlatformApi = {
  async refresh(ctx, tokens) {
    const c = ctx.creds.tiktok;
    if (!c || !tokens.refresh) throw new AuthError('TikTok needs to be connected again.');
    if (tokens.refreshExpiresAt && tokens.refreshExpiresAt < Date.now()) throw new AuthError('The TikTok sign-in expired after a year. Connect again.');
    let t: any;
    try {
      t = await tt(`${ctx.hosts.tiktok}/v2/oauth/token/`, { form: { client_key: c.clientKey, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refresh } });
    } catch (e) {
      if (e instanceof HttpError && /invalid_grant|invalid_request/.test(e.message)) throw new AuthError('TikTok ended the sign-in. Connect again.');
      throw e;
    }
    if (!t.access_token) throw new AuthError(`TikTok refused to refresh the sign-in (${t.error_description ?? t.error ?? 'unknown'}). Connect again.`);
    return {
      access: t.access_token,
      refresh: t.refresh_token ?? tokens.refresh,
      expiresAt: Date.now() + t.expires_in * 1000,
      refreshExpiresAt: t.refresh_expires_in ? Date.now() + t.refresh_expires_in * 1000 : tokens.refreshExpiresAt,
      issuedAt: Date.now(),
    };
  },

  async listRecent(ctx, s) {
    const r = await tt(`${ctx.hosts.tiktok}/v2/video/list/?fields=id,create_time,title,video_description,duration,share_url,cover_image_url,height,width`, {
      headers: { Authorization: `Bearer ${await s.token()}` },
      body: { max_count: 15 },
    });
    return (r.data?.videos ?? []).map((v: any): RemoteVideo => {
      const caption = v.video_description || v.title || '';
      const url = v.share_url ?? `https://www.tiktok.com/video/${v.id}`;
      return {
        platform: 'tiktok',
        id: String(v.id),
        url: url.split('?')[0],
        downloadUrl: url,
        direct: /\.mp4($|\?)/.test(url),
        title: titleFrom(v.title || caption, 'TikTok video'),
        caption,
        createdAt: Number(v.create_time) * 1000 || Date.now(),
        duration: v.duration,
        width: v.width,
        height: v.height,
        thumbnail: v.cover_image_url,
        ready: true,
      };
    });
  },

  async publish(ctx, s, t, job, p): Promise<PublishResult> {
    const auth = async () => ({ Authorization: `Bearer ${await s.token()}` });
    const size = statSync(t.file!).size;
    const { chunkSize, count } = chunkPlan(size);
    const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count };
    let publishId = t.handle;
    if (!publishId) {
      let init: any;
      if (t.mode === 'direct') {
        const info = await tt(`${ctx.hosts.tiktok}/v2/post/publish/creator_info/query/`, { headers: await auth(), body: {} });
        const opts: string[] = info.data?.privacy_level_options ?? [];
        const max = Number(info.data?.max_video_post_duration_sec ?? 600);
        if (job.duration && job.duration > max) throw new PermanentError(`TikTok allows this account ${max} s per video; this one is ${Math.round(job.duration)} s`);
        const privacy = opts.includes(ctx.settings.tiktokPrivacy) ? ctx.settings.tiktokPrivacy : null;
        if (!privacy)
          throw new PermanentError(
            `TikTok won't post this as ${ctx.settings.tiktokPrivacy} (allowed: ${opts.join(', ') || 'none'}). Until your TikTok app passes its audit, use "Send to TikTok inbox" in Rules.`,
          );
        init = await tt(`${ctx.hosts.tiktok}/v2/post/publish/video/init/`, {
          headers: await auth(),
          body: { post_info: { title: clip(t.caption, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false }, source_info },
        });
      } else {
        init = await tt(`${ctx.hosts.tiktok}/v2/post/publish/inbox/video/init/`, { headers: await auth(), body: { source_info } });
      }
      publishId = init.data.publish_id as string;
      const uploadUrl = init.data.upload_url as string;
      p.stage('uploading');
      const fd = openSync(t.file!, 'r');
      try {
        for (let i = 0; i < count; i++) {
          const start = i * chunkSize;
          const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
          const buf = Buffer.alloc(end - start + 1);
          readSync(fd, buf, 0, buf.length, start);
          for (let attempt = 1; ; attempt++) {
            const res = await fetch(uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
              body: buf,
              signal: AbortSignal.timeout(10 * 60_000),
            }).catch((e) => e as Error);
            if (!(res instanceof Error) && res.ok) break;
            const why = res instanceof Error ? res.message : `HTTP ${res.status} ${await res.text().catch(() => '')}`;
            if (attempt >= 4) throw new Error(`TikTok chunk ${i + 1}/${count} failed: ${why}`);
            await sleep(2000 * attempt);
          }
          p.progress?.(Math.round(((i + 1) / count) * 100));
        }
      } finally {
        closeSync(fd);
      }
      t.handle = publishId;
    }
    p.stage('processing', 'TikTok is processing the video');
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      await sleep(POLL_MS);
      const st = await tt(`${ctx.hosts.tiktok}/v2/post/publish/status/fetch/`, { headers: await auth(), body: { publish_id: publishId } });
      const status = st.data?.status;
      if (status === 'FAILED') {
        t.handle = undefined;
        throw new PermanentError(`TikTok rejected the video: ${st.data?.fail_reason ?? 'unknown reason'}`);
      }
      if (status === 'SEND_TO_USER_INBOX')
        return {
          status: 'action',
          handle: publishId,
          action: 'Open TikTok and tap the inbox notification to finish posting (paste the caption from Echoreel).',
        };
      if (status === 'PUBLISH_COMPLETE') {
        const id = st.data?.publicaly_available_post_id?.[0] ?? st.data?.publicly_available_post_id?.[0];
        return { status: 'done', handle: publishId, resultId: id ? String(id) : undefined, resultUrl: id ? `https://www.tiktok.com/@/video/${id}` : undefined };
      }
      if (Date.now() > deadline) throw new Error('TikTok took more than 30 minutes to process the video');
    }
  },
};
