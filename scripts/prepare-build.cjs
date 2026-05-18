// Run before electron-builder. Downloads Playwright's chromium into ./pw-cache
// so it can be bundled as extraResources in the installer.
// At runtime, electron/main.cjs sets PLAYWRIGHT_BROWSERS_PATH to the unpacked
// location inside the installed app.

const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'pw-cache');

fs.mkdirSync(CACHE_DIR, { recursive: true });
console.log(`[prepare-build] PLAYWRIGHT_BROWSERS_PATH=${CACHE_DIR}`);
console.log('[prepare-build] downloading chromium (~280 MB, one-time)...');

try {
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: CACHE_DIR },
    cwd: ROOT,
  });
  console.log('[prepare-build] chromium ready at', CACHE_DIR);
} catch (err) {
  console.error('[prepare-build] failed:', err.message);
  process.exit(1);
}
