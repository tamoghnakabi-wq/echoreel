import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Engine } from '../core/engine';
import { prepare, probe } from '../core/media';
import { DEFAULT_SETTINGS, mockHosts, PLATFORM_NAMES, PLATFORMS, REAL_HOSTS, type Host, type Platform, type Settings, type Tools } from '../core/types';
import { GOOGLE_REDIRECT, TIKTOK_REDIRECT } from '../core/oauth';
import { run } from '../core/util';
import { installBlocked, Updater } from './updater';

declare const __VERSION__: string;
const isWin = process.platform === 'win32';
const exe = (n: string) => n + (isWin ? '.exe' : '');
const args = process.argv.slice(1);
const SELFTEST = args.includes('--selftest');
let HIDDEN = args.includes('--hidden');

if (process.env.ECHOREEL_DATA_DIR) app.setPath('userData', resolve(process.env.ECHOREEL_DATA_DIR));
app.setName('Echoreel');
if (isWin) app.setAppUserModelId('app.echoreel.desktop');

const dataDir = () => app.getPath('userData');
const logFile = () => join(dataDir(), 'echoreel.log');
function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (!SELFTEST) process.stdout.write(line);
  try {
    const f = logFile();
    if (existsSync(f) && statSync(f).size > 5e6) renameSync(f, f + '.old');
    appendFileSync(f, line);
  } catch {
    /* logging must never break the app */
  }
}

// ---------- tools ----------

/** Where the bundled command-line tools live (or, in development, the copies on PATH). */
function toolPath(name: string): string {
  const bundled = app.isPackaged ? join(process.resourcesPath, 'bin', exe(name)) : join(app.getAppPath(), 'tools', `${process.platform}-${process.arch}`, exe(name));
  if (existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH ?? '').split(isWin ? ';' : ':').concat(isWin ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])) {
    const p = join(dir, exe(name));
    if (dir && existsSync(p)) return p;
  }
  return bundled; // reported as missing by the self-test / UI
}

/**
 * yt-dlp needs updating often (YouTube changes), so it runs from a copy in the data folder
 * that `yt-dlp -U` can replace; the copy shipped in the app is the starting point.
 */
function ytdlpPath(): string {
  const shipped = toolPath('yt-dlp');
  if (!app.isPackaged || !existsSync(shipped)) return shipped;
  const dir = join(dataDir(), 'bin');
  const own = join(dir, exe('yt-dlp'));
  try {
    mkdirSync(dir, { recursive: true });
    // Read and write rather than copyFile, so macOS's download quarantine flag isn't copied along.
    if (!existsSync(own) || statSync(own).mtimeMs < statSync(shipped).mtimeMs) {
      writeFileSync(own, readFileSync(shipped));
      chmodSync(own, 0o755);
    }
    return own;
  } catch {
    return shipped;
  }
}

/**
 * A copy of Echoreel downloaded from the web is quarantined by macOS, and so is every file inside
 * it. The user approves the app itself on first open; its own bundled tools (ffmpeg, yt-dlp,
 * cloudflared) are part of that same app, so the flag is cleared on them once here.
 */
function clearToolQuarantine() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    execFileSync('/usr/bin/xattr', ['-d', '-r', 'com.apple.quarantine', join(process.resourcesPath, 'bin')], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    /* not quarantined (xattr exits 1), or a read-only copy: the tools still run in most cases */
  }
}

