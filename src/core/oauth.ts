import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** The fixed local address Google and TikTok send the sign-in back to. */
export const OAUTH_PORT = 47621;
export const GOOGLE_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/google/callback`;
export const TIKTOK_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/tiktok/callback/`;

export function pkce(encoding: 'base64url' | 'hex') {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, within 43..128
  const challenge = createHash('sha256').update(verifier).digest(encoding);
  return { verifier, challenge };
}

export const newState = () => randomBytes(16).toString('hex');

const page = (title: string, body: string, ok: boolean) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,sans-serif;background:#0d0d12;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
div{max-width:460px;text-align:center}h1{font-size:22px;color:${ok ? '#7ef0b0' : '#ff8a8a'}}p{color:#aaa}</style>
<div><h1>${title}</h1><p>${body}</p></div>`;

/**
 * Wait for one sign-in redirect on 127.0.0.1:OAUTH_PORT at `path`, check its state,
 * and return the authorization code. Gives up after five minutes.
 */
export function waitForCode(path: string, state: string, open: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${OAUTH_PORT}`);
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (err || !code || url.searchParams.get('state') !== state) {
        const why = err ? `${err}${url.searchParams.get('error_description') ? ': ' + url.searchParams.get('error_description') : ''}` : 'the sign-in response did not match';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Not connected', why, false));
        finish(new Error(`sign-in was not completed (${why})`));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Connected', 'Echoreel has the permission it asked for. You can close this tab and go back to the app.', true));
      finish(null, code);
    });
    const timer = setTimeout(() => finish(new Error('sign-in timed out after 5 minutes')), 5 * 60_000);
    let done = false;
    function finish(e: Error | null, code?: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (e) reject(e);
      else resolve(code!);
    }
    server.on('error', (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === 'EADDRINUSE' ? `port ${OAUTH_PORT} is busy — finish or cancel the other sign-in first` : e.message)),
    );
    server.listen(OAUTH_PORT, '127.0.0.1', open);
  });
}
