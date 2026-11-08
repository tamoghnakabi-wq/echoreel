// Builds Echoreel and packages it with electron-builder.
//   node scripts/package.mjs mac|win [extra electron-builder args]
// Stages a minimal app folder (everything is bundled by esbuild, so there are no runtime
// dependencies), makes sure the command-line tools for each target are in tools/, then packages.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const target = process.argv[2] ?? (process.platform === 'win32' ? 'win' : 'mac');
if (!['mac', 'win'].includes(target)) throw new Error('usage: node scripts/package.mjs mac|win');
const extra = process.argv.slice(3);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (process.env.ECHOREEL_VERSION) pkg.version = process.env.ECHOREEL_VERSION; // local update tests

// Package exactly the Electron the app is built and tested with (electron-builder would otherwise
// take whatever its own config or cache says).
const electron = createRequire(import.meta.url)('electron/package.json').version;
if (electron !== pkg.devDependencies.electron) throw new Error(`Electron ${electron} is installed but package.json pins ${pkg.devDependencies.electron}: run npm install`);

// Tools for every architecture being built (a --arm64 / --x64 flag narrows a mac build).
const archs = target === 'win' ? ['x64'] : extra.includes('--arm64') ? ['arm64'] : extra.includes('--x64') ? ['x64'] : ['arm64', 'x64'];
const platform = target === 'win' ? 'win32' : 'darwin';
for (const arch of archs) {
  const exe = platform === 'win32' ? '.exe' : '';
  const have = ['ffmpeg', 'ffprobe', 'yt-dlp', 'cloudflared'].every((t) => existsSync(`tools/${platform}-${arch}/${t}${exe}`));
  if (!have) execSync(`node scripts/fetch-tools.mjs ${platform} ${arch}`, { stdio: 'inherit' });
}

execSync('node scripts/build.mjs', { stdio: 'inherit' });
rmSync('app', { recursive: true, force: true });
mkdirSync('app', { recursive: true });
cpSync('dist', 'app/dist', { recursive: true });
writeFileSync(
  'app/package.json',
  JSON.stringify({ name: 'echoreel', productName: 'Echoreel', version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license, homepage: pkg.homepage, main: 'dist/main.js' }, null, 2),
);
execSync(`npx electron-builder --${target} --publish never --config electron-builder.json -c.electronVersion=${electron} ${extra.join(' ')}`, {
  stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
