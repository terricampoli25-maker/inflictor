// Copies app files from the project root into desktop/app/
// Run: node build.js   (automatically run before electron starts)

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(__dirname, 'app');

const ITEMS = [
  'index.html',
  'sounds',
  'icons',
  'dark-stage.png',
  'light-stage.png',
  'dark-open.png',
  'light-open.png',
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry), d = path.join(dest, entry);
    fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

fs.mkdirSync(DEST, { recursive: true });

for (const item of ITEMS) {
  const src  = path.join(ROOT, item);
  const dest = path.join(DEST, item);
  if (!fs.existsSync(src)) { console.warn(`  skipping ${item} (not found)`); continue; }
  fs.statSync(src).isDirectory() ? copyDir(src, dest) : fs.copyFileSync(src, dest);
  console.log(`  copied  ${item}`);
}

// Stamp the built index.html with the app version (single source of truth = package.json) so the
// running build is identifiable in-app — makes stale-install confusion obvious.
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const idxPath = path.join(DEST, 'index.html');
  const stamped = fs.readFileSync(idxPath, 'utf8').replace(/__APP_VERSION__/g, pkg.version);
  fs.writeFileSync(idxPath, stamped);
  console.log(`  stamped version ${pkg.version}`);
} catch (e) { console.warn('  version stamp failed:', e.message); }

console.log('Build complete → desktop/app/');
