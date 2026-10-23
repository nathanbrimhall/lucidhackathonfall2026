import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const destination = new URL('../dist/server/media-harness/', import.meta.url);
await mkdir(destination, { recursive: true });
await build({ entryPoints: [new URL('../tools/media-harness/main.ts', import.meta.url).pathname], outfile: new URL('main.js', destination).pathname, bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, sourcemap: false });
await Promise.all(['index.html', 'style.css'].map(name => copyFile(new URL(`../tools/media-harness/${name}`, import.meta.url), new URL(name, destination))));
