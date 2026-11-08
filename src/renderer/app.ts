// Echoreel's window. Pages are rendered as HTML strings; one delegated listener handles clicks
// (data-act), and inputs keep their typed values in `drafts` so live updates never wipe them.
type Platform = 'youtube' | 'instagram' | 'tiktok';
const PLATFORMS: Platform[] = ['youtube', 'instagram', 'tiktok'];
const NAMES: Record<Platform, string> = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };

declare global {
  interface Window {
    echoreel: Record<string, (...a: any[]) => Promise<any>> & {
      onChanged(fn: () => void): void;
      onNavigate(fn: (nav: { page: string; jobId?: string }) => void): void;
      pathFor(f: File): string;
    };
  }
}
const api = window.echoreel;

let V: any = null;
let page = 'activity';
const openJobs = new Set<string>();
const drafts: Record<string, string> = {};
const errors: Record<string, string> = {};
let connecting: Platform | null = null;
let tools: Record<string, string> | null = null;
const post: { file: string | null; info: any; platforms: Set<Platform>; busy: boolean } = { file: null, info: null, platforms: new Set(PLATFORMS), busy: false };

// ---------- helpers ----------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
function ago(t?: number) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function until(t: number) {
  const m = Math.ceil((t - Date.now()) / 60000);
  return m <= 1 ? 'in a minute' : m < 90 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
}
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dur = (s?: number) => (s ? (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)} s`) : '');
const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
let toastTimer: any;
function toast(msg: string, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), bad ? 6000 : 2600);
}
const draft = (k: string, fallback = '') => (k in drafts ? drafts[k] : fallback);

// ---------- icons ----------
const I = {
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  post: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5" fill="currentColor"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
  computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.5 7.8v8.4l7-4.2z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17" cy="7" r="0.6" fill="currentColor"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 3h2.6c.3 2 1.6 3.4 3.4 3.7v2.7c-1.3 0-2.5-.4-3.5-1v6.3a5.4 5.4 0 1 1-5.4-5.4c.3 0 .6 0 .9.1v2.8a2.6 2.6 0 1 0 2 2.5z"/></svg>',
};
// Echoreel's mark: a video frame with two fading echoes behind it.
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2.8" y="7.8" width="11" height="17.4" rx="2.6" fill="none" stroke="#ffb224" stroke-opacity=".28" stroke-width="1.6"/><rect x="7.8" y="6" width="12.4" height="21" rx="3" fill="none" stroke="#ffb224" stroke-opacity=".6" stroke-width="1.6"/><rect x="13.6" y="3.5" width="15.4" height="26" rx="3.6" fill="#ffb224"/><path d="M19 12.2v8.6l6.6-4.3z" fill="#2b1d00"/></svg>`;
const pf = (p: Platform, sm = false) => `<span class="pf ${p}${sm ? ' sm' : ''}">${I[p]}</span>`;
// Remote images (avatars, thumbnails) that failed to load. Remembered so re-renders show the fallback right away.
const badImg = new Set<string>();
let pendingImgRender = false;
const okImg = (u: any): u is string => typeof u === 'string' && /^https:/.test(u) && !badImg.has(u);
function short(t?: number) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// ---------- data ----------
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let pendingRender = false;
/**
 * Fetch the latest state and redraw. One fetch at a time: a change that arrives mid-fetch is
 * fetched (and drawn) right after, so the window never stays on a stale picture.
 */
function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false;
        V = await api.view();
        renderSide();
        if (typing()) pendingRender = true;
        else renderPage();
      } while (refreshAgain);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
const typing = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && $('#main').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && (a as HTMLInputElement).type !== 'checkbox';
};
document.addEventListener('focusout', () =>
  setTimeout(() => {
    if (pendingRender && !typing()) {
      pendingRender = false;
      renderPage();
    }
  }, 0),
);

const needsYou = (): any[] => (V?.jobs ?? []).filter((j: any) => j.status === 'approval' || j.targets.some((t: any) => t.status === 'action'));
const connected = (p: Platform) => !!V?.accounts?.[p];

// ---------- sidebar ----------
function renderSide() {
  if (!V) return;
  const n = needsYou().length;
  const accounts = PLATFORMS.filter(connected);
  const s = V.settings;
  const busy = V.progress || V.checking.length;
  const navs: [string, string, string][] = [
    ['activity', 'Activity', I.activity],
    ['post', 'Post a video', I.post],
    ['connections', 'Connections', I.link],
    ['rules', 'Rules', I.rules],
    ['settings', 'Settings', I.settings],
  ];
  const inputs = `<div class="inputs">${PLATFORMS.map((p) => {
    const a = V.accounts[p];
    const st = !a ? 'off' : a.status === 'ok' && !a.lastCheckError ? 'ok' : 'bad';
    const when = !a ? 'off' : a.status !== 'ok' ? 'reconnect' : short(a.lastCheckAt);
    return `<div class="in ${st}" title="${NAMES[p]}: ${!a ? 'not connected' : a.status !== 'ok' ? 'needs reconnecting' : `checked ${ago(a.lastCheckAt)}`}"><i class="lamp"></i>${pf(p, true)}<span>${NAMES[p]}</span><time>${when}</time></div>`;
  }).join('')}</div>`;
  let watch: string;
  if (s.paused) watch = `<div class="hd"><i class="lamp warn"></i>Paused</div><p>Nothing is checked or posted.</p>${inputs}<div class="acts"><button class="btn small" data-act="pause" data-on="0">Resume</button></div>`;
  else if (!accounts.length) watch = `<div class="hd"><i class="lamp"></i>Not watching yet</div><p>Connect an account to start.</p>${inputs}<div class="acts"><button class="btn small" data-act="nav" data-page="connections">Connect</button></div>`;
  else
    watch = `<div class="hd"><i class="lamp ${busy ? 'busy' : 'good'}"></i>${busy ? (V.progress ? 'Relaying…' : 'Checking…') : `Watching ${accounts.length} account${accounts.length > 1 ? 's' : ''}`}</div>
      <p>Checks every ${s.pollMinutes} min</p>${inputs}
      <div class="acts"><button class="btn small" data-act="check">${I.refresh}Check now</button><button class="btn small ghost" data-act="pause" data-on="1">Pause</button></div>`;
  const u = V.app.update;
  const upd =
    u?.status === 'ready' && !u.blocked
      ? `<div class="watch upd"><div class="hd"><i class="lamp warn"></i>Update ready</div><p>Echoreel ${esc(u.version)} installs itself when you close this window.</p><div class="acts"><button class="btn small primary" data-act="updateInstall">Restart now</button></div></div>`
      : u?.status === 'installing'
        ? `<div class="watch upd"><div class="hd"><i class="lamp busy"></i>Updating…</div><p>Echoreel ${esc(u.version)} opens in a moment${V.progress ? ', after the current upload' : ''}.</p></div>`
        : '';
  setHtml($('#side'), `
    <div class="brand">${LOGO}Echoreel</div>
    <nav class="nav">${navs
      .map(([id, label, icon]) => `<button data-act="nav" data-page="${id}" class="${page === id ? 'on' : ''}"><i class="led"></i>${icon}<span>${label}</span>${id === 'activity' && n ? `<span class="badge">${n}</span>` : ''}</button>`)
      .join('')}</nav>
    <div class="spacer"></div>
    ${upd}<div class="watch">${watch}</div>`);
}

