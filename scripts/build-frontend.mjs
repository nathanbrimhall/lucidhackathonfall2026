import { build } from 'esbuild';import {mkdir,copyFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
const output=new URL('../dist/server/frontend/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('../frontend/main.ts',import.meta.url))],outfile:fileURLToPath(new URL('main.js',output)),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,sourcemap:false});
await copyFile(new URL('../frontend/index.html',import.meta.url),new URL('index.html',output));
