// Run test/build tooling with non-loopback network access denied in Node.
import {toolEnvironment} from './tool-environment.mjs';import {spawn} from 'node:child_process';import {resolve} from 'node:path';
const args=process.argv.slice(2);if(!args.length||args.includes('--live'))throw new Error('Provide a local test/build entry point; live model runs are not allowed here.');
const guard=resolve('scripts/offline-network-guard.cjs').replaceAll('\\','/');
const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true,env:{...toolEnvironment(),NODE_OPTIONS:`--require "${guard}"`,OFFICE_TEST_OFFLINE:'1',OTEL_SDK_DISABLED:'true',DO_NOT_TRACK:'1'}});child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
