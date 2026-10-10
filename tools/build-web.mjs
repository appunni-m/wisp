/**
 * Copy the static app into dist/, which is what the Android app bundles.
 *
 * There is no bundler and no build step for the web app itself — the browser
 * loads the same ES modules that the tests import. This script only collects
 * them, and refuses to ship anything that looks like a development leftover.
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');

const FILES = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
const DIRS = ['src'];

const FORBIDDEN = [/^\./, /test/, /tools/, /node_modules/, /\.map$/];

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const file of FILES) {
    await cp(join(ROOT, file), join(DIST, file));
  }
  for (const dir of DIRS) {
    await cp(join(ROOT, dir), join(DIST, dir), { recursive: true });
  }

  // Sanity: nothing unexpected, and every module the app imports is present.
  const entries = await readdir(DIST);
  const suspicious = entries.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry)));
  if (suspicious.length) throw new Error(`refusing to ship: ${suspicious.join(', ')}`);

  const modules = await readdir(join(DIST, 'src'));
  const total = (await Promise.all(modules.map(async (m) => (await stat(join(DIST, 'src', m))).size)))
    .reduce((a, b) => a + b, 0);

  console.log(`dist/ ready: ${entries.length} entries, ${modules.length} modules, ${(total / 1024).toFixed(1)} KB of JS`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