// ---------- pages ----------
/** Sections (<details data-key>) the user has opened; they stay open through redraws. */
const openSections = new Set<string>();
document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target as HTMLDetailsElement;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.key) return;
    d.open ? openSections.add(d.dataset.key) : openSections.delete(d.dataset.key);
  },
  true,
);

/**
 * Replace an element's content, but only when it actually changed: the app redraws whenever
 * anything happens in the background (an update downloading, an account check), and an untouched
 * page keeps its focus, selection and open sections.
 */
const drawn = new WeakMap<Element, string>();
function setHtml(el: HTMLElement, html: string) {
  if (drawn.get(el) === html) return;
  drawn.set(el, html);
  el.innerHTML = html;
  for (const d of el.querySelectorAll<HTMLDetailsElement>('details[data-key]')) d.open = openSections.has(d.dataset.key!);
}

function renderPage() {
  if (!V) return;
  const m = $('#main');
  const top = m.scrollTop;
  setHtml(m, `<div class="page">${({ activity, post: postPage, connections, rules, settings } as any)[page]()}</div>`);
  m.scrollTop = top;
  if (page === 'settings' && !tools) api.toolsInfo().then((t: any) => ((tools = t), page === 'settings' && renderPage()));
}

function head(title: string, sub: string, actions = '') {
  return `<div class="head"><div><h1>${title}</h1><p class="sub">${sub}</p></div><div class="row">${actions}</div></div>`;
}
const sec = (title: string, n?: number, tone = '') => `<h2>${title}${n ? `<span class="n ${tone}">${n}</span>` : ''}</h2>`;

function activity() {
  const accounts = PLATFORMS.filter(connected);
  if (!accounts.length)
    return `<div class="hero">
      <h1 class="echo">Post once.<span class="e1" aria-hidden="true">Post once.</span><span class="e2" aria-hidden="true">Post once.</span></h1>
      <p class="lede">Echoreel watches your YouTube, Instagram and TikTok. When you upload a video to one, it posts it to the others, in the right shape, with your caption.</p>
      <button class="btn primary" data-act="nav" data-page="connections">${I.link}Connect your accounts</button>
      <div class="steps">
        <div><b><i>1</i>Connect</b>Link the accounts you post to. Echoreel only reads your own videos.</div>
        <div><b><i>2</i>Set the routes</b>Pick what goes where: Shorts only, ask first, and more.</div>
        <div><b><i>3</i>Post as usual</b>Upload anywhere. Echoreel copies it in the background.</div>
      </div></div>`;
  const jobs = V.jobs as any[];
  const attention = needsYou();
  const others = jobs.filter((j) => !attention.includes(j));
  const p = V.progress;
  return `${head('Activity', `Watching ${list(accounts.map((x) => NAMES[x]))} for new videos.`, `<button class="btn" data-act="nav" data-page="post">${I.post}Post a video</button>`)}
    ${
      p
        ? `<div class="onair"><span class="tag"><i class="lamp"></i>Relaying</span><div class="grow"><div class="ellipsis"><b>${esc(p.label)}</b> <span class="muted">${esc(jobs.find((j) => j.id === p.jobId)?.title ?? '')}</span></div><div class="bar ${p.pct == null ? 'indef' : ''}"><i style="width:${p.pct ?? 30}%"></i></div></div></div>`
        : ''
    }
    ${attention.length ? `${sec('Needs you', attention.length, 'warn')}${attention.map((j) => `<div class="card job attention" data-job="${esc(j.id)}">${jobRow(j, true, openJobs.has(j.id))}</div>`).join('')}` : ''}
    ${sec('Relays', others.length)}
    ${others.length ? `<div class="card rundown">${others.map((j) => `<div class="job ${j.status === 'running' ? 'live' : ''}" data-job="${esc(j.id)}">${jobRow(j, openJobs.has(j.id))}</div>`).join('')}</div>` : `<div class="card empty">${I.video}<p>No relays yet. Upload a video to one of your accounts, or post one from here.</p></div>`}
    ${sec('Videos seen on your accounts')}
    ${seenTable()}`;
}

const JOB_STATUS: Record<string, [string, string]> = {
  waiting: ['Queued', 'info'],
  running: ['Working', 'info'],
  approval: ['Needs your OK', 'warn'],
  done: ['Relayed', 'good'],
  partial: ['Partly failed', 'bad'],
  failed: ['Failed', 'bad'],
  cancelled: ['Not relayed', ''],
};
function targetLabel(t: any) {
  switch (t.status) {
    case 'pending':
      return t.nextAttemptAt && t.nextAttemptAt > Date.now() ? `retry ${until(t.nextAttemptAt)}` : 'waiting';
    case 'preparing':
      return 'preparing';
    case 'uploading':
      return 'uploading';
    case 'processing':
      return 'processing';
    case 'done':
      return 'posted';
    case 'action':
      return t.platform === 'youtube' ? 'finish in Studio' : 'finish in app';
    case 'failed':
      return 'failed';
    default:
      return 'skipped';
  }
}

