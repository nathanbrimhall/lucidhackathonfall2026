import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
// Only OS/tool locations reach test processes; application credentials and tracing configuration do not.
export function toolEnvironment(){
 const allowed=new Set(['systemroot','windir','path','temp','tmp','userprofile','homedrive','homepath','appdata','localappdata','programfiles','programfiles(x86)','comspec','pathext','number_of_processors','ai_browser_executable']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toLowerCase())));
 // Windows sandbox temp directories can reject Vite's atomic cache renames.
 // Keep transient tool files in the ignored, writable workspace directory.
 if(process.platform==='win32'){
  const temp=resolve('data/test-temp');mkdirSync(temp,{recursive:true});
  for(const key of Object.keys(env))if(['temp','tmp'].includes(key.toLowerCase()))delete env[key];
  env.TEMP=temp;env.TMP=temp;
 }
 return env;
}