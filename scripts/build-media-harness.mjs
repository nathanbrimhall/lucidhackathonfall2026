import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const destination = new URL('../dist/server/media-harness/', import.meta.url);
await mkdir(destination, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('../tools/media-harness/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('main.js', destination)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
});
await Promise.all(['index.html', 'style.css'].map(name => copyFile(new URL(`../tools/media-harness/${name}`, import.meta.url), new URL(name, destination))));