function jobRow(j: any, expanded: boolean, showLog = true) {
  const handsOn = j.status !== 'approval' && j.targets.some((t: any) => t.status === 'action');
  const [label, tone] = handsOn ? ['Your turn', 'warn'] : j.status === 'waiting' && j.notBefore > Date.now() ? [`Starting ${until(j.notBefore)}`, 'info'] : (JOB_STATUS[j.status] ?? [j.status, '']);
  const src = j.sourcePlatform as Platform | undefined;
  const reason = j.status === 'cancelled' ? j.log.at(-1)?.msg : '';
  const shot = okImg(j.thumbnail) ? `<img src="${esc(j.thumbnail)}" alt="">` : src ? pf(src, true) : I.video;
  const length = j.duration ? `<span class="tc">${dur(j.duration).replace(' s', 's')}</span>` : '';
  return `<div class="top" data-act="toggle" data-id="${j.id}">
      <div class="mon ${okImg(j.thumbnail) ? '' : (src ?? '')}">${shot}${length}</div>
      <div class="grow">
        <div class="row"><span class="title ellipsis grow">${esc(j.title || 'Untitled video')}</span><span class="pill ${tone}">${label}</span></div>
        <div class="meta"><span>${ago(j.createdAt)}</span>${reason ? `<span class="why">${esc(reason)}</span>` : ''}</div>
        <div class="route"><span class="src">${src ? `${pf(src, true)}${NAMES[src]}` : `${I.computer}This computer`}</span><span class="wire"></span>${j.targets
          .map(
            (t: any) =>
              `<span class="target ${j.status === 'cancelled' && t.status === 'pending' ? 'skipped' : t.status}"><i class="lamp"></i>${pf(t.platform, true)}${NAMES[t.platform as Platform]}<span class="st">${j.status === 'cancelled' && t.status === 'pending' ? 'not sent' : targetLabel(t)}</span>${t.resultUrl ? `<a href="${esc(t.resultUrl)}" target="_blank" title="Open on ${NAMES[t.platform as Platform]}">${I.ext.replace('<svg', '<svg width="13" height="13"')}</a>` : ''}</span>`,
          )
          .join('')}</div>
      </div>
    </div>
    ${expanded ? `<div class="more">${jobDetails(j, showLog)}</div>` : ''}`;
}

