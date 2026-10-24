import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const requiredFiles = ['index.html', '.nojekyll'];

await import('./build.mjs');

for (const relativePath of requiredFiles) {
  await access(resolve(output, relativePath));
}

const source = await readFile(resolve(root, 'docs/index.html'), 'utf8');
const html = await readFile(resolve(output, 'index.html'), 'utf8');
if (html !== source) throw new Error('Built HTML differs from docs/index.html.');

console.log('Production build verification passed.');
