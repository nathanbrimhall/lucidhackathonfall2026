import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { loadWorkerConfig } from '../../worker/src/config.js';
import { GeminiAgentRuntime } from './runtime.js';
import { HermesAgentRuntime, verifyHermesSource } from './hermes.js';
import { executeAgentJob, HttpAgentJobPort } from './worker.js';
const env=process.env;
const mode=env.AGENT_RUNTIME ?? 'fixture';
if(!['fixture','gemini','hermes'].includes(mode))throw new Error('AGENT_RUNTIME must explicitly be fixture, gemini, or hermes.');
if(mode==='fixture')throw new Error('The fixture runs inside the office server. Start the office normally, or explicitly select AGENT_RUNTIME=hermes or gemini for this separate live worker.');
const providerConfig=loadWorkerConfig(env);
const runtime=mode==='hermes'?new HermesAgentRuntime(providerConfig,{sourceRoot:env.AGENT_HERMES_SOURCE_ROOT??'',python:env.AGENT_HERMES_PYTHON??''}):new GeminiAgentRuntime(providerConfig);
if(mode==='hermes')await verifyHermesSource(env.AGENT_HERMES_SOURCE_ROOT??'');
const port=new HttpAgentJobPort(env.AGENT_SERVER_URL ?? env.AGENT_OFFICE_URL ?? 'http://127.0.0.1:2567',env.AGENT_WORKER_SECRET ?? env.AGENT_WORKER_TOKEN ?? '');
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
const workerId=`agent-${randomUUID()}`;
console.info(`Agent worker started: ${mode}; bounded single-request turns; live acceptance is not implied by configuration.`);
while(!controller.signal.aborted){
  try{await executeAgentJob(port,runtime,{workerId,signal:controller.signal});}
  catch{if(!controller.signal.aborted)console.error('Agent worker could not claim work; no model request started.');}
  try{await setTimeout(1000,undefined,{signal:controller.signal});}catch{break;}
}
