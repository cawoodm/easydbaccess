// Guards `npm run start` (bare `electron .`) against launching against a
// missing renderer bundle. Without this, Electron's production branch would
// try to `loadFile()` a nonexistent packages/electron/frontend/index.html
// and Chromium would print a cryptic "Not allowed to load local resource"
// error with no hint at the actual fix.
//
// Resolves the path relative to this script's own directory (not
// process.cwd()), so it works whether invoked directly (`node
// scripts/check-frontend.cjs` from packages/electron) or via `npm run
// start:electron` from the repo root (`npm run start --workspace
// @easydb/electron`).
const fs = require('node:fs');
const path = require('node:path');

const indexPath = path.join(__dirname, '..', 'frontend', 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error(
    `easyDBAccess — renderer not built\n\nThe renderer bundle is missing:\n  ${indexPath}\n\nBuild it first:\n  npm run build:electron\n`,
  );
  process.exit(1);
}