function makeTools(): Tools {
  return {
    ffmpeg: toolPath('ffmpeg'),
    ffprobe: toolPath('ffprobe'),
    ytdlp: ytdlpPath(),
    cloudflared: toolPath('cloudflared'),
    // YouTube downloads need a JavaScript runtime: Echoreel's own Electron, run as Node.
    ytdlpArgs: ['--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`],
    ytdlpEnv: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

async function updateYtdlp(tools: Tools) {
  if (!app.isPackaged || !tools.ytdlp.startsWith(dataDir())) return;
  const r = await run(tools.ytdlp, ['-U'], { timeoutMs: 120_000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }));
  log(`yt-dlp update: ${(r.stdout + r.stderr).trim().split('\n').pop()}`);
}

// ---------- secrets ----------

function makeHost(): Host {
  const canEncrypt = () => safeStorage.isEncryptionAvailable();
  return {
    dataDir: dataDir(),
    encrypt: (plain) => (canEncrypt() ? 'v1:' + safeStorage.encryptString(plain).toString('base64') : 'b64:' + Buffer.from(plain).toString('base64')),
    decrypt: (blob) => {
      if (blob.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(blob.slice(3), 'base64'));
      if (blob.startsWith('b64:')) return Buffer.from(blob.slice(4), 'base64').toString();
      throw new Error('unknown secret format');
    },
    notify: (title, body, jobId) => {
      if (!Notification.isSupported() || process.env.ECHOREEL_NO_NOTIFY) return;
      const n = new Notification({ title, body, silent: false });
      n.on('click', () => showWindow(jobId ? { page: 'activity', jobId } : undefined));
      n.show();
    },
    openExternal: (url) => void shell.openExternal(url),
    log,
  };
}

// ---------- self-test (CI and support) ----------

async function selftest(): Promise<number> {
  const out: string[] = [];
  let ok = true;
  const check = async (name: string, fn: () => Promise<string> | string) => {
    try {
      out.push(`ok   ${name}: ${await fn()}`);
    } catch (e) {
      ok = false;
      out.push(`FAIL ${name}: ${(e as Error).message}`);
    }
  };
  const tools = makeTools();
  await check('version', () => `${__VERSION__} on Electron ${process.versions.electron} (${process.platform}-${process.arch})`);
  for (const [name, p, a] of [
    ['ffmpeg', tools.ffmpeg, ['-version']],
    ['ffprobe', tools.ffprobe, ['-version']],
    ['yt-dlp', tools.ytdlp, ['--version']],
    ['cloudflared', tools.cloudflared, ['--version']],
  ] as const)
    await check(name, async () => {
      if (!existsSync(p)) throw new Error(`missing at ${p}`);
      const r = await run(p, [...a], { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr.slice(0, 200)}`);
      return (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80);
    });
  await check('js runtime for yt-dlp', async () => {
    const r = await run(process.execPath, ['--version'], { env: { ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 30_000 });
    if (!/^v\d+\./.test(r.stdout.trim())) throw new Error(`Electron did not run as Node: ${r.stdout} ${r.stderr}`);
    return `node ${r.stdout.trim()}`;
  });
  await check('video pipeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echoreel-selftest-'));
    const src = join(dir, 'in.mp4');
    const r = await run(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 200));
    const p = await probe(tools, src);
    const outFile = await prepare(tools, src, p, 'instagram', { ...DEFAULT_SETTINGS }, dir);
    const q = await probe(tools, outFile);
    if (q.width !== 1080 || q.height !== 1920 || q.vcodec !== 'h264' || q.acodec !== 'aac') throw new Error(`unexpected output ${q.width}x${q.height} ${q.vcodec}/${q.acodec}`);
    return `1280x720 → ${q.width}x${q.height} ${q.vcodec}/${q.acodec}`;
  });
  await check('engine', () => {
    const e = new Engine({ ...makeHost(), dataDir: mkdtempSync(join(tmpdir(), 'echoreel-data-')), encrypt: (s) => 'b64:' + Buffer.from(s).toString('base64') }, tools, REAL_HOSTS);
    const v = e.view();
    e.stop();
    return `${Object.keys(v.accounts).length} platforms, ${v.jobs.length} jobs`;
  });
  // Downloads the newest published release through the updater's own code path (CI).
  if (args.includes('--update'))
    await check('update download', () => new Updater({ dataDir, log: () => {}, onChange: () => {}, drain: async () => true, resume: () => {}, quit: () => {} }).selfTestDownload());
  process.stdout.write(out.join('\n') + `\n${ok ? 'SELFTEST PASSED' : 'SELFTEST FAILED'}\n`);
  return ok ? 0 : 1;
}

// ---------- window, tray ----------

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: Engine;
let quitting = false;
let updater: Updater;

function iconPath(name: string) {
  return app.isPackaged ? join(process.resourcesPath, 'icons', name) : join(app.getAppPath(), 'build', name);
}

function showWindow(nav?: { page: string; jobId?: string }) {
  if (!win || win.isDestroyed()) createWindow();
  if (process.platform === 'darwin') app.dock?.show();
  win!.show();
  win!.focus();
  if (nav) win!.webContents.send('navigate', nav);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'Echoreel',
    backgroundColor: '#1b1f1d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    icon: iconPath('icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!HIDDEN) win?.show();
  });
  // Links open in the browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting) return;
    // Keep watching in the background.
    e.preventDefault();
    win?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
    if (!engine.store.state.settings.paused && !(globalThis as any).__toldAboutTray) {
      (globalThis as any).__toldAboutTray = true;
      makeHost().notify('Echoreel is still watching', `It keeps running in the ${process.platform === 'darwin' ? 'menu bar' : 'system tray'}. Quit it from there.`);
    }
  });
}

let refreshTray = () => {};

function buildTray() {
  const img = nativeImage.createFromPath(iconPath(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Echoreel');
  const refresh = () => {
    const s = engine.store.state.settings;
    const accounts = PLATFORMS.filter((p) => engine.store.state.accounts[p]).map((p) => PLATFORM_NAMES[p]);
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Echoreel', click: () => showWindow() },
        ...updateItems(),
        { type: 'separator' },
        { label: accounts.length ? `Watching ${accounts.join(', ')}` : 'No accounts connected', enabled: false },
        { label: 'Check for new videos now', enabled: accounts.length > 0 && !s.paused, click: () => checkAll() },
        { label: s.paused ? 'Resume relaying' : 'Pause relaying', click: () => setSettings({ paused: !s.paused }) },
        { type: 'separator' },
        { label: 'Quit Echoreel', click: () => app.quit() },
      ]),
    );
  };
  refresh();
  refreshTray = refresh;
  engine.store.onChange(throttle(refresh, 2000));
  if (process.platform !== 'darwin') tray.on('click', () => showWindow());
}

function throttle(fn: () => void, ms: number) {
  let t: NodeJS.Timeout | null = null;
  return () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}

function checkAll() {
  for (const p of PLATFORMS) if (engine.store.state.accounts[p]) engine.check(p).catch(() => {});
  setTimeout(() => void engine.work(), 3000);
}

function setSettings(patch: Partial<Settings> & { openAtLogin?: boolean }) {
  const s = engine.store.state.settings;
  const { openAtLogin, ...rest } = patch;
  Object.assign(s, rest);
  if (rest.routes) s.routes = { ...DEFAULT_SETTINGS.routes, ...rest.routes };
  s.pollMinutes = Math.min(120, Math.max(1, Number(s.pollMinutes) || 5));
  s.holdMinutes = Math.min(240, Math.max(0, Number(s.holdMinutes) || 0));
  s.keepDays = Math.min(90, Math.max(1, Number(s.keepDays) || 7));
  if (openAtLogin !== undefined) setLoginItem(openAtLogin);
  engine.store.changed();
  if (!s.paused) void engine.work();
}

// Windows starts the app at login with --hidden. macOS can't pass arguments to a login item, so
// there the app asks how it was opened instead (see startup).
const LOGIN_ARGS = isWin ? { args: ['--hidden'] } : {};
function setLoginItem(on: boolean) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: on, ...LOGIN_ARGS });
}

// ---------- menu bar ----------

const SITE = 'https://echoreel.vercel.app';
const REPO = 'https://github.com/tamoghnakabi-wq/echoreel';
type Item = Electron.MenuItemConstructorOptions;

/** A message box on the window when it's showing (a sheet on macOS), otherwise on its own in front. */
function messageBox(o: Partial<Electron.MessageBoxOptions> & { message: string }) {
  const opts: Electron.MessageBoxOptions = { type: 'info', buttons: ['OK'], ...o };
  if (win && !win.isDestroyed() && win.isVisible()) return dialog.showMessageBox(win, opts);
  app.focus({ steal: true });
  return dialog.showMessageBox(opts);
}

/** "Check for Updates…", or what the updater is busy with instead. Shared by the menu bar and the tray. */
function updateItems(): Item[] {
  const u = updater.state;
  const v = u.version ?? '';
  switch (u.status) {
    case 'checking':
      return [{ label: 'Checking for Updates…', enabled: false }];
    case 'downloading': {
      // In steps of 10% so the menu isn't rebuilt for every chunk.
      const pct = u.total ? Math.floor((10 * (u.received ?? 0)) / u.total) * 10 : 0;
      return [{ label: `Downloading Echoreel ${v}… ${pct}%`, enabled: false }];
    }
    case 'installing':
      return [{ label: `Installing Echoreel ${v}…`, enabled: false }];
    case 'ready':
      return [{ label: `Restart to Update to ${v}`, click: () => void restartToUpdate() }];
    default:
      return [{ label: 'Check for Updates…', click: () => void checkForUpdates() }];
  }
}

// Set by a check from the menu that started a download: ask about restarting once it's in.
let askWhenReady = false;

async function checkForUpdates() {
  const st = await updater.check();
  if (st.status === 'idle') {
    await messageBox({ message: 'You’re up to date', detail: `Echoreel ${__VERSION__} is the newest version.` });
  } else if (st.status === 'error') {
    await messageBox({ type: 'warning', message: 'Echoreel couldn’t check for updates', detail: `${st.error ?? 'The update check failed.'}\n\nIt tries again by itself later.` });
  } else if (st.status === 'downloading') {
    askWhenReady = true;
  } else if (st.status === 'ready') {
    await offerRestart();
  }
}

/** Called on every updater change: finish what a menu check started. */
function followUpCheck() {
  if (!askWhenReady) return;
  const st = updater.state;
  if (st.status === 'ready') {
    askWhenReady = false;
    announced = st.version ?? ''; // this box says it; no notification as well
    void offerRestart();
  } else if (st.status === 'error') {
    askWhenReady = false;
    void messageBox({ type: 'warning', message: `Echoreel ${st.version ?? ''} didn’t download`, detail: `${st.error ?? ''}\n\nIt tries again by itself later.` });
  }
}

async function offerRestart() {
  const v = updater.readyVersion;
  if (!v) return;
  const blocked = installBlocked();
  if (blocked) {
    await messageBox({ message: `Echoreel ${v} is downloaded`, detail: blocked });
    return;
  }
  const { response } = await messageBox({
    message: `Echoreel ${v} is ready to install`,
    detail: `You have ${__VERSION__}. Restart now to update, or Echoreel installs it by itself the next time its window is closed and nothing is uploading.`,
    buttons: ['Restart to Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await restartToUpdate();
}

async function restartToUpdate() {
  const blocked = installBlocked();
  if (blocked) {
    await messageBox({ message: `Echoreel ${updater.readyVersion ?? ''} can’t install itself`, detail: blocked });
    return;
  }
  if ((await updater.install(true)) === 'failed') {
    await messageBox({ type: 'warning', message: 'The update didn’t install', detail: updater.state.error ?? 'See Settings for details.' });
  }
}

let lastMenu = '';
/** The menu bar: rebuilt only when something it shows has changed. */
function refreshAppMenu() {
  const mac = process.platform === 'darwin';
  const s = engine.store.state.settings;
  const accounts = PLATFORMS.filter((p) => engine.store.state.accounts[p]).map((p) => PLATFORM_NAMES[p]);
  const open = (page: string) => () => showWindow({ page });
  const settings: Item = { label: mac ? 'Settings…' : 'Settings', accelerator: 'CmdOrCtrl+,', click: open('settings') };
  const sep: Item = { type: 'separator' };
  const template: Item[] = [
    ...(mac
      ? [
          {
            label: 'Echoreel',
            submenu: [
              { role: 'about', label: 'About Echoreel' },
              ...updateItems(),
              sep,
              settings,
              sep,
              { role: 'services' },
              sep,
              { role: 'hide', label: 'Hide Echoreel' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              sep,
              { role: 'quit', label: 'Quit Echoreel' },
            ],
          } as Item,
        ]
      : []),
    {
      label: mac ? 'File' : '&File',
      submenu: [
        { label: 'Post a Video…', accelerator: 'CmdOrCtrl+N', click: open('post') },
        sep,
        ...(mac ? [{ role: 'close' } as Item] : [settings, sep, { label: 'Quit Echoreel', accelerator: 'Ctrl+Q', click: () => app.quit() } as Item]),
      ],
    },
    { role: 'editMenu' },
    {
      label: mac ? 'View' : '&View',
      submenu: [
        { label: 'Activity', accelerator: 'CmdOrCtrl+1', click: open('activity') },
        { label: 'Post a Video', accelerator: 'CmdOrCtrl+2', click: open('post') },
        { label: 'Connections', accelerator: 'CmdOrCtrl+3', click: open('connections') },
        { label: 'Rules', accelerator: 'CmdOrCtrl+4', click: open('rules') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+5', click: open('settings') },
        sep,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        sep,
        { role: 'togglefullscreen' },
        // Developer tools stay out of the installed app.
        ...(app.isPackaged ? [] : [sep, { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' } as Item, { role: 'toggleDevTools' } as Item]),
      ],
    },
    {
      label: mac ? 'Relay' : '&Relay',
      submenu: [
        { label: accounts.length ? `Watching ${accounts.join(', ')}` : 'No accounts connected', enabled: false },
        sep,
        { label: 'Check for New Videos Now', accelerator: 'CmdOrCtrl+R', enabled: accounts.length > 0 && !s.paused, click: () => checkAll() },
        { label: s.paused ? 'Resume Relaying' : 'Pause Relaying', accelerator: 'CmdOrCtrl+Shift+P', click: () => setSettings({ paused: !s.paused }) },
        sep,
        { label: 'Connections…', click: open('connections') },
        { label: 'Rules…', click: open('rules') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      label: mac ? 'Help' : '&Help',
      submenu: [
        { label: 'Echoreel Website', click: () => void shell.openExternal(SITE) },
        { label: 'Release Notes', click: () => void shell.openExternal(`${REPO}/releases`) },
        { label: 'Report an Issue…', click: () => void shell.openExternal(`${REPO}/issues/new`) },
        sep,
        { label: 'Show Log File', click: () => void shell.openPath(logFile()) },
        // Windows has no app menu: updates and About go at the end of Help.
        ...(mac ? [] : [sep, ...updateItems(), { role: 'about', label: 'About Echoreel' } as Item]),
      ],
    },
  ];
  const sig = JSON.stringify(template);
  if (sig === lastMenu) return;
  lastMenu = sig;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildAppMenu() {
  app.setAboutPanelOptions({
    applicationName: 'Echoreel',
    applicationVersion: __VERSION__,
    version: '',
    copyright: 'Free and open source under the MIT License.',
    website: SITE,
    iconPath: iconPath('icon.png'),
  });
  refreshAppMenu();
  engine.store.onChange(throttle(refreshAppMenu, 500));
}

// ---------- IPC ----------

function inside(dir: string, p: string) {
  const r = resolve(p);
  return r === dir || r.startsWith(dir + sep);
}

function registerIpc() {
  const handle = (name: string, fn: (...a: any[]) => any) =>
    ipcMain.handle(name, async (e, ...a) => {
      if (e.senderFrame?.url && !e.senderFrame.url.startsWith('file://')) throw new Error('blocked');
      return fn(...a);
    });
  handle('view', () => ({
    ...engine.view(),
    app: {
      version: __VERSION__,
      update: updater.state,
      platform: process.platform,
      dataDir: dataDir(),
      openAtLogin: app.isPackaged ? app.getLoginItemSettings(LOGIN_ARGS).openAtLogin : false,
      packaged: app.isPackaged,
      redirects: { google: GOOGLE_REDIRECT, tiktok: TIKTOK_REDIRECT },
      encrypted: safeStorage.isEncryptionAvailable(),
    },
  }));
  handle('connect', async (p: Platform, input?: { token?: string }) => {
    const a = await engine.connect(p, input);
    showWindow();
    return a.name;
  });
  handle('disconnect', (p: Platform) => engine.disconnect(p));
  handle('setCredentials', (c) => engine.setCredentials(c));
  handle('setSettings', (patch) => setSettings(patch));
  handle('check', async (p?: Platform) => {
    if (p) await engine.check(p);
    else checkAll();
    void engine.work();
  });
  handle('post', async (req) => (await engine.post(req)).id);
  handle('approve', (id: string, edits) => engine.approve(id, edits));
  handle('cancel', (id: string) => engine.cancel(id));
  handle('retry', (id: string) => engine.retry(id));
  handle('markDone', (id: string, p: Platform) => engine.markDone(id, p));
  handle('relayItem', (key: string) => engine.relayItem(key).id);
  handle('copy', (text: string) => clipboard.writeText(String(text)));
  handle('openUrl', (url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
  handle('reveal', (p: string) => {
    if (inside(dataDir(), p) && existsSync(p)) shell.showItemInFolder(p);
  });
  handle('openData', () => shell.openPath(dataDir()));
  handle('openLog', () => shell.openPath(logFile()));
  handle('chooseVideo', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a video', properties: ['openFile'], filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('probeFile', async (file: string) => {
    const p = await probe(engine.tools, file);
    return { duration: p.duration, width: p.width, height: p.height, size: p.size };
  });
  /** Hand-off for YouTube Studio / TikTok inbox: copy the text, show the file, open the site. */
  handle('handoff', (jobId: string, p: Platform) => {
    const job = engine.job(jobId);
    const t = job.targets.find((x) => x.platform === p);
    if (!t) return;
    if (p === 'youtube') {
      clipboard.writeText(`${t.title}\n\n${t.caption}`);
      if (t.file && inside(dataDir(), t.file)) shell.showItemInFolder(t.file);
      void shell.openExternal('https://www.youtube.com/upload');
    } else clipboard.writeText(t.caption);
  });
  handle('toolsInfo', async () => {
    const t = engine.tools;
    const ver = async (p: string, a: string[]) => {
      if (!existsSync(p)) return 'missing';
      const r = await run(p, a, { timeoutMs: 20_000 }).catch(() => null);
      return r ? (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 60) : 'error';
    };
    return { ffmpeg: await ver(t.ffmpeg, ['-version']), ytdlp: await ver(t.ytdlp, ['--version']), cloudflared: await ver(t.cloudflared, ['--version']) };
  });
  handle('updateYtdlp', () => updateYtdlp(engine.tools));
  handle('updateCheck', () => updater.check());
  handle('updateInstall', () => updater.install(true));
}

/** Development only: capture each page to PNG files, then quit. */
async function screenshots(dir: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  mkdirSync(dir, { recursive: true });
  const [w, h] = (process.env.ECHOREEL_SHOT_SIZE ?? '1240x860').split('x').map(Number);
  win!.setSize(w, h);
  win!.showInactive();
  win!.webContents.on('console-message', (e) => log(`renderer ${e.level}: ${e.message}`));
  // The window stays behind other apps: keep it painting at full speed so captures are current.
  win!.webContents.setBackgroundThrottling(false);
  await wait(2500);
  for (const spec of (process.env.ECHOREEL_SHOT_PAGES ?? 'activity,post,connections,rules,settings').split(',')) {
    // "page@jobId" opens a job; "page~600" scrolls the page down 600 px; "page+key" opens the
    // section <details data-key="key"> as a click would.
    const [nav, open] = spec.split('+');
    const [target, scroll] = nav.split('~');
    const [page, jobId] = target.split('@');
    win!.webContents.send('navigate', { page, jobId });
    await wait(1200);
    if (open) {
      await win!.webContents.executeJavaScript(`document.querySelector('details[data-key=${JSON.stringify(open)}]').open = true`);
      await wait(300);
    }
    if (scroll) {
      await win!.webContents.executeJavaScript(`document.querySelector('main').scrollTop = ${Number(scroll)}`);
      await wait(300);
    }
    // A window in the background can hand back its last frame: ask for a fresh one first.
    win!.webContents.invalidate();
    await wait(300);
    const opened = await win!.webContents.executeJavaScript(`[...document.querySelectorAll('details[open]')].map((d) => d.dataset.key).join(',') || 'none'`);
    log(`shot ${spec}: open sections ${opened}`);
    writeFileSync(join(dir, `${spec.replace(/[@~+]/g, '-')}.png`), (await win!.webContents.capturePage()).toPNG());
  }
  // The menu bar as text, since a capture of the window doesn't include it.
  const outline = (m: Electron.Menu, depth: number): string[] =>
    m.items.flatMap((i) => [
      '  '.repeat(depth) + (i.type === 'separator' ? '---' : `${i.label || i.role}${i.accelerator ? `  [${i.accelerator}]` : ''}${i.enabled ? '' : '  (disabled)'}`),
      ...(i.submenu ? outline(i.submenu, depth + 1) : []),
    ]);
  writeFileSync(join(dir, 'menu.txt'), outline(Menu.getApplicationMenu()!, 0).join('\n') + '\n');
  quitting = true;
  app.exit(0);
}

// ---------- updates ----------

let announced = '';
/** Say once per version that an update is ready (and how it gets installed). */
function announceUpdate() {
  const v = updater.readyVersion;
  if (!v || announced === v || updater.state.status !== 'ready') return;
  announced = v;
  const blocked = installBlocked();
  makeHost().notify(
    `Echoreel ${v} is ready`,
    blocked ?? 'It installs itself the next time Echoreel is in the background, or restart now from Settings.',
  );
}

/**
 * Check at start and every 4 hours. A downloaded update installs itself as soon as Echoreel is in
 * the background (window closed) and isn't posting anything, so users always end up current
 * without doing anything; from the window they can restart right away.
 */
function scheduleUpdates() {
  if (!app.isPackaged && !process.env.ECHOREEL_UPDATE_URL) return;
  setTimeout(() => void updater.check(), 20_000);
  setInterval(() => void updater.check(), 4 * 3600_000);
  setInterval(() => {
    if (!updater.readyVersion || updater.state.status !== 'ready' || installBlocked()) return;
    if (win && !win.isDestroyed() && win.isVisible()) return;
    if (engine.working) return;
    log(`update: installing ${updater.readyVersion} in the background`);
    void updater.install(false, 0);
  }, 60_000);
}

// ---------- startup ----------

async function main() {
  clearToolQuarantine();
  if (SELFTEST) {
    await app.whenReady();
    const code = await selftest();
    app.exit(code);
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => showWindow());
  await app.whenReady();
  if (process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin) HIDDEN = true;
  log(`Echoreel ${__VERSION__} starting (data in ${dataDir()})${HIDDEN ? ', in the background' : ''}`);
  updater = new Updater({
    dataDir,
    log,
    onChange: () => {
      if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('changed');
      refreshTray();
      if (engine) refreshAppMenu(); // (not before startup has made it)
      followUpCheck();
      announceUpdate();
    },
    drain: (ms) => engine.drain(ms),
    resume: () => engine.resume(),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  const after = updater.startup();
  if (after.installerRunning) {
    // An update from the last run is still installing; it opens the new version when done.
    app.exit(0);
    return;
  }
  if (after.showAfterUpdate !== undefined) HIDDEN = !after.showAfterUpdate;
  // Development screenshots of the update UI (never in the packaged app).
  if (!app.isPackaged && process.env.ECHOREEL_FAKE_UPDATE) updater.state = JSON.parse(process.env.ECHOREEL_FAKE_UPDATE);
  const hosts = process.env.ECHOREEL_MOCK ? mockHosts(process.env.ECHOREEL_MOCK) : REAL_HOSTS;
  engine = new Engine(makeHost(), makeTools(), hosts, process.env.ECHOREEL_MOCK ? { tunnelBase: 'http://127.0.0.1:{port}' } : {});
  registerIpc();
  // Push state to the window whenever it changes (at most ~5 times a second).
  engine.store.onChange(
    throttle(() => {
      if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('changed');
    }, 200),
  );
  if (process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath('icon.png')));
    if (HIDDEN) app.dock?.hide();
  }
  createWindow();
  buildTray();
  buildAppMenu();
  // First launch of an installed copy: start at login by default.
  // (A copy with its own data folder, for tests or portable use, never adds itself.)
  if (app.isPackaged && !process.env.ECHOREEL_DATA_DIR && !engine.store.state.flags.loginItemSet) {
    setLoginItem(true);
    engine.store.state.flags.loginItemSet = true;
    engine.store.changed();
  }
  engine.start();
  if (process.env.ECHOREEL_SHOTS && !app.isPackaged) void screenshots(process.env.ECHOREEL_SHOTS);
  void updateYtdlp(engine.tools);
  setInterval(() => void updateYtdlp(engine.tools), 24 * 3600_000);
  scheduleUpdates();
  app.on('activate', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    engine.stop();
  });
}

void main();
