// Builds echoreel-update.json for a release: per platform the installer's URL, sha256, size and an
// ed25519 signature over `echoreel-update:v1:<version>:<platform>:<sha256>:<size>`, which the app
// checks against the public key compiled into it (src/main/updater.ts).
//   ECHOREEL_UPDATER_KEY=<pkcs8 pem> node scripts/release-manifest.mjs <version> <dir> <repo> <tag> [base-url]
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, dir, repo, tag, base] = process.argv.slice(2);
const pem = process.env.ECHOREEL_UPDATER_KEY;
if (!version || !dir || !repo || !tag || !pem) throw new Error('usage: ECHOREEL_UPDATER_KEY=... release-manifest.mjs <version> <dir> <repo> <tag> [base-url]');
const key = createPrivateKey(pem);
const downloads = base ?? `https://github.com/${repo}/releases/download/${tag}/`;
// The mac updates are the zips (the app is swapped in place); Windows runs the installer.
const targets = { 'darwin-arm64': 'Echoreel-mac-arm64.zip', 'darwin-x64': 'Echoreel-mac-x64.zip', 'win32-x64': 'Echoreel-win-x64-setup.exe' };
const platforms = {};
for (const [platform, file] of Object.entries(targets)) {
  const path = join(dir, file);
  if (!existsSync(path)) continue;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const size = statSync(path).size;
  const signature = sign(null, Buffer.from(`echoreel-update:v1:${version}:${platform}:${sha256}:${size}`), key).toString('base64');
  platforms[platform] = { url: downloads + encodeURIComponent(file), sha256, size, signature };
}
if (!Object.keys(platforms).length) throw new Error(`No release files in ${dir}`);
let notes = '';
try {
  notes = readFileSync(`releases/v${version}.md`, 'utf8');
} catch {}
writeFileSync(join(dir, 'echoreel-update.json'), JSON.stringify({ version, notes, platforms }, null, 2));
console.log('signed', Object.keys(platforms).join(', '));
