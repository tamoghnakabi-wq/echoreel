import type { RemoteVideo, Tokens } from '../types';
import { AuthError, PermanentError } from '../types';
import { classify, clip, http, POLL_MS, sleep, titleFrom } from '../util';
import type { Connected, Ctx, PlatformApi, PublishResult } from './common';

/** Instagram API with Instagram Login (graph.instagram.com). */
export const IG_VERSION = 'v24.0';
const api = (ctx: Ctx, path: string) => `${ctx.hosts.instagram}/${IG_VERSION}/${path}`;

/**
 * Connect with an access token generated in the Meta app dashboard
 * (Instagram → API setup with Instagram login → Generate token). Those tokens last
 * 60 days and Echoreel keeps extending them.
 */
export async function connectInstagram(ctx: Ctx, token: string): Promise<Connected> {
  token = token.trim();
  if (!/^[A-Za-z0-9_|-]{40,}$/.test(token)) throw new Error("That doesn't look like an Instagram access token (it should be one long line starting with IG…).");
  let me: any;
  try {
    me = await http(`${api(ctx, 'me')}?fields=user_id,username,name,profile_picture_url,account_type&access_token=${encodeURIComponent(token)}`);
  } catch (e) {
    throw new Error(`Instagram didn't accept the token: ${(e as Error).message}`);
  }
  if (me.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(me.account_type))
    throw new Error('Instagram only lets apps post to professional accounts. Switch to a Creator or Business account in the Instagram app (Settings → Account type and tools), then try again.');
  return {
    account: { platform: 'instagram', id: String(me.user_id ?? me.id), name: '@' + (me.username ?? 'instagram'), avatar: me.profile_picture_url },
    tokens: { access: token, issuedAt: Date.now(), expiresAt: Date.now() + 59 * 86400_000 },
  };
}

export const instagram: PlatformApi = {
  async refresh(ctx, tokens) {
    // Long-lived tokens can be extended once they are a day old; doing it every few days keeps them alive forever.
    try {
      const t = await http(`${ctx.hosts.instagram}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tokens.access)}`);
      return { access: t.access_token, issuedAt: Date.now(), expiresAt: Date.now() + Number(t.expires_in ?? 5_184_000) * 1000 };
    } catch (e) {
      const err = classify(e);
      if (tokens.expiresAt && tokens.expiresAt < Date.now()) throw new AuthError('The Instagram token expired. Generate a new one in the Meta app dashboard and connect again.');
      throw err;
    }
  },

  async listRecent(ctx, s) {
    const tok = encodeURIComponent(await s.token());
    let r: any;
    try {
      r = await http(`${api(ctx, 'me/media')}?fields=id,caption,media_type,media_product_type,media_url,permalink,timestamp,thumbnail_url&limit=15&access_token=${tok}`);
    } catch (e) {
      throw classify(e);
    }
    return (r.data ?? [])
      .filter((m: any) => m.media_type === 'VIDEO')
      .map((m: any): RemoteVideo => {
        const caption = m.caption ?? '';
        return {
          platform: 'instagram',
          id: String(m.id),
          url: m.permalink ?? `https://www.instagram.com/`,
          // media_url is left out for reels with licensed music; yt-dlp on the permalink is the fallback.
          downloadUrl: m.media_url ?? m.permalink,
          direct: !!m.media_url,
          title: titleFrom(caption, 'Instagram reel'),
          caption,
          createdAt: Date.parse(m.timestamp ?? '') || Date.now(),
          thumbnail: m.thumbnail_url,
          ready: true,
        };
      });
  },

  async publish(ctx, s, t, job, p): Promise<PublishResult> {
    const igId = s.account.id;
    const tok = await s.token();
    p.stage('uploading', 'sharing the file with Instagram');
    const shared = await ctx.tunnel.share(t.file!);
    let container: string;
    try {
      let created: any;
      try {
        created = await http(api(ctx, `${igId}/media`), {
          form: { media_type: 'REELS', video_url: shared.url, caption: clip(t.caption, 2200), share_to_feed: 'true', access_token: tok },
        });
      } catch (e) {
        throw classify(e);
      }
      container = created.id;
      p.stage('processing', 'Instagram is processing the reel');
      // Instagram downloads and transcodes the video; this usually takes under a minute.
      const deadline = Date.now() + 20 * 60_000;
      for (;;) {
        await sleep(POLL_MS);
        const st = await http(`${api(ctx, container)}?fields=status_code,status&access_token=${encodeURIComponent(tok)}`).catch((e) => {
          throw classify(e);
        });
        if (st.status_code === 'FINISHED') break;
        if (st.status_code === 'ERROR') throw new PermanentError(`Instagram couldn't process the video: ${st.status ?? 'unknown error'}`);
        if (st.status_code === 'EXPIRED') throw new Error('Instagram let the upload expire before it was published');
        if (Date.now() > deadline) throw new Error('Instagram took more than 20 minutes to process the reel');
      }
    } finally {
      shared.done();
    }
    let pub: any;
    try {
      pub = await http(api(ctx, `${igId}/media_publish`), { form: { creation_id: container, access_token: tok } });
    } catch (e) {
      throw classify(e);
    }
    let link: string | undefined;
    try {
      link = (await http(`${api(ctx, pub.id)}?fields=permalink&access_token=${encodeURIComponent(tok)}`)).permalink;
    } catch {
      /* the post exists; the link is a nicety */
    }
    return { status: 'done', resultId: String(pub.id), resultUrl: link };
  },
};
