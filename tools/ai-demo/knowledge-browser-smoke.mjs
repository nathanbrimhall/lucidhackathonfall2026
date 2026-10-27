import { chromium } from 'playwright';
import { createDemoApp } from './app.ts';
import { referenceKnowledge } from './knowledge-runner.ts';
let providerCalls=0;
const request=async(_url,init)=>{providerCalls++;const input=JSON.parse(JSON.parse(String(init.body)).contents[0].parts[0].text);return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(referenceKnowledge(input.feature,input))}]}}]}));};
const app=createDemoApp({env:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'fictional-key',AI_WORKER_SECRET:'s'.repeat(32),AI_USAGE_DATABASE:':memory:'},request,reviewDatabase:':memory:',cooldownMs:0});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.AI_BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let calls=0;page.on('request',r=>{if(r.url().endsWith('/api/ai-panel')&&r.method()==='POST')calls++;});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('[data-task-id="speaker-export"]').waitFor({state:'attached'});
 const submit=async()=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/ai-panel'));await page.locator('#panel-submit').click();await response;await page.waitForFunction(()=>!document.getElementById('panel-submit').disabled);};
 await page.getByRole('button',{name:'Decision questions',exact:true}).click();if(calls||providerCalls)throw new Error('Automatic invocation');await submit();
 if(await page.locator('[data-claim-kind="historical_decision"]').count()!==1)throw new Error('Superseded decision missing');if(!(await page.locator('#panel-results').textContent()).includes('recorded reason')&&!(await page.locator('[data-claim-kind="reasoning"]').count()))throw new Error('Reasoning missing');
 if(await page.locator('[data-claim-kind="assumption"]').count()<2)throw new Error('Assumptions missing');
 await page.locator('#panel-to').fill('2026-10-23');await submit();if(await page.locator('[data-claim-kind="historical_decision"]').count())throw new Error('Later supersession leaked');if((await page.locator('#panel-results').textContent()).includes('slack-preview'))throw new Error('Future decision leaked');
 await page.locator('#panel-to').fill('2026-10-26');await page.getByRole('button',{name:'Daily brief',exact:true}).click();await submit();
 const ownTaskCount=await page.locator('[data-claim-kind="task"]').count();if(ownTaskCount!==1)throw new Error('Contributor task tailoring failed');if((await page.locator('#panel-results').textContent()).includes('audio-scope'))throw new Error('Old record included in daily changes');
 const beforeRole=calls;await page.locator('#panel-role').selectOption('lead');if(calls!==beforeRole)throw new Error('Role change called AI');await submit();if(await page.locator('[data-claim-kind="task"]').count()<=ownTaskCount)throw new Error('Lead detail missing');if((await page.locator('#panel-results').textContent()).includes('restricted-personnel'))throw new Error('Role leaked restricted content');
 await page.getByRole('button',{name:'Catch-up brief',exact:true}).click();await submit();if(!(await page.locator('[data-claim-kind="historical_decision"]').count()))throw new Error('Catch-up missed changed decision');
 const beforeFollowup=calls;await page.getByRole('button',{name:'Ask this question',exact:true}).first().click();if(calls!==beforeFollowup)throw new Error('Prepared follow-up ran automatically');
 await page.getByRole('button',{name:'Meeting prep',exact:true}).click();await submit();if(await page.locator('[data-agenda="true"]').count()<1)throw new Error('Agenda missing');if((await page.locator('#panel-results').textContent()).includes('destination-question')){
  // The inspect-context details include answered history; only agenda cards must omit it.
  if((await page.locator('[data-agenda="true"]').allTextContents()).some(text=>text.includes('Which destination will the demo target?')))throw new Error('Answered question became an open agenda item');
 }
 await page.getByRole('button',{name:'Decision questions',exact:true}).click();await page.locator('#panel-mode').selectOption('live');await submit();if(providerCalls!==1)throw new Error('Expected one mocked live request');
 await page.locator('#panel-mode').selectOption('replay');await page.locator('#panel-to').fill('2026-10-22');await submit();if(!(await page.locator('#panel-results').textContent()).includes('not found'))throw new Error('Unknown result missing');
 const state=await(await page.request.get(`http://127.0.0.1:${server.address().port}/api/workspace`)).json();if(state.revision!==0||state.notifications.length)throw new Error('Read-only tools mutated workspace');
 if(errors.length)throw new Error(errors.join(';'));console.log('Knowledge browser passed: past decisions, assumptions, recorded reasoning, as-of history, daily/catch-up windows, role tailoring, meeting agenda, explicit follow-ups, unknowns and no mutations. No live API calls.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));app.locals.close();}