function jobDetails(j: any, showLog = true) {
  let h = '';
  if (j.status === 'approval') {
    h += `<div class="approve"><p>Check the captions, then relay. Nothing has been posted yet.</p>${j.targets
      .filter((t: any) => t.status !== 'skipped')
      .map(
        (t: any) => `<div class="ed">
          <div class="hd">${pf(t.platform, true)}<b>${NAMES[t.platform as Platform]}</b><label class="right">Post here <input type="checkbox" class="toggle" data-draft="skip:${j.id}:${t.platform}" ${draft(`skip:${j.id}:${t.platform}`, 'on') === 'on' ? 'checked' : ''}></label></div>
          ${t.platform === 'youtube' ? `<label class="field"><span>Title</span><input type="text" maxlength="100" data-draft="title:${j.id}:${t.platform}" value="${esc(draft(`title:${j.id}:${t.platform}`, t.title))}"></label>` : ''}
          <label class="field"><span>${t.platform === 'youtube' ? 'Description' : 'Caption'}</span><textarea data-draft="caption:${j.id}:${t.platform}">${esc(draft(`caption:${j.id}:${t.platform}`, t.caption))}</textarea></label>
        </div>`,
      )
      .join('')}
      <div class="acts"><button class="btn primary" data-act="approve" data-id="${j.id}">${I.check}Relay now</button><button class="btn ghost" data-act="cancel" data-id="${j.id}">Don't relay</button></div></div>`;
  }
  for (const t of j.targets.filter((x: any) => x.status === 'action')) {
    if (t.platform === 'youtube')
      h += `<div class="handoff">${pf('youtube')}<div class="grow"><p><b>Finish on YouTube.</b> The video is ready. Click below: Echoreel copies the title and description, shows the file, and opens YouTube's upload page. Drop the file in and paste.</p>
        <div class="row wrap"><button class="btn primary small" data-act="handoff" data-id="${j.id}" data-p="youtube">${I.ext}Upload to YouTube</button><button class="btn small" data-act="markDone" data-id="${j.id}" data-p="youtube">${I.check}I've posted it</button></div>
        <p class="small faint" style="margin:12px 0 0">To have Echoreel post to YouTube by itself, see Rules, then YouTube.</p></div></div>`;
    else
      h += `<div class="handoff">${pf('tiktok')}<div class="grow"><p><b>Finish on TikTok.</b> The video is in your TikTok inbox. Open TikTok on your phone, tap the notification, paste the caption and post. Echoreel notices once it's live.</p>
        <div class="row wrap"><button class="btn primary small" data-act="handoff" data-id="${j.id}" data-p="tiktok">${I.copy}Copy caption</button><button class="btn small" data-act="markDone" data-id="${j.id}" data-p="tiktok">${I.check}I've posted it</button></div></div></div>`;
  }
  const failed = j.targets.filter((t: any) => t.status === 'failed');
  for (const t of failed) h += `<div class="err">${NAMES[t.platform as Platform]}: ${esc(t.error)}</div>`;
  if (!showLog) return h + `<div class="acts"><button class="btn small ghost" data-act="toggle" data-id="${j.id}">Show what happened</button></div>`;
  h += `<ul class="log">${j.log
    .slice()
    .reverse()
    .map((l: any) => `<li class="${l.level ?? ''}"><time>${clock(l.t)}</time><span>${esc(l.msg)}</span></li>`)
    .join('')}</ul>`;
  const btns: string[] = [];
  if (failed.length) btns.push(`<button class="btn small" data-act="retry" data-id="${j.id}">${I.refresh}Try again</button>`);
  if (['waiting', 'partial', 'failed'].includes(j.status) && j.targets.some((t: any) => t.status === 'pending')) btns.push(`<button class="btn small ghost danger" data-act="cancel" data-id="${j.id}">Cancel</button>`);
  if (j.sourceUrl && j.sourcePlatform) btns.push(`<a class="btn small ghost" href="${esc(j.source.startsWith('youtube:') ? `https://www.youtube.com/watch?v=${j.source.slice(8)}` : j.sourceUrl)}" target="_blank">${I.ext}Open the original</a>`);
  if (btns.length) h += `<div class="acts">${btns.join('')}</div>`;
  return h;
}

const ITEM_STATUS: Record<string, [string, string]> = {
  baseline: ['Already there', ''],
  echo: ["Echoreel's copy", 'info'],
  duplicate: ['Duplicate', ''],
  skipped: ['Skipped', 'warn'],
  queued: ['Queued', 'info'],
  relayed: ['Relayed', 'good'],
  ignored: ['Not relayed', ''],
};
function seenTable() {
  const items = (V.items as any[]).filter((i) => i.platform);
  if (!items.length) return `<div class="card empty">${I.video}<p>Nothing yet. Every video Echoreel finds on your accounts shows up here.</p></div>`;
  return `<div class="card rundown"><table class="seen">${items
    .slice(0, 40)
    .map((i) => {
      const [label, tone] = ITEM_STATUS[i.status] ?? [i.status, ''];
      const canRelay = ['baseline', 'skipped', 'duplicate', 'ignored'].includes(i.status);
      return `<tr><td>${pf(i.platform, true)}</td><td><a href="${esc(i.url)}" target="_blank" class="t ellipsis">${esc(i.title || 'Untitled')}</a>${i.reason ? `<div class="small faint">${esc(i.reason)}</div>` : ''}</td>
        <td><span class="pill ${tone}">${label}</span></td><td class="when">${ago(i.createdAt)}</td>
        <td>${canRelay ? `<button class="btn small" data-act="relayItem" data-key="${esc(i.key)}">Relay anyway</button>` : ''}</td></tr>`;
    })
    .join('')}</table></div>`;
}

// ---------- post ----------
function postPage() {
  const sub = 'Pick a video on this computer and send it to every connected account at once.';
  if (!post.file)
    return `${head('Post a video', sub)}<div class="drop" data-act="choose" id="drop" role="button" tabindex="0"><div class="frame">${I.post}</div><h3>Drop a video here</h3><p>or click to choose a file. MP4, MOV or WebM.</p></div>
      <div class="note" style="margin-top:16px"><b>Tip:</b> vertical videos (9:16) up to 3 minutes work best everywhere. They become a YouTube Short, a Reel and a TikTok.</div>`;
  const i = post.info;
  const name = post.file.split(/[\\/]/).pop()!;
  const title = draft('post:title', name.replace(/\.[^.]+$/, ''));
  const caption = draft('post:caption', '');
  const vertical = i && i.height > i.width;
  return `${head('Post a video', sub)}
    <div class="postgrid">
      <div class="monitor">
        <div class="screen ${i && !vertical ? 'landscape' : ''}">${I.video}${i ? `<span class="tc">${dur(i.duration).replace(' s', 's')}</span>` : ''}</div>
        <dl class="specs">${
          i
            ? `<div><dt>Size</dt><dd>${i.width}×${i.height}</dd></div><div><dt>Length</dt><dd>${dur(i.duration)}</dd></div><div><dt>File</dt><dd>${mb(i.size)}</dd></div><div><dt>Shape</dt><dd>${vertical ? 'Vertical' : 'Landscape'}</dd></div>`
            : '<div><dt>Reading the file…</dt></div>'
        }</dl>
        <button class="btn small" data-act="clearPost">Choose another</button>
      </div>
      <div class="card">
        <span class="filename ellipsis">${esc(name)}</span>
        ${i && !vertical && V.settings.makeVertical ? `<div class="note">This video is landscape. For Instagram and TikTok, Echoreel fits it into a 9:16 frame over a blurred copy of itself (you can turn that off in Rules).</div>` : ''}
        <label class="field"><span>Title <span class="faint">for YouTube</span></span><input type="text" maxlength="100" data-draft="post:title" value="${esc(title)}"><div class="count">${title.length}/100</div></label>
        <label class="field" style="margin-top:6px"><span>Caption <span class="faint">for Instagram, TikTok and the YouTube description</span></span><textarea rows="5" data-draft="post:caption" placeholder="Say something… #hashtags work everywhere">${esc(caption)}</textarea><div class="count"><span class="${caption.length > 2200 ? 'over' : ''}">${caption.length}/2200</span></div></label>
        <span class="label">Post to</span>
        <div class="chips">${PLATFORMS.map((p) =>
          connected(p)
            ? `<label class="choice ${post.platforms.has(p) ? 'on' : ''}" data-act="postPlatform" data-p="${p}">${pf(p, true)}${NAMES[p]}</label>`
            : `<span class="choice disabled" title="Not connected">${pf(p, true)}${NAMES[p]} <a href="#" data-act="nav" data-page="connections" class="small">Connect</a></span>`,
        ).join('')}</div>
        ${post.platforms.has('youtube') && connected('youtube') && V.settings.youtubeMode === 'assisted' ? `<div class="note">YouTube: Echoreel prepares the upload and you finish it in YouTube Studio with one click.</div>` : ''}
        ${post.platforms.has('tiktok') && connected('tiktok') && V.settings.tiktokMode === 'inbox' ? `<div class="note">TikTok: the video lands in your TikTok inbox. Tap the notification in the app to post it.</div>` : ''}
        <div class="acts" style="margin-top:20px"><button class="btn primary" data-act="submitPost" ${post.busy || !i ? 'disabled' : ''}>${I.post}Post everywhere</button></div>
      </div>
    </div>`;
}

// ---------- connections ----------
const GUIDES: Record<Platform, () => string> = {
  youtube: () => `<ol>
    <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank">Google Cloud</a> and create a project (any name, e.g. <b>Echoreel</b>).</li>
    <li>Enable the <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank">YouTube Data API v3</a> for it.</li>
    <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank">Google Auth Platform</a>, click <b>Get started</b>, choose <b>External</b> and add your email.</li>
    <li>Under <b>Audience</b>, click <b>Publish app</b>. Unpublished apps sign you out every 7 days. Google shows an "unverified app" warning when you connect; that's expected for your own app (click <b>Advanced</b>, then <b>Go to …</b>).</li>
    <li>Under <b>Clients</b>, click <b>Create client</b> with type <b>Desktop app</b>. Copy the client ID and secret below.</li></ol>`,
  instagram: () => `<ol>
    <li>Make your Instagram a <b>Creator</b> or <b>Business</b> account (Instagram app, Settings, Account type and tools). It's free.</li>
    <li>On <a href="https://developers.facebook.com/apps/creation/" target="_blank">Meta for Developers</a>, create an app. For the use case, pick <b>Manage messaging &amp; content on Instagram</b>.</li>
    <li>In the app, open <b>Instagram</b>, then <b>API setup with Instagram login</b>. Under <b>Generate access tokens</b>, click <b>Add account</b> and sign in with your Instagram.</li>
    <li>If Instagram asks, accept the tester invite (instagram.com, Settings, Apps and websites, Tester invites), then click <b>Generate token</b>.</li>
    <li>Paste the token below. It lasts 60 days and Echoreel renews it automatically.</li></ol>`,
  tiktok: () => `<ol>
    <li>On <a href="https://developers.tiktok.com/apps/" target="_blank">TikTok for Developers</a>, sign in and <b>Connect an app</b>.</li>
    <li>Add the products <b>Login Kit</b> and <b>Content Posting API</b>. Turn on the scopes <b>user.info.basic</b>, <b>video.list</b> and <b>video.upload</b>.</li>
    <li>In Login Kit, choose platform <b>Desktop</b> and add this redirect URI:<div class="copyline"><code>${esc(V.app.redirects.tiktok)}</code><button class="btn small ghost" data-act="copy" data-text="${esc(V.app.redirects.tiktok)}" title="Copy">${I.copy}</button></div></li>
    <li>Switch to <b>Sandbox</b>, create one, and add your TikTok account under <b>Target users</b>. A sandbox works for your own account without TikTok's review.</li>
    <li>Copy the <b>Client key</b> and <b>Client secret</b> (from the sandbox) below.</li></ol>`,
};

function connections() {
  return `${head('Connections', 'Echoreel signs in with your own developer apps, so your accounts stay yours. Setup takes about 10 minutes per platform, once.')}
    <div class="grid3">${PLATFORMS.map(connCard).join('')}</div>
    <div class="note" style="margin-top:18px"><b>Privacy:</b> sign-ins are stored encrypted on this computer${V.app.encrypted ? ' (system keychain)' : ''}. Echoreel only talks to YouTube, Instagram and TikTok. There's no Echoreel server.</div>`;
}

function connCard(p: Platform) {
  const a = V.accounts[p];
  const busy = connecting === p;
  const err = errors[p] ? `<div class="err">${esc(errors[p])}</div>` : '';
  let body: string;
  if (a) {
    const warn = a.status === 'reconnect' ? `<div class="err"><b>Needs reconnecting.</b> ${esc(a.statusMessage ?? '')}</div>` : '';
    const checkErr = a.lastCheckError && a.status === 'ok' ? `<div class="err">Last check failed: ${esc(a.lastCheckError)}</div>` : '';
    const exp = a.tokenExpiresAt ? `<div class="small faint exp">Token renews automatically (valid until ${new Date(a.tokenExpiresAt).toLocaleDateString()})</div>` : '';
    body = `<div class="who">${okImg(a.avatar) ? `<img src="${esc(a.avatar)}" alt="">` : pf(p)}<div class="grow"><b class="ellipsis" style="display:block">${esc(a.name)}</b><div class="small muted">Checked ${ago(a.lastCheckAt)}</div></div></div>
      ${warn}${checkErr}${exp}${err}
      <div class="acts">
        ${a.status === 'reconnect' ? '' : `<button class="btn small" data-act="checkOne" data-p="${p}">${I.refresh}Check now</button>`}
        ${p !== 'instagram' ? `<button class="btn small ${a.status === 'reconnect' ? 'primary' : ''}" data-act="connect" data-p="${p}" ${busy ? 'disabled' : ''}>${busy ? 'Waiting for browser…' : 'Reconnect'}</button>` : ''}
        <button class="btn small ghost danger" data-act="disconnect" data-p="${p}">Disconnect</button></div>
      ${p === 'instagram' ? `<details class="guide" data-key="ig-token" style="margin-top:14px"><summary>Use a new token</summary><div style="padding:0 14px 14px"><input type="password" placeholder="IGAA…" data-draft="ig:token" value="${esc(draft('ig:token'))}"><button class="btn small" style="margin-top:10px" data-act="connect" data-p="instagram">Update token</button></div></details>` : ''}`;
  } else {
    const fields =
      p === 'youtube'
        ? `<label class="field"><span>Client ID</span><input type="text" placeholder="….apps.googleusercontent.com" data-draft="g:id" value="${esc(draft('g:id', V.credentials.google?.clientId ?? ''))}"></label>
           <label class="field"><span>Client secret</span><input type="password" placeholder="${V.credentials.google?.hasSecret ? 'saved, leave empty to keep' : 'GOCSPX-…'}" data-draft="g:secret" value="${esc(draft('g:secret'))}"></label>`
        : p === 'tiktok'
          ? `<label class="field"><span>Client key</span><input type="text" placeholder="sbaw…" data-draft="t:key" value="${esc(draft('t:key', V.credentials.tiktok?.clientKey ?? ''))}"></label>
             <label class="field"><span>Client secret</span><input type="password" placeholder="${V.credentials.tiktok?.hasSecret ? 'saved, leave empty to keep' : ''}" data-draft="t:secret" value="${esc(draft('t:secret'))}"></label>`
          : `<label class="field"><span>Access token</span><input type="password" placeholder="IGAA…" data-draft="ig:token" value="${esc(draft('ig:token'))}"></label>`;
    body = `<p>${
      p === 'youtube' ? 'Reads your new uploads and prepares (or posts) Shorts.' : p === 'instagram' ? 'Reads your new reels and posts reels. Needs a Creator or Business account.' : 'Reads your new videos and sends videos to your TikTok inbox.'
    }</p>
      <details class="guide" data-key="guide-${p}"><summary>How to set up (one time)</summary>${GUIDES[p]()}</details>
      ${fields}${err}
      <div class="acts" style="margin-top:18px"><button class="btn primary" data-act="connect" data-p="${p}" ${busy ? 'disabled' : ''}>${busy ? (p === 'instagram' ? 'Checking…' : 'Finish signing in in your browser…') : `Connect ${NAMES[p]}`}</button></div>`;
  }
  const status = a ? (a.status === 'ok' ? `<span class="pill good">Connected</span>` : `<span class="pill bad">Reconnect</span>`) : `<span class="pill">Not connected</span>`;
  return `<div class="card conn"><div class="hd">${pf(p)}<b>${NAMES[p]}</b><span class="right">${status}</span></div>${body}</div>`;
}

// ---------- rules ----------
function rules() {
  const s = V.settings;
  const sel = (key: string, opts: [string, string][]) => `<select data-set="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[key]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const tog = (key: string) => `<input type="checkbox" class="toggle" data-set="${key}" ${s[key] ? 'checked' : ''}>`;
  const radio = (key: string, v: string, t: string, d: string) => `<label class="${s[key] === v ? 'on' : ''}"><input type="radio" name="${key}" value="${v}" data-set="${key}" ${s[key] === v ? 'checked' : ''}><div class="t">${t}</div><div class="d">${d}</div></label>`;
  const readout = PLATFORMS.map((from) => {
    const to = PLATFORMS.filter((t) => t !== from && s.routes[from][t]).map((t) => NAMES[t]);
    return `<div>${pf(from, true)}<span>New ${NAMES[from]} videos ${to.length ? `go to <b>${list(to)}</b>.` : `<b>stay on ${NAMES[from]}</b>.`}</span></div>`;
  }).join('');
  return `${head('Rules', 'What gets relayed where, and how. Light a key to send videos from that row to that column.')}
    <div class="card xp"><table class="matrix">
      <tr><th class="corner" rowspan="2">When you post on</th><th class="span" colspan="3">also post to</th></tr>
      <tr>${PLATFORMS.map((p) => `<th><span class="dest">${pf(p, true)}${NAMES[p]}</span></th>`).join('')}</tr>
      ${PLATFORMS.map(
        (from) => `<tr><td class="src"><div class="row">${pf(from)}<div><b>${NAMES[from]}</b>${connected(from) ? '' : '<div class="small faint">not connected</div>'}</div></div></td>${PLATFORMS.map((to) =>
          from === to
            ? `<td><div class="blank" title="Same platform"></div></td>`
            : `<td><label class="xpt" title="${NAMES[from]} to ${NAMES[to]}"><input type="checkbox" data-route="${from}:${to}" ${s.routes[from][to] ? 'checked' : ''} aria-label="Post ${NAMES[from]} videos to ${NAMES[to]}"><span class="key">${s.routes[from][to] ? `${I.check}On` : 'Off'}</span></label></td>`,
        ).join('')}</tr>`,
      ).join('')}
    </table>
    <div class="readout">${readout}</div></div>

    ${sec('Before posting')}
    <div class="card">
      <div class="opt"><div class="grow"><div class="t">Ask me first</div><div class="d">New videos wait in Activity until you check the captions and click Relay.</div></div><input type="checkbox" class="toggle" data-set="approval" ${s.approval === 'ask' ? 'checked' : ''}></div>
      <div class="opt"><div class="grow"><div class="t">Wait before relaying</div><div class="d">Gives you time to fix a typo or delete a post before it's copied. YouTube also needs a few minutes to finish HD processing.</div></div><select data-set="holdMinutes">${[0, 2, 5, 10, 30, 60].map((m) => `<option value="${m}" ${s.holdMinutes === m ? 'selected' : ''}>${m ? `${m} min` : 'No wait'}</option>`).join('')}</select></div>
      <div class="opt"><div class="grow"><div class="t">Only relay YouTube Shorts</div><div class="d">Long or landscape YouTube videos stay on YouTube. Turn off to send everything up to 10 minutes.</div></div>${tog('youtubeShortsOnly')}</div>
      <div class="opt"><div class="grow"><div class="t">Fit landscape videos to 9:16</div><div class="d">For Instagram and TikTok, place a landscape video on a vertical frame over a blurred copy of itself.</div></div>${tog('makeVertical')}</div>
    </div>

    ${sec('YouTube')}
    <div class="card"><div class="t">How Echoreel posts to YouTube</div>
      <div class="radio">${radio('youtubeMode', 'assisted', 'Prepare, I finish (recommended)', 'Echoreel gets the video ready, copies the title and description, and opens YouTube. You drop it in. About 20 seconds.')}
      ${radio('youtubeMode', 'api', 'Post automatically', 'Only works after Google approves your project in the <a href="https://support.google.com/youtube/contact/yt_api_form" target="_blank">YouTube API audit</a>. Before that, YouTube locks API uploads to private.')}</div>
      <div class="opt"><div class="grow"><div class="t">Visibility for automatic posts</div></div>${sel('youtubePrivacy', [['public', 'Public'], ['unlisted', 'Unlisted'], ['private', 'Private']])}</div>
      <div class="opt"><div class="grow"><div class="t">Add #Shorts to titles</div><div class="d">Not required. YouTube makes vertical videos up to 3 minutes into Shorts by itself.</div></div>${tog('addShortsTag')}</div>
    </div>

    ${sec('TikTok')}
    <div class="card"><div class="t">How Echoreel posts to TikTok</div>
      <div class="radio">${radio('tiktokMode', 'inbox', 'Send to my TikTok inbox (recommended)', 'The video appears in TikTok as a draft notification. You tap it, add a sound if you like, and post. Works without TikTok’s audit.')}
      ${radio('tiktokMode', 'direct', 'Post directly', 'Needs TikTok to audit your app. Before that TikTok only allows private ("Only me") posts. Changing this needs a reconnect.')}</div>
      <div class="opt"><div class="grow"><div class="t">Visibility for direct posts</div></div>${sel('tiktokPrivacy', [['PUBLIC_TO_EVERYONE', 'Everyone'], ['FOLLOWER_OF_CREATOR', 'Followers'], ['MUTUAL_FOLLOW_FRIENDS', 'Friends'], ['SELF_ONLY', 'Only me']])}</div>
    </div>`;
}

// ---------- settings ----------
function updateRow() {
  const u = V.app.update ?? { status: 'idle' };
  const check = `<button class="btn small" data-act="updateCheck">${I.refresh}Check now</button>`;
  let d: string;
  let btn = '';
  switch (u.status) {
    case 'checking':
      d = 'Checking for updates…';
      break;
    case 'downloading':
      d = `Downloading Echoreel ${esc(u.version)}… ${u.total ? Math.floor((100 * (u.received ?? 0)) / u.total) : 0}%`;
      break;
    case 'ready':
      d = u.blocked ? esc(u.blocked) : `Echoreel ${esc(u.version)} is downloaded. It installs itself the next time Echoreel is in the background (window closed, nothing uploading), or restart now.`;
      if (u.error) d += `<div class="err">${esc(u.error)}</div>`;
      btn = u.blocked ? '' : `<button class="btn small primary" data-act="updateInstall">Restart now</button>`;
      break;
    case 'installing':
      d = `Installing Echoreel ${esc(u.version)}${V.progress ? ' once the current upload finishes' : ''}. It reopens by itself.`;
      break;
    case 'error':
      d = `<div class="err">${esc(u.error ?? 'The update check failed.')}</div>${u.retryAt ? `<div class="small faint" style="margin-top:6px">Echoreel tries again ${until(u.retryAt)}.</div>` : ''}`;
      btn = check;
      break;
    default:
      d = V.app.packaged ? `You’re on the latest version${u.checkedAt ? ` (checked ${ago(u.checkedAt)})` : ''}. New versions download and install by themselves.` : 'Updates are checked in the installed app.';
      btn = V.app.packaged ? check : '';
  }
  return `<div class="opt"><div class="grow"><div class="t">Updates</div><div class="d">${d}</div></div>${btn}</div>`;
}

function settings() {
  const s = V.settings;
  return `${head('Settings', `Echoreel ${esc(V.app.version)}`)}
    <div class="card">
      <div class="opt"><div class="grow"><div class="t">Check for new videos every</div><div class="d">Each check is one small request per account.</div></div><select data-set="pollMinutes">${[2, 5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${s.pollMinutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div>
      <div class="opt"><div class="grow"><div class="t">Start Echoreel when I log in</div><div class="d">It runs quietly in the ${V.app.platform === 'darwin' ? 'menu bar' : 'system tray'} so it never misses an upload.</div></div><input type="checkbox" class="toggle" data-set="openAtLogin" ${V.app.openAtLogin ? 'checked' : ''} ${V.app.packaged ? '' : 'disabled'}></div>
      <div class="opt"><div class="grow"><div class="t">Pause relaying</div><div class="d">Stop checking and posting until you turn this off.</div></div><input type="checkbox" class="toggle" data-set="paused" ${s.paused ? 'checked' : ''}></div>
      <div class="opt"><div class="grow"><div class="t">Browser for YouTube downloads</div><div class="d">Only if YouTube asks Echoreel to "confirm you're not a bot": it then borrows that browser's YouTube sign-in to download your video.</div></div><select data-set="cookiesFromBrowser">${[
        ['', 'None'],
        ['chrome', 'Chrome'],
        ['edge', 'Edge'],
        ['firefox', 'Firefox'],
        ['brave', 'Brave'],
        ['safari', 'Safari'],
      ]
        .map(([v, l]) => `<option value="${v}" ${s.cookiesFromBrowser === v ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></div>
      <div class="opt"><div class="grow"><div class="t">Keep downloaded videos for</div><div class="d">Copies Echoreel made while relaying. Deleted after this.</div></div><select data-set="keepDays">${[1, 3, 7, 14, 30].map((d) => `<option value="${d}" ${s.keepDays === d ? 'selected' : ''}>${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></div>
    </div>
    ${sec('Behind the scenes')}
    <div class="card">
      ${updateRow()}
      <div class="opt"><div class="grow"><div class="t">Data folder</div><div class="d mono ellipsis">${esc(V.app.dataDir)}</div></div><button class="btn small" data-act="openData">Open</button><button class="btn small ghost" data-act="openLog">Log</button></div>
      <div class="opt"><div class="grow"><div class="t">Video tools</div><div class="d mono">${tools ? `ffmpeg ${esc(tools.ffmpeg.replace(/^ffmpeg version /, '').split(' ')[0])}, yt-dlp ${esc(tools.ytdlp)}, cloudflared ${esc(tools.cloudflared.replace(/^cloudflared version /, '').split(' ')[0])}` : 'checking…'}</div></div><button class="btn small" data-act="updateYtdlp">Update yt-dlp</button></div>
      <div class="opt"><div class="grow"><div class="t">About</div><div class="d">Echoreel is free and open source (MIT). <a href="https://echoreel.vercel.app" target="_blank">Website</a>, <a href="https://github.com/tamoghnakabi-wq/echoreel" target="_blank">source code</a> and <a href="https://github.com/tamoghnakabi-wq/echoreel/releases" target="_blank">release notes</a>.</div></div></div>
    </div>`;
}

// ---------- events ----------
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !/^https:/.test(img.src) || badImg.has(img.src)) return;
    badImg.add(img.src);
    // Several images can fail together: re-render once, and never under the user's cursor.
    if (pendingImgRender) return;
    pendingImgRender = true;
    setTimeout(() => {
      pendingImgRender = false;
      if (typing()) pendingRender = true;
      else renderPage();
    }, 50);
  },
  true,
);

document.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const key = el.dataset.draft;
  if (!key) return;
  drafts[key] = el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value;
  // Live counters on the post page.
  if (key.startsWith('post:')) {
    const c = el.parentElement?.querySelector('.count');
    if (c) c.innerHTML = key === 'post:title' ? `${el.value.length}/100` : `<span class="${el.value.length > 2200 ? 'over' : ''}">${el.value.length}/2200</span>`;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement;
  // The control no longer matches what was drawn: redraw it from the saved state next time, so a
  // change that fails to save snaps back.
  drawn.delete($('#main'));
  if (el.dataset.draft && el.type === 'checkbox') drafts[el.dataset.draft] = el.checked ? 'on' : 'off';
  if (el.dataset.route) {
    const [from, to] = el.dataset.route.split(':');
    const routes = JSON.parse(JSON.stringify(V.settings.routes));
    routes[from][to] = el.checked;
    try {
      await api.setSettings({ routes });
    } catch (err) {
      toast(String((err as Error).message), true);
    }
    return refresh();
  }
  const key = el.dataset.set;
  if (!key) return;
  let value: any = el.type === 'checkbox' ? el.checked : el.value;
  if (key === 'approval') value = el.checked ? 'ask' : 'auto';
  if (['pollMinutes', 'holdMinutes', 'keepDays'].includes(key)) value = Number(value);
  try {
    await api.setSettings({ [key]: value });
    if (key === 'tiktokMode' && connected('tiktok')) toast('Reconnect TikTok (Connections) so it asks for the new permission.');
    else toast('Saved');
  } catch (err) {
    toast(String((err as Error).message), true);
  }
  refresh();
});

document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  if (el.tagName === 'A' && el.getAttribute('href') !== '#') return;
  e.preventDefault();
  const d = el.dataset;
  const act = d.act!;
  try {
    switch (act) {
      case 'nav':
        page = d.page!;
        document.querySelector('main')!.scrollTop = 0;
        renderSide();
        renderPage();
        break;
      case 'toggle':
        if ((e.target as HTMLElement).closest('a')) return;
        openJobs.has(d.id!) ? openJobs.delete(d.id!) : openJobs.add(d.id!);
        renderPage();
        break;
      case 'check':
        await api.check();
        toast('Checking your accounts…');
        break;
      case 'checkOne':
        toast(`Checking ${NAMES[d.p as Platform]}…`);
        await api.check(d.p);
        toast(`${NAMES[d.p as Platform]} checked`);
        break;
      case 'pause':
        await api.setSettings({ paused: d.on === '1' });
        break;
      case 'connect':
        await connect(d.p as Platform);
        break;
      case 'disconnect':
        if (confirm(`Disconnect ${NAMES[d.p as Platform]}? Echoreel stops watching and posting there.`)) await api.disconnect(d.p);
        break;
      case 'approve': {
        const j = V.jobs.find((x: any) => x.id === d.id);
        if (!j) break; // already handled elsewhere (the list redraws on its own)
        const edits = j.targets.map((t: any) => ({
          platform: t.platform,
          title: drafts[`title:${j.id}:${t.platform}`],
          caption: drafts[`caption:${j.id}:${t.platform}`],
          skip: drafts[`skip:${j.id}:${t.platform}`] === 'off',
        }));
        await api.approve(d.id, edits);
        toast(edits.every((x: any) => x.skip) ? 'Not relayed: every destination was switched off' : 'Relaying…');
        break;
      }
      case 'cancel':
        await api.cancel(d.id);
        break;
      case 'retry':
        await api.retry(d.id);
        toast('Trying again…');
        break;
      case 'markDone':
        await api.markDone(d.id, d.p);
        break;
      case 'handoff':
        await api.handoff(d.id, d.p);
        toast(d.p === 'youtube' ? 'Title and description copied. Drop the highlighted file into YouTube.' : 'Caption copied');
        break;
      case 'relayItem':
        await api.relayItem(d.key);
        toast('Relaying…');
        break;
      case 'copy':
        await api.copy(d.text);
        toast('Copied');
        break;
      case 'openData':
        await api.openData();
        break;
      case 'openLog':
        await api.openLog();
        break;
      case 'updateCheck': {
        const st = await api.updateCheck();
        if (st.status === 'idle') toast('Echoreel is up to date');
        else if (st.status === 'downloading') toast(`Downloading Echoreel ${st.version}…`);
        break;
      }
      case 'updateInstall': {
        toast('Installing the update…');
        const r = await api.updateInstall();
        if (r === 'failed') toast('The update didn’t install. See Settings.');
        break;
      }
      case 'updateYtdlp':
        toast('Updating yt-dlp…');
        await api.updateYtdlp();
        tools = await api.toolsInfo();
        toast('yt-dlp is up to date');
        break;
      case 'choose': {
        const f = await api.chooseVideo();
        if (f) await setPostFile(f);
        break;
      }
      case 'clearPost':
        post.file = null;
        post.info = null;
        renderPage();
        break;
      case 'postPlatform': {
        const p = d.p as Platform;
        post.platforms.has(p) ? post.platforms.delete(p) : post.platforms.add(p);
        renderPage();
        break;
      }
      case 'submitPost':
        await submitPost();
        break;
    }
  } catch (err) {
    toast(String((err as Error).message).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), true);
  }
  refresh();
});

async function connect(p: Platform) {
  errors[p] = '';
  if (p === 'youtube') {
    const id = draft('g:id', V.credentials.google?.clientId ?? '').trim();
    const secret = draft('g:secret').trim();
    if (!id) return void ((errors[p] = 'Paste your Google client ID first.'), renderPage());
    if (!secret && !V.credentials.google?.hasSecret) return void ((errors[p] = 'Paste your Google client secret first.'), renderPage());
    if (secret || id !== V.credentials.google?.clientId) await api.setCredentials({ google: { clientId: id, clientSecret: secret || undefined } });
  }
  if (p === 'tiktok') {
    const key = draft('t:key', V.credentials.tiktok?.clientKey ?? '').trim();
    const secret = draft('t:secret').trim();
    if (!key) return void ((errors[p] = 'Paste your TikTok client key first.'), renderPage());
    if (!secret && !V.credentials.tiktok?.hasSecret) return void ((errors[p] = 'Paste your TikTok client secret first.'), renderPage());
    if (secret || key !== V.credentials.tiktok?.clientKey) await api.setCredentials({ tiktok: { clientKey: key, clientSecret: secret || undefined } });
  }
  connecting = p;
  renderPage();
  try {
    const name = await api.connect(p, p === 'instagram' ? { token: draft('ig:token') } : undefined);
    delete drafts['ig:token'];
    delete drafts['g:secret'];
    delete drafts['t:secret'];
    toast(`Connected ${NAMES[p]} as ${name}`);
  } catch (err) {
    errors[p] = String((err as Error).message).replace(/^Error invoking remote method '\w+': (Error: )?/, '');
  } finally {
    connecting = null;
  }
}

async function setPostFile(f: string) {
  post.file = f;
  post.info = null;
  renderPage();
  try {
    post.info = await api.probeFile(f);
  } catch (err) {
    post.file = null;
    toast(`That file can't be read as a video: ${(err as Error).message}`, true);
  }
  renderPage();
}

async function submitPost() {
  const platforms = [...post.platforms].filter(connected);
  if (!platforms.length) return toast('Pick at least one connected platform', true);
  const name = post.file!.split(/[\\/]/).pop()!;
  post.busy = true;
  try {
    await api.post({ file: post.file, title: draft('post:title', name.replace(/\.[^.]+$/, '')).trim() || 'New video', caption: draft('post:caption', '').trim(), platforms });
    post.file = null;
    post.info = null;
    delete drafts['post:title'];
    delete drafts['post:caption'];
    page = 'activity';
    toast('Posting…');
  } finally {
    post.busy = false;
  }
}

// Keyboard: Enter or Space on a focusable non-button control (the drop zone) acts like a click.
document.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if ((e.key === 'Enter' || e.key === ' ') && el.dataset?.act && el.getAttribute('role') === 'button') {
    e.preventDefault();
    el.click();
  }
});

// Drag and drop a video anywhere on the Post page.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#drop')?.classList.add('over');
});
document.addEventListener('dragleave', () => $('#drop')?.classList.remove('over'));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (page !== 'post') {
    page = 'post';
    $('#main').scrollTop = 0;
  }
  await setPostFile(api.pathFor(f));
  renderSide();
});

// ---------- start ----------
if (navigator.userAgent.includes('Mac')) document.body.classList.add('mac');
api.onChanged(() => refresh());
api.onNavigate(async (nav) => {
  // From a notification or the menu bar: open the page at the top, or at the job it's about.
  if (page !== nav.page) $('#main').scrollTop = 0;
  page = nav.page;
  if (nav.jobId) openJobs.add(nav.jobId);
  await refresh();
  if (nav.jobId) $(`[data-job="${CSS.escape(nav.jobId)}"]`)?.scrollIntoView({ block: 'start' });
});
setInterval(() => !typing() && refresh(), 30_000); // keep "x min ago" fresh
refresh();
export {};
