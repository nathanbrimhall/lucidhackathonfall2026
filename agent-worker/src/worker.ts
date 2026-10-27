import type { AgentContext, AgentRuntime, AgentTurnResult } from './runtime.js';
export interface AgentJobPort {
  claim(workerId: string, mode?: 'fixture' | 'live', runtime?: 'gemini' | 'hermes'): Promise<{runId:string;leaseToken:string} | null> | {runId:string;leaseToken:string} | null;
  context(runId:string,leaseToken:string): Promise<AgentContext> | AgentContext;
  apply(runId:string,leaseToken:string,result:AgentTurnResult): Promise<unknown> | unknown;
  fail(runId:string,leaseToken:string,message:string): Promise<unknown> | unknown;
}
/** Claim reserves a live request durably before model dispatch. Never retries uncertain work. */
export async function executeAgentJob(port: AgentJobPort, runtime: AgentRuntime, options: {workerId?:string;signal?:AbortSignal;timeoutMs?:number;cancelPollMs?:number} = {}): Promise<boolean> {
  options.signal?.throwIfAborted();
  const job = await port.claim(options.workerId ?? 'agent-worker', runtime.mode === 'fixture' ? 'fixture' : 'live', runtime.mode === 'fixture' ? undefined : runtime.mode);
  if (!job) return false;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 45000), ...(options.signal ? [options.signal] : [])]);
  let pollBusy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const context = await port.context(job.runId, job.leaseToken);
    if ((context.run.mode === 'fixture') !== (runtime.mode === 'fixture')) throw new Error('RUNTIME_MODE_MISMATCH');
    timer = setInterval(() => {
      if (pollBusy || signal.aborted) return;
      pollBusy = true;
      Promise.resolve().then(() => port.context(job.runId, job.leaseToken)).catch(() => controller.abort(new Error('RUN_CANCELED_OR_LEASE_LOST'))).finally(() => {pollBusy=false;});
    }, options.cancelPollMs ?? 1000);
    const result = await runtime.turn(context, signal);
    signal.throwIfAborted();
    // Recheck authorization/lease after model work; application validates again atomically on apply.
    await port.context(job.runId, job.leaseToken);
    signal.throwIfAborted();
    await port.apply(job.runId, job.leaseToken, result);
  } catch (error) {
    const message = signal.aborted ? 'Agent execution canceled, timed out, or lost its lease.' : error instanceof Error ? error.message : 'Agent execution failed.';
    await Promise.resolve().then(() => port.fail(job.runId, job.leaseToken, message.slice(0,300))).catch(() => {});
  } finally { if(timer) clearInterval(timer); controller.abort(); }
  return true;
}
export class HttpAgentJobPort implements AgentJobPort {
  constructor(private readonly baseUrl:string, private readonly token:string, private readonly request:typeof fetch=fetch) {
    const url=new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_OFFICE_URL');
    if (url.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('OFFICE_WORKER_REQUIRES_HTTPS');
    if (!token) throw new Error('AGENT_WORKER_TOKEN_REQUIRED');
  }
  private async post(path:string,body:unknown):Promise<any> {
    const response=await this.request(`${this.baseUrl.replace(/\/$/,'')}/internal/agents/jobs/${path}`, {method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok) {await response.body?.cancel();throw new Error(`OFFICE_WORKER_HTTP_${response.status}`);}
    if(response.status===204)return null;
    const reader=response.body?.getReader();if(!reader)throw new Error('OFFICE_EMPTY_RESPONSE');let bytes=0;const chunks:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>150000)throw new Error('OFFICE_RESPONSE_TOO_LARGE');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
  }
  async claim(workerId:string,mode:'fixture'|'live'='live',runtime:'gemini'|'hermes'='gemini'){const response=await this.post('claim',{workerId,mode,runtime});return response.job;}
  context(runId:string,leaseToken:string){return this.post(`${encodeURIComponent(runId)}/context`,{leaseToken});}
  apply(runId:string,leaseToken:string,result:AgentTurnResult){return this.post(`${encodeURIComponent(runId)}/complete`,{leaseToken,result});}
  fail(runId:string,leaseToken:string,message:string){return this.post(`${encodeURIComponent(runId)}/fail`,{leaseToken,message});}
}
