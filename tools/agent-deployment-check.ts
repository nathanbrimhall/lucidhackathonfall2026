/** Read-only preflight for a deployed shared office. It creates no users or rooms. */
import { readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';

export type DeploymentCheck = { status: 'pass' | 'fail' | 'not-run'; detail: string };
export type DeploymentReport = {
  checkedAt: string;
  networkScope: 'public' | 'lan';
  officeOrigin: string | null;
  livekitOrigin: string | null;
  checks: Record<string, DeploymentCheck>;
  humanAcceptance: 'not-assessed';
};
export type DeploymentOptions = {
  officeUrl?: string;
  livekitUrl?: string;
  allowLan?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  tlsProbe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
};

function deploymentOrigin(raw: string | undefined, protocol: 'https:' | 'wss:', allowLan: boolean): URL | undefined {
  if (!raw) return undefined;
  const value = new URL(raw);
  if (value.protocol !== protocol) throw new Error(`${protocol === 'https:' ? 'Office' : 'LiveKit'} URL must use ${protocol}.`);
  if (value.username || value.password || value.search || value.hash || (value.pathname !== '/' && value.pathname !== '')) {
    throw new Error('Supply a public origin without credentials, path, query parameters or fragments.');
  }
  const accepted = allowLan ? isLanHostname(value.hostname) : isPublicHostname(value.hostname);
  if (!accepted) throw new Error(allowLan
    ? 'LAN scope requires a private LAN address or local network hostname; loopback and reserved example hosts are not accepted.'
    : 'Public scope requires a public host; local, private and reserved hosts are not accepted. Use --allow-lan for a private LAN deployment.');
  return value;
}

export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (['example', 'test', 'invalid', 'example.com', 'example.net', 'example.org'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    const c = Number(host.split('.')[2]);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (ipVersion === 6) {
    const first = Number.parseInt(host.split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && !host.startsWith('2001:db8:');
  }
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.');
}

export function isLanHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || ['localhost', 'example', 'test', 'invalid'].includes(host) || host.endsWith('.localhost')) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
  }
  if (isIP(host) === 6) return /^(fc|fd)/.test(host);
  return host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa') || !host.includes('.');
}

function probeTls(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error('TLS probe timed out.')), timeoutMs);
    socket.once('secureConnect', () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function errorDetail(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('timed out'))) return `Timed out after ${timeoutMs} ms.`;
  if (error instanceof Error && error.message.includes('certificate')) return 'TLS certificate validation failed.';
  return 'Connection or response check failed.';
}

export async function runDeploymentCheck(options: DeploymentOptions): Promise<DeploymentReport> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new Error('timeoutMs must be between 500 and 60000.');
  const scope = options.allowLan ? 'lan' : 'public';
  const office = deploymentOrigin(options.officeUrl, 'https:', !!options.allowLan);
  const livekit = deploymentOrigin(options.livekitUrl, 'wss:', !!options.allowLan);
  const checks: DeploymentReport['checks'] = {};
  const report: DeploymentReport = {
    checkedAt: new Date().toISOString(), networkScope: scope, officeOrigin: office?.origin ?? null,
    livekitOrigin: livekit?.origin ?? null, checks, humanAcceptance: 'not-assessed',
  };
  checks.officeHttps = office
    ? { status: 'pass', detail: `Configured with HTTPS for ${scope} scope.` }
    : { status: 'not-run', detail: 'Pass --office-url or set AGENT_OFFICE_URL/PUBLIC_SERVER_URL.' };
  checks.livekitWss = livekit
    ? { status: 'pass', detail: `Configured with WSS for ${scope} scope.` }
    : { status: 'not-run', detail: 'Pass --livekit-url or set LIVEKIT_PUBLIC_URL.' };

  const fetchImpl = options.fetchImpl ?? fetch;
  for (const [name, path, expected] of [
    ['healthz', '/healthz', 'ok'], ['readyz', '/readyz', 'ready'],
  ] as const) {
    if (!office) { checks[name] = { status: 'not-run', detail: 'No public HTTPS office origin supplied.' }; continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, office), { signal: controller.signal, redirect: 'manual' });
      const body: unknown = await response.json().catch(() => null);
      const status = body && typeof body === 'object' && 'status' in body ? body.status : undefined;
      checks[name] = response.ok && status === expected
        ? { status: 'pass', detail: `HTTP ${response.status}; ${expected}.` }
        : { status: 'fail', detail: response.status >= 300 && response.status < 400 ? `Redirected (${response.status}); supply the final office origin.` : `HTTP ${response.status}; expected ${expected}.` };
    } catch (error) {
      checks[name] = { status: 'fail', detail: errorDetail(error, timeoutMs) };
    } finally { clearTimeout(timer); }
  }

  if (!livekit) checks.livekitTls = { status: 'not-run', detail: 'No public WSS origin supplied.' };
  else {
    try {
      await (options.tlsProbe ?? probeTls)(livekit.hostname, Number(livekit.port || 443), timeoutMs);
      checks.livekitTls = { status: 'pass', detail: 'TLS handshake and certificate validation succeeded for the configured WSS host.' };
    } catch (error) { checks.livekitTls = { status: 'fail', detail: errorDetail(error, timeoutMs) }; }
  }
  return report;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return args[index + 1];
}

