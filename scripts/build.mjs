// Bundles the Electron main process, preload, renderer and a plain-Node copy of the core (for tests).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// Local update tests build a second, newer version without editing package.json.
if (process.env.ECHOREEL_VERSION) pkg.version = process.env.ECHOREEL_VERSION;
const common = { bundle: true, logLevel: 'warning', legalComments: 'none', define: { __VERSION__: JSON.stringify(pkg.version) } };
const node = { ...common, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'] };
await build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', sourcemap: 'linked' });
await build({ ...node, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js' });
await build({ ...node, entryPoints: ['src/core/index.ts'], outfile: 'dist/core.js' });
await build({ ...common, platform: 'browser', target: 'chrome130', format: 'iife', entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js' });
for (const f of ['index.html', 'styles.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
cpSync('build/icon.png', 'dist/renderer/icon.png');
console.log('built dist/');
