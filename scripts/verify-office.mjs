import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
if(process.env.OFFICE_TEST_OFFLINE!=='1')throw new Error('Run through scripts/run-offline.mjs to block external networking.');
const browserOnly=process.argv.includes('--browsers-only');
const browsers=[['integrated browser',['--import','tsx','tools/integrated-smoke.ts']],['manual demo browser',['--import','tsx','tools/manual-demo-smoke.ts']]];
const steps=browserOnly?[['frontend',['scripts/build-frontend.mjs']],...browsers]:[
 ['typecheck',['node_modules/typescript/bin/tsc','--noEmit']],
 ['compile',['node_modules/typescript/bin/tsc','-p','tsconfig.build.json']],
 ['assets',['scripts/copy-assets.cjs']],
 ['media harness',['scripts/build-media-harness.mjs']],
 ['frontend',['scripts/build-frontend.mjs']],
 ['automated tests',['node_modules/vitest/vitest.mjs','run','--maxWorkers=2']],
 ...browsers,
];
const report={startedAt:new Date().toISOString(),finishedAt:null,mode:browserOnly?'browsers':'full',networkMode:'loopback-only',liveApiCalls:0,passed:false,checks:[]};
const reportPath='data/ai-eval/'+(browserOnly?'office-browser-verification-latest.json':'office-verification-latest.json');
await mkdir('data/ai-eval',{recursive:true});
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
await save();
for(const [label,args]of steps){
 console.log('Checking office: '+label);
 const started=Date.now();
 const code=await new Promise(done=>{
  const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true,env:process.env});
  child.on('error',()=>done(1));child.on('exit',code=>done(code??1));
 });
 report.checks.push({name:label,exitCode:code,elapsedMs:Date.now()-started});await save();
 if(code){
  process.exitCode=1;
  // Both browser scripts own isolated servers. Record the second result even
  // when the first fails, instead of making the seeded demo silently untested.
  if(!browsers.some(([name])=>name===label))break;
 }
}
report.finishedAt=new Date().toISOString();report.passed=report.checks.length===steps.length&&report.checks.every(check=>check.exitCode===0);await save();
console.log('Office verification: '+(report.passed?'PASS':'FAIL')+'; report '+reportPath);
if(!report.passed)process.exitCode=1;