const AUTOMATED_CHECKS = [
  ['https', 'officeHttps'], ['health', 'healthz'], ['readiness', 'readyz'], ['wssTls', 'livekitTls'],
] as const;

/**
 * Pure merge of probe results into an acceptance record. Writes ONLY deployment.checks.{https,health,readiness,wssTls};
 * human checks (separateDevices, nearAudio, farAudio, privateRoomIsolation) and everything else are untouched.
 * A probe that did not run leaves the existing entry alone.
 */
export function recordDeploymentChecks(record: unknown, report: DeploymentReport): unknown {
  const root = structuredClone(record) as { deployment?: { networkScope?: unknown; officeUrl?: unknown; livekitUrl?: unknown; checks?: Record<string, unknown> } };
  const deployment = root?.deployment;
  if (!deployment || typeof deployment !== 'object' || !deployment.checks || typeof deployment.checks !== 'object') {
    throw new Error('Record has no deployment.checks object; create it with agent-acceptance-init first.');
  }
  if (deployment.networkScope && deployment.networkScope !== report.networkScope) {
    throw new Error(`Record networkScope (${String(deployment.networkScope)}) does not match this probe (${report.networkScope}).`);
  }
  for (const [key, origin] of [['officeUrl', report.officeOrigin], ['livekitUrl', report.livekitOrigin]] as const) {
    const recorded = deployment[key];
    if (typeof recorded === 'string' && origin && new URL(recorded).origin !== origin) {
      throw new Error(`Record deployment.${key} does not match the probed origin.`);
    }
  }
  for (const [name, source] of AUTOMATED_CHECKS) {
    const probe = report.checks[source];
    if (!probe || probe.status === 'not-run') continue;
    deployment.checks[name] = {
      result: probe.status, observedAt: report.checkedAt,
      evidence: `tools/agent-deployment-check ${source}: ${probe.detail}`,
    };
  }
  return root;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const report = await runDeploymentCheck({
    officeUrl: readOption(args, '--office-url') ?? process.env.AGENT_OFFICE_URL ?? process.env.PUBLIC_SERVER_URL,
    livekitUrl: readOption(args, '--livekit-url') ?? process.env.LIVEKIT_PUBLIC_URL,
    allowLan: args.includes('--allow-lan'),
    timeoutMs: Number(readOption(args, '--timeout-ms') ?? 8_000),
  });
  console.log(JSON.stringify(report, null, 2));
  const recordPath = readOption(args, '--record');
  if (recordPath) {
    const merged = recordDeploymentChecks(JSON.parse(await readFile(recordPath, 'utf8')) as unknown, report);
    await writeFile(recordPath, `${JSON.stringify(merged, null, 2)}\n`);
    console.error(`Recorded https/health/readiness/wssTls checks in ${recordPath}. Human checks were not modified.`);
  }
  if (Object.values(report.checks).some((check) => check.status !== 'pass')) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('/agent-deployment-check.ts') || process.argv[1]?.endsWith('/agent-deployment-check.js')) {
  await main();
}
