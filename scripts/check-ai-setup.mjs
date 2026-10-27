import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const localFile = new URL('../.env', import.meta.url);
const env = { ...(existsSync(localFile) ? parseEnv(readFileSync(localFile, 'utf8')) : {}), ...process.env };
const checks = [];
const add = (name, ok, hint) => checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { hint }) });
add('local_config', existsSync(localFile), 'Run node scripts/setup-local.mjs.');
add('ai_enabled', env.AI_ENABLED === 'true', 'Set AI_ENABLED=true after configuring a provider credential.');
const credentialName = env.AI_PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
add('provider_credential', Boolean(env[credentialName]?.trim()), 'Set ' + credentialName + ' in the local .env file. Never paste it into chat or commit it.');
add('worker_secret', Boolean(env.AI_WORKER_SECRET?.length >= 32 && ![env.SESSION_SECRET, env.LIVEKIT_API_SECRET].includes(env.AI_WORKER_SECRET)), 'Use a distinct AI_WORKER_SECRET of at least 32 characters.');
for (const [name, url] of [['server', env.PUBLIC_SERVER_URL ?? 'http://localhost:2567'], ['livekit', env.LIVEKIT_INTERNAL_URL ?? 'http://localhost:7880']]) {
  try {
    const endpoint = new URL(name === 'server' ? '/readyz' : '/', url);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (name === 'server') {
      const body = await response.json();
      add('server_ready', response.ok && body.status === 'ready', 'Start the application server.');
      add('worker_recently_seen', body.dependencies?.ai === 'up', 'Enable AI and start the configured worker. Heartbeats do not establish model-provider success.');
    } else { add('livekit_reachable', response.ok, 'Start LiveKit; a reachable signaling endpoint does not prove audio connectivity.'); await response.body?.cancel(); }
  } catch { add(name === 'server' ? 'server_ready' : 'livekit_reachable', false, name === 'server' ? 'Start the application server.' : 'Start LiveKit.'); }
}
console.log(JSON.stringify({ checks, liveProviderCallMade: false, readyForLiveAcceptance: checks.every(c => c.ok) }, null, 2));
if (checks.some(c => !c.ok)) process.exitCode = 1;
