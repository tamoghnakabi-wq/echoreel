// Renders Echoreel's icons from SVG with Electron (transparent background). Usage: npx electron scripts/render-icons.cjs <outdir>, then size them down into build/ with sips
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('fs');
const out = process.argv[process.argv.length - 1];
const mark = (front, echo1, echo2, play, sw = 1.6) => `
  <rect x="2.8" y="7.8" width="11" height="17.4" rx="2.6" fill="none" stroke="${echo2}" stroke-width="${sw}"/>
  <rect x="7.8" y="6" width="12.4" height="21" rx="3" fill="none" stroke="${echo1}" stroke-width="${sw}"/>
  <rect x="13.6" y="3.5" width="15.4" height="26" rx="3.6" fill="${front}"/>
  <path d="M19 12.2v8.6l6.6-4.3z" fill="${play}"/>`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
 <defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e3531"/><stop offset="1" stop-color="#141816"/></linearGradient>
  <linearGradient id="key" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd682"/><stop offset=".45" stop-color="#ffb224"/><stop offset="1" stop-color="#f09500"/></linearGradient>
  <radialGradient id="glow" cx=".64" cy=".52" r=".5"><stop offset="0" stop-color="#ffb224" stop-opacity=".28"/><stop offset="1" stop-color="#ffb224" stop-opacity="0"/></radialGradient>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000" flood-opacity=".42"/></filter>
  <filter id="lit" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="0" stdDeviation="1.1" flood-color="#ffb224" flood-opacity=".55"/></filter>
 </defs>
 <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)" filter="url(#sh)"/>
 <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#glow)"/>
 <rect x="102" y="102" width="820" height="820" rx="184" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="4"/>
 <g transform="translate(233 215) scale(18)">
  <rect x="2.8" y="7.8" width="11" height="17.4" rx="2.6" fill="none" stroke="#ffb224" stroke-opacity=".3" stroke-width="1.25"/>
  <rect x="7.8" y="6" width="12.4" height="21" rx="3" fill="none" stroke="#ffb224" stroke-opacity=".62" stroke-width="1.25"/>
  <rect x="13.6" y="3.5" width="15.4" height="26" rx="3.6" fill="url(#key)" filter="url(#lit)"/>
  <path d="M19 12.2v8.6l6.6-4.3z" fill="#2b1d00"/>
 </g>
</svg>`;
// Menu bar template: black with alpha; the play mark is cut out of the front frame.
const template = `<svg xmlns="http://www.w3.org/2000/svg" width="352" height="352" viewBox="0 0 32 32">
 <clipPath id="c"><rect x="0" y="0" width="13.6" height="32"/></clipPath>
 <g clip-path="url(#c)">
 <rect x="2.8" y="7.8" width="11" height="17.4" rx="2.6" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="2.2"/>
 <rect x="7.8" y="6" width="12.4" height="21" rx="3" fill="none" stroke="#000" stroke-opacity=".75" stroke-width="2.2"/></g>
 <path fill="#000" fill-rule="evenodd" d="M17.2 3.5h8.2a3.6 3.6 0 0 1 3.6 3.6v18.8a3.6 3.6 0 0 1-3.6 3.6h-8.2a3.6 3.6 0 0 1-3.6-3.6V7.1a3.6 3.6 0 0 1 3.6-3.6zM19 12.2v8.6l6.6-4.3z"/>
</svg>`;
const tray = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 32 32">${mark('#ffb224', 'rgba(255,178,36,.75)', 'rgba(255,178,36,.4)', '#2b1d00', 2.2)}</svg>`;
let win;
async function render(svg, size, file) {
  win ??= new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.setContentSize(size, size);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  writeFileSync(file, img.toPNG());
  console.log(file, img.getSize());
}
app.whenReady().then(async () => {
  await render(icon, 1024, `${out}/icon-1024.png`);
  await render(template, 352, `${out}/template-352.png`);
  await render(tray, 512, `${out}/tray-512.png`);
  app.exit(0);
});
