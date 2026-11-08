import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { GOOGLE_REDIRECT, newState, pkce, waitForCode } from '../oauth';
import type { RemoteVideo, Tokens } from '../types';
import { AuthError, PermanentError } from '../types';
import { classify, describe, http, HttpError, sleep } from '../util';
import type { Connected, Ctx, PlatformApi, PublishResult } from './common';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export async function connectYouTube(ctx: Ctx): Promise<Connected> {
  const c = ctx.creds.google;
  if (!c?.clientId || !c.clientSecret) throw new Error('Add your Google client ID and secret first (Connections → YouTube → Set up).');
  const { verifier, challenge } = pkce('base64url');
  const state = newState();
  const url =
    `${ctx.hosts.googleAuth}/o/oauth2/v2/auth?` +
    new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: GOOGLE_REDIRECT,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  const code = await waitForCode('/google/callback', state, () => ctx.openExternal(url));
  const tok = await http(`${ctx.hosts.googleToken}/token`, {
    form: { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code', code_verifier: verifier },
  });
  const granted = String(tok.scope ?? '');
  for (const s of SCOPES) if (granted && !granted.includes(s)) throw new Error(`Google didn't grant ${s.split('/').pop()} — tick every box on the consent screen.`);
  const tokens: Tokens = { access: tok.access_token, refresh: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000, issuedAt: Date.now() };
  if (!tokens.refresh) throw new Error('Google did not return a refresh token. Remove Echoreel at myaccount.google.com/permissions and connect again.');
  const ch = await http(`${ctx.hosts.youtube}/youtube/v3/channels?part=snippet,contentDetails&mine=true`, { headers: { Authorization: `Bearer ${tokens.access}` } });
  const channel = ch.items?.[0];
  if (!channel) throw new Error('This Google account has no YouTube channel. Create one at youtube.com first.');
  return {
    account: {
      platform: 'youtube',
      id: channel.id,
      name: channel.snippet?.title ?? 'YouTube channel',
      avatar: channel.snippet?.thumbnails?.default?.url,
      extra: { uploads: channel.contentDetails?.relatedPlaylists?.uploads ?? 'UU' + String(channel.id).slice(2) },
    },
    tokens,
  };
}

/** ISO 8601 duration (PT1M5S) → seconds */
export function isoSeconds(d: string): number {
  const m = d?.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export const youtube: PlatformApi = {
  async refresh(ctx, tokens) {
    const c = ctx.creds.google;
    if (!c || !tokens.refresh) throw new AuthError('YouTube needs to be connected again.');
    try {
      const t = await http(`${ctx.hosts.googleToken}/token`, { form: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: tokens.refresh, grant_type: 'refresh_token' } });
      return { ...tokens, access: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, issuedAt: Date.now(), refresh: t.refresh_token ?? tokens.refresh };
    } catch (e) {
      const err = classify(e);
      if (/invalid_grant/.test(err.message))
        throw new AuthError('Google ended the sign-in (invalid_grant). If your Google Cloud app is still in "Testing", sign-ins expire after 7 days — publish it (see the setup guide), then reconnect.');
      throw err;
    }
  },

  async listRecent(ctx, s) {
    const auth = { Authorization: `Bearer ${await s.token()}` };
    const playlist = s.account.extra?.uploads;
    let pl: any;
    try {
      pl = await http(`${ctx.hosts.youtube}/youtube/v3/playlistItems?part=contentDetails&maxResults=15&playlistId=${playlist}`, { headers: auth });
    } catch (e) {
      // A brand-new channel has no uploads playlist yet.
      if ((e as any).status === 404) return [];
      throw classify(e);
    }
    const ids = (pl.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const vids = await http(`${ctx.hosts.youtube}/youtube/v3/videos?part=snippet,contentDetails,status,liveStreamingDetails&id=${ids.join(',')}`, { headers: auth }).catch((e) => {
      throw classify(e);
    });
    return (vids.items ?? []).map((v: any): RemoteVideo => {
      const title = v.snippet?.title ?? '';
      const desc = v.snippet?.description ?? '';
      return {
        platform: 'youtube',
        id: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        downloadUrl: ctx.hosts.youtubeWatch(v.id),
        title,
        caption: desc.trim() ? `${title}\n\n${desc}` : title,
        createdAt: Date.parse(v.snippet?.publishedAt ?? '') || Date.now(),
        duration: isoSeconds(v.contentDetails?.duration ?? ''),
        thumbnail: v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url,
        ready: v.status?.privacyStatus === 'public' && v.status?.uploadStatus === 'processed' && (v.snippet?.liveBroadcastContent ?? 'none') === 'none' && !v.liveStreamingDetails,
      };
    });
  },

  async publish(ctx, s, t, job, p): Promise<PublishResult> {
    if (t.mode !== 'api') {
      // Uploads from an unaudited Google project are locked to private, so by default the
      // user finishes the upload in YouTube Studio with everything prepared.
      return {
        status: 'action',
        action: 'Upload to YouTube: open YouTube Studio, drop in the prepared file and paste the title and description.',
      };
    }
    const file = t.file!;
    const size = statSync(file).size;
    const meta = {
      snippet: { title: t.title, description: t.caption, categoryId: '22' },
      status: { privacyStatus: ctx.settings.youtubePrivacy, selfDeclaredMadeForKids: false, embeddable: true },
    };
    p.stage('uploading');
    let session = t.handle;
    // A session from before a restart: ask YouTube how far it got instead of sending it all again.
    const resumed = !!session;
    if (!session) {
      const res = await fetch(`${ctx.hosts.youtube}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await s.token()}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify(meta),
      });
      if (!res.ok) throw classify(await toHttpError(res));
      session = res.headers.get('location') ?? undefined;
      if (!session) throw new Error('YouTube did not return an upload address');
      t.handle = session;
    }
    // Upload, resuming from where YouTube says it got to if the connection drops.
    for (let attempt = 0; attempt < 5; attempt++) {
      let start = 0;
      if (attempt > 0 || resumed) {
        const q = await fetch(session, { method: 'PUT', headers: { Authorization: `Bearer ${await s.token()}`, 'Content-Range': `bytes */${size}` } });
        if (q.status === 200 || q.status === 201) return done(await q.json());
        if (q.status === 404) {
          t.handle = undefined;
          throw new Error('the YouTube upload session expired; starting over');
        }
        const r = q.headers.get('range')?.match(/bytes=0-(\d+)/);
        start = r ? Number(r[1]) + 1 : 0;
      }
      try {
        let sent = start;
        const stream = Readable.toWeb(createReadStream(file, { start })) as ReadableStream<Uint8Array>;
        const counted = stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, ctl) {
              sent += chunk.byteLength;
              p.progress?.(Math.round((sent / size) * 100));
              ctl.enqueue(chunk);
            },
          }),
        );
        const res = await fetch(session, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${await s.token()}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(size - start),
            ...(start ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
          },
          body: counted,
          duplex: 'half',
        } as RequestInit);
        if (res.status === 200 || res.status === 201) return done(await res.json());
        if (res.status >= 400 && res.status < 500 && res.status !== 408) throw classify(await toHttpError(res));
      } catch (e) {
        // A 4xx answer is YouTube refusing, not a dropped connection: let the job retry later.
        if (e instanceof AuthError || e instanceof PermanentError || e instanceof HttpError) throw e;
        ctx.log(`YouTube upload interrupted (${(e as Error).message}); resuming`);
      }
      await sleep(3000 * (attempt + 1));
    }
    throw new Error('YouTube upload kept failing');

    function done(v: any): PublishResult {
      const short = (job.height ?? 0) > (job.width ?? 1) && (job.duration ?? 999) <= 180;
      return { status: 'done', resultId: v.id, resultUrl: short ? `https://youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}` };
    }
  },
};

async function toHttpError(res: Response) {
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return new HttpError(`youtube ${res.status}: ${describe(body)}`, res.status, body);
}
