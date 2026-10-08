// ZIP-only release: preserves the installed extension ID when loaded unpacked.
// No replacement signing keys are generated.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './lib/zip.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
mkdirSync(join(root, 'builds'), { recursive: true });
for (const [name, folder] of [['desktop', 'extension'], ['android', 'extension-android'], ['mobile', 'extension-mobile']]) {
  const base = join(root, folder);
  const entries = walk(base).sort().map(path => ({
    name: 'extension/' + relative(base, path).split('\\').join('/'), data: readFileSync(path),
  }));
  entries.push({ name: 'FIXES.md', data: readFileSync(join(root, 'FIXES.md')) });
  writeFileSync(join(root, 'builds', `extension-${name}.zip`), makeZip(entries));
  console.log(`Built extension-${name}.zip`);
}
