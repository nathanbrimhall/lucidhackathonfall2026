/** Isolated browser regression for actual frontend DOM events, with a fake client. */
import {chromium,type Page} from 'playwright';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const result=await build({entryPoints:['frontend/main.ts'],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,plugins:[{name:'synthetic-office-client',setup(builder){builder.onResolve({filter:/^\.\/client\.js$/},args=>args.importer.endsWith('main.ts')?{path:resolve('frontend/test/office-client.fixture.ts')}:undefined);}}]});
const html=(await readFile('frontend/index.html','utf8')).replace(/<script\b[^>]*src=["']\.\/main\.js["'][^>]*><\/script>/,'');
await mkdir('data/test-temp',{recursive:true});const path=resolve('data/test-temp/frontend-ui-'+randomUUID()+'.html');await writeFile(path,html);
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.AI_BROWSER_EXECUTABLE??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});
 const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(5000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(pathToFileURL(path).href);await page.addScriptTag({content:result.outputFiles[0].text});
 async function clickWhileStateChanges(label:string){
  const control=page.getByRole('button',{name:label,exact:true});await control.scrollIntoViewIfNeeded();const box=await control.boundingBox();if(!box)throw new Error('Missing '+label);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.evaluate(()=>(window as any).__officeUiTest.updateMedia());
  await page.mouse.up();
 }
 await page.getByRole('button',{name:'Request AI meeting notes',exact:true}).waitFor();
 await clickWhileStateChanges('Request AI meeting notes');
 const sent=await page.evaluate(()=>(window as any).__officeUiTest.client.messages);
 if(sent.filter((m:any)=>m.type==='ai.request').length!==1)throw new Error('Meeting-notes request was lost when the panel updated between mouse-down and mouse-up');
 await page.getByRole('button',{name:'I consent for this roster',exact:true}).waitFor();
 if(sent.some((m:any)=>m.type==='ai.consent'))throw new Error('Consent was sent without an explicit click');
 await clickWhileStateChanges('I consent for this roster');
 const consent=await page.evaluate(()=>(window as any).__officeUiTest.client.messages.filter((m:any)=>m.type==='ai.consent'));
 if(consent.length!==1||consent[0].value.consent!==true)throw new Error('Explicit consent click was lost or duplicated');
 await page.getByRole('button',{name:'AI assistant',exact:true}).click();await page.getByLabel('Your question',{exact:true}).fill('What scope did the saved draft describe?');
 await clickWhileStateChanges('Ask assistant');await page.getByText('A saved draft records audio-only scope.',{exact:true}).waitFor();
 if(await page.getByRole('button',{name:'Ask assistant',exact:true}).isDisabled())throw new Error('Assistant button remained disabled after its response');
 const calls=await page.evaluate(()=>(window as any).__officeUiTest.client.apiCalls.filter((r:any)=>r.path==='/api/assistant').length);
 if(calls!==1||errors.length)throw new Error(errors.join('; ')||'Assistant request lost or duplicated');
 console.log(JSON.stringify({frontendInteractionBrowser:'PASS',midClickStateUpdates:3,notesRequest:true,explicitConsent:true,assistantSubmission:true,automaticConsent:false,mockedClient:true,realServerTested:false,networkRequests:0,liveApiCalls:0}));
}finally{await browser?.close();await unlink(path);}
