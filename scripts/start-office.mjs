import {spawn,execFileSync} from 'node:child_process';
execFileSync(process.execPath,['scripts/build-frontend.mjs'],{stdio:'inherit',windowsHide:true});
const args=['--import','tsx','--env-file-if-exists=.env'];const children=[];
function start(file){const child=spawn(process.execPath,[...args,file],{stdio:'inherit',windowsHide:true});children.push(child);child.on('error',()=>shutdown(1));child.on('exit',code=>shutdown(code??1));}
let stopping=false;function shutdown(code=0){if(stopping)return;stopping=true;for(const child of children)if(!child.killed)child.kill('SIGTERM');process.exitCode=code;}
process.on('SIGINT',()=>shutdown());process.on('SIGTERM',()=>shutdown());if(process.argv.includes('--fixtures')&&process.argv.includes('--worker'))throw new Error('The fictional demo does not run audio capture. Use office:dev -- --worker for real capture.');start(process.argv.includes('--fixtures')?'tools/manual-office-demo.ts':'server/src/index.ts');if(process.argv.includes('--worker'))start('worker/src/index.ts');
