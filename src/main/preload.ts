import { contextBridge, ipcRenderer, webUtils } from 'electron';

const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(name, ...args);

const names = [
  'view', 'connect', 'disconnect', 'setCredentials', 'setSettings', 'check', 'post', 'approve', 'cancel', 'retry', 'markDone',
  'relayItem', 'copy', 'openUrl', 'reveal', 'openData', 'openLog', 'chooseVideo', 'probeFile', 'handoff', 'toolsInfo', 'updateYtdlp', 'updateCheck', 'updateInstall',
] as const;

const api: Record<string, (...a: unknown[]) => Promise<any>> = {};
for (const n of names) api[n] = call(n);

contextBridge.exposeInMainWorld('echoreel', {
  ...api,
  onChanged: (fn: () => void) => ipcRenderer.on('changed', () => fn()),
  onNavigate: (fn: (nav: { page: string; jobId?: string }) => void) => ipcRenderer.on('navigate', (_e, nav) => fn(nav)),
  /** Path of a file dropped on the window (Electron 32+ no longer exposes File.path). */
  pathFor: (file: File) => webUtils.getPathForFile(file),
});
