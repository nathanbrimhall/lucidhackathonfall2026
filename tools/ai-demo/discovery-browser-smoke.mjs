import { chromium } from 'playwright';
import { createDemoApp } from './app.ts';
const request=async()=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({matches:[{conversationId:'speaker-mapping',reason:'Speaker mapping supports task attribution.',evidenceIds:['e1']}]})}]}}]}));
const app=createDemoApp({env:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'fictional',AI_WORKER_SECRET:'s'.repeat(32),AI_USAGE_DATABASE:':memory:'},request,reviewDatabase:':memory:',cooldownMs:0});
const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.AI_BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage();let searchCalls=0;page.on('request',request=>{if(request.url().endsWith('/api/discovery')&&request.method()==='POST')searchCalls++;});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.locator('#discovery-catalog details').first().waitFor({state:'attached'});
 if(searchCalls!==0)throw new Error('Search ran before an explicit request');await page.locator('#discovery-interest').fill('How do I determine who said what for action ownership?');if(searchCalls!==0)throw new Error('Typing triggered an automatic search');await page.locator('#discover-button').click();await page.locator('#discovery-results article').waitFor();
 if(!(await page.locator('#discovery-results').innerText()).includes('stable speaker IDs'))throw new Error('Missing evidence');
 await page.route('**/api/discovery',route=>route.fulfill({json:{matches:[],fictional:true,model:'mock',latencyMs:1}}));await page.locator('#discover-button').click();await page.locator('#discovery-status').filter({hasText:'No relevant discussions found'}).waitFor();
 if(await page.locator('#discovery-results article').count())throw new Error('Stale results');
 await page.unroute('**/api/discovery');await page.route('**/api/discovery',route=>route.abort());await page.locator('#discover-button').click();await page.locator('#discovery-status').filter({hasText:'Cannot reach the local server'}).waitFor();
 await page.unroute('**/api/discovery');
 await page.route('**/api/discovery',route=>route.fulfill({json:{helpers:[{person:{id:'cameron',name:'Cameron',skills:'Speaker mapping'},reason:'He is testing the identity mapping.',conversation:{title:'Speaker mapping'},evidence:[{id:'e2',text:'Cameron is testing speaker mapping.'}]}],model:'mock',latencyMs:1}}));
 await page.locator('#discovery-mode').selectOption('helpers');await page.locator('#discover-button').click();await page.locator('#discovery-results h3').filter({hasText:'Cameron'}).waitFor();
 await page.getByRole('button',{name:'Simulate an invitation in my inbox',exact:true}).click();await page.locator('#interrupt-notice').filter({hasText:'saved quietly'}).waitFor();
 await page.locator('#interrupt-allow').check();await page.locator('#simulate-invitation').click();await page.locator('#interrupt-notice').filter({hasText:'New demo invitation'}).waitFor();
 const beforePresenceChanges=searchCalls;
 for(const state of ['away','meeting']){await page.locator('#interrupt-presence').selectOption(state);await page.locator('#simulate-invitation').click();await page.locator('#interrupt-notice').filter({hasText:'saved quietly'}).waitFor();}
 if(searchCalls!==beforePresenceChanges)throw new Error('Presence changes triggered an AI request');
 await page.locator('#interrupt-presence').selectOption('dnd');await page.locator('#simulate-invitation').click();await page.locator('#interrupt-notice').filter({hasText:'saved quietly'}).waitFor();
 await page.reload();if(await page.locator('#interrupt-presence').inputValue()!=='dnd')throw new Error('Preference did not persist');
 if(await page.locator('#interrupt-inbox article').count())throw new Error('Invitation text unexpectedly persisted');
 if(searchCalls!==beforePresenceChanges)throw new Error('Reload triggered an AI request');
 if(errors.length)throw new Error(errors.join(';'));console.log('Discovery browser passed: sources, evidence, empty results, network failure, helpers, quiet inbox, DND and persistence. No live API calls.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));app.locals.close();}
