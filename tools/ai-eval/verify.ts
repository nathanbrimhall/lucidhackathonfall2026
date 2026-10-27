import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { createDemoApp } from "../ai-demo/app.js";
import { fixtures } from "./fixtures.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { UsageTracker } from "../../worker/src/usage.js";
const live = process.argv.includes("--live");
const npmCli=process.env.npm_execpath;
if (!npmCli) throw new Error("Run this through npm run ai:verify.");
const checks: { name: string; exitCode: number; elapsedMs: number }[]=[];
let liveReport: unknown=null, usageStatus: unknown=null, server: Server | undefined;
let livePassed=false;
function run(name: string, file: string, args: string[], env: NodeJS.ProcessEnv=process.env): Promise<boolean> {
  const started=Date.now();
  console.log(`Checking: ${name}`);
  return new Promise(resolveResult=>{
    const child=spawn(file,args,{cwd:process.cwd(),env,stdio:"inherit",windowsHide:true});
    let settled=false;
    const finish=(exitCode:number)=>{if(settled)return;settled=true;checks.push({name,exitCode,elapsedMs:Date.now()-started});resolveResult(exitCode===0);};
    child.once("error",()=>finish(1)); child.once("exit",code=>finish(code??1));
  });
}
async function npm(name: string, ...args: string[]) { return run(name,process.execPath,[npmCli!,...args]); }
try {
  for (const [name,args] of [
    ["typecheck",["run","typecheck"]], ["automated-tests",["test","--","--maxWorkers=2"]],
    ["production-build",["run","build"]], ["offline-fixtures",["run","ai:eval"]],
  ] as const) { if (!await npm(name,...args)) throw new Error("A local check failed; no additional API calls will be made."); }
  if (live) {
    const config=loadWorkerConfig();
    const tracker=new UsageTracker(config.usageDatabase,config.apiKey,config.localDailyRequestLimit);
    try {
      const state=tracker.status();
      if(state.quotaPaused || state.localRequestsRemaining<fixtures.length+1) throw new Error("Quota pause or insufficient local request budget for the suite and browser check. Run npm run ai:usage.");
    } finally { tracker.close(); }
    const passed=await npm("live-Gemini-fixtures","run","ai:eval","--","--live","--all");
    liveReport=JSON.parse(await readFile(resolve("data/ai-eval/latest-live.json"),"utf8"));
    livePassed=passed;
    if(!passed) {
      process.exitCode=1;
      const summary=(liveReport as {summary?:{failures?:number;missingNoteFacts?:number}}).summary;
      console.error(summary?.failures===0
        ? `Live requests completed, but quality checks failed (${summary.missingNoteFacts??0} missing note facts; see the report for action/owner/deadline checks). No automatic retry. Continuing with the offline browser check.`
        : "Live provider/extraction requests failed; no automatic retry. Continuing with the offline browser check.");
    }
    // Keep the live browser request spaced from the final suite request.
    if(passed) await new Promise(resolveWait=>setTimeout(resolveWait,15000));
  }
  // Own an isolated ephemeral server; leave the user's running demo untouched.
  const browserApp=createDemoApp({reviewDatabase:":memory:"});
  server=browserApp.listen(0,"127.0.0.1");
  server.once("close",()=>browserApp.locals.close());
  await new Promise<void>((resolveReady,reject)=>{server!.once("listening",resolveReady);server!.once("error",reject);});
  const address=server.address(); if(!address||typeof address==="string") throw new Error("Missing demo port");
  if(!await run("browser-smoke",process.execPath,["tools/ai-demo/browser-smoke.mjs",...(live && livePassed?["--live"]:[])],{...process.env,AI_DEMO_URL:`http://127.0.0.1:${address.port}/`})) throw new Error("Browser smoke failed");
  for(const [name,script] of [["discovery-helpers-interruptions-browser","tools/ai-demo/discovery-browser-smoke.mjs"],["ai-panel-coordination-browser","tools/ai-demo/panel-browser-smoke.mjs"],["decisions-briefs-meeting-browser","tools/ai-demo/knowledge-browser-smoke.mjs"]]) {
    if(!await run(name,process.execPath,["--import","tsx",script]))throw new Error(`${name} failed`);
  }
} catch(error) {
  console.error(error instanceof Error?error.message:"Verification failed"); process.exitCode=1;
} finally {
  if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}
  if(live){try{const config=loadWorkerConfig();const tracker=new UsageTracker(config.usageDatabase,config.apiKey,config.localDailyRequestLimit);try{usageStatus=tracker.status();}finally{tracker.close();}}catch{/* no credentials */}}
  await mkdir("data/ai-eval",{recursive:true});
  const report={timestamp:new Date().toISOString(),mode:live?"live":"offline",passed:process.exitCode!==1,checks,liveReport,usageStatus};
  await writeFile("data/ai-eval/verification-latest.json",JSON.stringify(report,null,2));
  const rows=checks.map(c=>`| ${c.name} | ${c.exitCode===0?"PASS":"FAIL"} | ${(c.elapsedMs/1000).toFixed(1)} s |`).join("\n");
  await writeFile("docs/AI_VERIFICATION_LATEST.md",`# AI verification\n\nGenerated: ${report.timestamp}\n\nMode: ${report.mode}. Result: ${report.passed?"PASS":"FAIL"}.\n\n| Check | Result | Time |\n| --- | --- | --- |\n${rows}\n\nDetailed results and usage status: data/ai-eval/verification-latest.json.\n\nOffline runs make no provider calls. Live mode uses the configured model and records requests before sending them. Provider quota errors pause further requests; no automatic retry or model fallback occurs. This report cannot establish remaining Google quota or usage from other applications.\n`);
  console.log("Verification report: docs/AI_VERIFICATION_LATEST.md");
}
