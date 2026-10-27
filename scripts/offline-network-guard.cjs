// Test-only network isolation. Never preload this in the real application.
// Blocks non-loopback HTTP, fetch, DNS, TCP and TLS before any test imports run.
const http=require('node:http'),https=require('node:https'),net=require('node:net'),tls=require('node:tls'),dns=require('node:dns');
const {syncBuiltinESMExports}=require('node:module');
function allowed(host){return ['localhost','127.0.0.1','::1','[::1]'].includes(String(host??'localhost').toLowerCase());}
function dnsCheck(host,key){if(key==="lookup"&&["0.0.0.0","::"].includes(String(host)))return;check(host);}
function check(host){if(!allowed(host)){const error=new Error('Offline tests block non-loopback networking');error.code='OFFLINE_NETWORK_BLOCKED';throw error;}}
function hostName(host){if(String(host).startsWith('['))return String(host).split(']')[0]+']';return String(host).split(':')[0];}
function requestArgs(args){for(const value of args.slice(0,2)){if(typeof value==='string'||value instanceof URL){check(new URL(value).hostname);}else if(value&&typeof value==='object'){check(value.hostname??(value.host?hostName(value.host):'localhost'));if(value.method==='CONNECT'&&value.path)check(hostName(value.path));if(typeof value.path==='string'&&/^https?:/.test(value.path))check(new URL(value.path).hostname);}}}
for(const mod of [http,https])for(const key of ['request','get']){const original=mod[key];mod[key]=function(...args){requestArgs(args);return Reflect.apply(original,this,args);};}
function connectionArgs(args){if(Array.isArray(args[0]))return connectionArgs(args[0]);const first=args[0];if(first&&typeof first==='object'){if(first.path)return;check(first.host??first.hostname??'localhost');}else if(typeof first==='number'){check(typeof args[1]==='string'?args[1]:'localhost');}else if(typeof first==='string'&&!first.startsWith('\\\\.\\pipe\\')&&!first.startsWith('/'))check(first);}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){connectionArgs(args);return Reflect.apply(connect,this,args);};
const tlsConnect=tls.connect;tls.connect=function(...args){connectionArgs(args);return Reflect.apply(tlsConnect,this,args);};
for(const key of ['lookup','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveTxt','resolveMx','resolveSrv','resolveNs','resolveSoa','resolveNaptr','reverse'])if(typeof dns[key]==='function'){const original=dns[key];dns[key]=function(host,...args){dnsCheck(host,key);return Reflect.apply(original,this,[host,...args]);};}
for(const key of ['lookup','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveTxt','resolveMx','resolveSrv','resolveNs','resolveSoa','resolveNaptr','reverse'])if(typeof dns.promises[key]==='function'){const original=dns.promises[key];dns.promises[key]=async function(host,...args){dnsCheck(host,key);return Reflect.apply(original,this,[host,...args]);};}
const originalFetch=globalThis.fetch;if(originalFetch)globalThis.fetch=async function(input,init){check(new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).hostname);return originalFetch(input,{...init,redirect:'error'});};
syncBuiltinESMExports();
