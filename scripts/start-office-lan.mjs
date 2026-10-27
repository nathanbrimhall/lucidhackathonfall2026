import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isIPv4, createServer as createTcpServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createOfficeLanProxy } from './office-lan-proxy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const valueFlags = new Set(['--ip', '--hostname', '--cert', '--key', '--office-port', '--livekit-port', '--server-port', '--webhook-port', '--database', '--usage-database']);
export function isPrivateLanIp(ip) {
  const parts = ip?.split('.').map(Number) ?? [];
  return isIPv4(ip ?? '') && parts.length === 4 && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
export function certificateProblem(certificate, lanIp, hostname, now = Date.now()) {
  const x509 = new X509Certificate(certificate);
  if (!x509.checkIP(lanIp) || (hostname && !x509.checkHost(hostname, { subject: 'never' }))) return 'san';
  if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) return 'validity';
  return undefined;
}
export function parseLanArgs(args, environment = process.env) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!valueFlags.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Expected a value after ${flag ?? 'argument'}; use --help for usage.`);
    if (values[flag]) throw new Error(`Option supplied twice: ${flag}`);
    values[flag] = args[++i];
  }
  const lanIp = values['--ip'] ?? environment.OFFICE_LAN_IP;
  const hostname = values['--hostname'] ?? environment.OFFICE_LAN_HOSTNAME;
  const certPath = values['--cert'] ?? environment.OFFICE_TLS_CERT;
  const keyPath = values['--key'] ?? environment.OFFICE_TLS_KEY;
  if (!lanIp || !isPrivateLanIp(lanIp)) throw new Error('Provide --ip with a reachable private LAN IPv4 address (10/8, 172.16/12 or 192.168/16).');
  const reservedTld = hostname?.split('.').at(-1)?.toLowerCase();
  if (hostname && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(hostname) || ['localhost', 'example', 'test', 'invalid'].includes(reservedTld))) throw new Error('Provide a valid LAN DNS name with a usable certificate SAN, without a scheme or port.');
  if (!certPath || !keyPath) throw new Error('Provide --cert and --key for a certificate whose SAN covers the LAN IP and optional hostname.');
  const officePort = Number(values['--office-port'] ?? environment.OFFICE_HTTPS_PORT ?? 8443);
  const livekitPort = Number(values['--livekit-port'] ?? environment.LIVEKIT_WSS_PORT ?? 8444);
  const serverPort = Number(values['--server-port'] ?? environment.PORT ?? 2567);
  const webhookPort = Number(values['--webhook-port'] ?? environment.OFFICE_WEBHOOK_PORT ?? 7883);
  const database = values['--database'] ?? environment.DATABASE_URL ?? './data/office.sqlite';
  const usageDatabase = values['--usage-database'] ?? environment.AI_USAGE_DATABASE ?? './data/ai-usage.sqlite';
  for (const [label, file, flag] of [['database', database, '--database'], ['usage database', usageDatabase, '--usage-database']]) if (!file || file === ':memory:' || file.startsWith('/data/') || file.startsWith('/usage/')) throw new Error(`${label} must be a host-readable persistent path; use ${flag} to configure one for LAN mode.`);
  for (const [label, port] of [['office', officePort], ['LiveKit', livekitPort], ['server', serverPort], ['webhook', webhookPort]]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label} port.`);
  if (officePort === livekitPort || new Set([serverPort, officePort, livekitPort, webhookPort]).size !== 4) throw new Error('Office, LiveKit, server and webhook ports must be different.');
  if ([serverPort, officePort, livekitPort, webhookPort].some(port => [7880, 7881].includes(port))) throw new Error('Ports 7880 and 7881 are reserved for LiveKit.');
  return { lanIp, hostname, certPath: resolve(certPath), keyPath: resolve(keyPath), officePort, livekitPort, serverPort, webhookPort, databasePath: resolve(root, database), usageDatabasePath: resolve(root, usageDatabase) };
}

export function livekitLanConfig(lanIp, webhookPort = 7883) {
  return `port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: ${lanIp}\n  use_external_ip: false\nlogging:\n  level: info\nwebhook:\n  urls:\n    - http://host.docker.internal:${webhookPort}/api/livekit/webhook\n`;
}
export function composeLanOverride({ lanIp, livekitConfigPath }) {
  return `services:\n  livekit:\n    ports: !override\n      - \"127.0.0.1:7880:7880/tcp\"\n      - \"${lanIp}:7881:7881/tcp\"\n      - \"${lanIp}:7882:7882/udp\"\n    volumes: !override\n      - type: bind\n        source: ${JSON.stringify(livekitConfigPath)}\n        target: /etc/livekit.yaml\n        read_only: true\n    extra_hosts:\n      - \"host.docker.internal:host-gateway\"\n`;
}

function help() {
  console.log('Usage: node scripts/start-office-lan.mjs --ip <LAN-IPv4> --cert <cert.pem> --key <key.pem> [--hostname office.local] [--office-port 8443] [--livekit-port 8444]');
  console.log('Uses .env credentials without modifying it. Configure firewall access for 7883/TCP (signed LiveKit webhook) and 7881/TCP, 7882/UDP (media).');
}
async function preflight(config) {
  for (const [port, host] of [[config.serverPort, '127.0.0.1'], [config.officePort, config.lanIp], [config.livekitPort, config.lanIp], [config.webhookPort, '0.0.0.0']]) {
    const server = createTcpServer();
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  }
}
async function waitForServer(port, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The office server process exited before it became healthy.');
    try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }); if (response.ok) { await response.body?.cancel(); return; } await response.body?.cancel(); } catch { /* not ready yet */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error('Office server did not become healthy within 30 seconds.');
}
async function listen(server, port, host) {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen); });
}
async function main() {
  let config;
  if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg))) { help(); return; }
  try { const env = { ...parseEnv(readFileSync(resolve(root, '.env'), 'utf8')), ...process.env }; config = parseLanArgs(process.argv.slice(2), env); } catch (error) { console.error(error.message); help(); process.exitCode = 2; return; }
  if (config.help) { help(); return; }
  const certificate = readFileSync(config.certPath);
  const privateKey = readFileSync(config.keyPath);
  const secureContext = createSecureContext({ cert: certificate, key: privateKey });
  const problem = certificateProblem(certificate, config.lanIp, config.hostname);
  if (problem === 'san') throw new Error('The supplied certificate SAN must cover the LAN IP and optional hostname.');
  if (problem) throw new Error('The supplied certificate is not currently valid.');
  void secureContext;
  await preflight(config);
  const build = spawnSync(process.execPath, ['scripts/build-frontend.mjs'], { cwd: root, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Frontend build failed; LAN services were not started.');
  const envFile = resolve(root, '.env');
  const lanName = config.hostname ?? config.lanIp;
  const officeUrl = `https://${lanName}:${config.officePort}`;
  const origins = [...new Set([officeUrl, `https://${config.lanIp}:${config.officePort}`])].join(',');
  const generatedDir = resolve(root, 'data/office-lan');
  mkdirSync(generatedDir, { recursive: true });
  const livekitConfigPath = resolve(generatedDir, 'livekit.yaml');
  const overridePath = resolve(generatedDir, 'compose.override.yaml');
  const databasePath = config.databasePath;
  const usageDatabasePath = config.usageDatabasePath;
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(dirname(usageDatabasePath), { recursive: true });
  writeFileSync(livekitConfigPath, livekitLanConfig(config.lanIp, config.webhookPort), { mode: 0o600 });
  writeFileSync(overridePath, composeLanOverride({ lanIp: config.lanIp, livekitConfigPath }), { mode: 0o600 });
  const compose = spawnSync('docker', ['compose', '--project-directory', root, '--env-file', envFile, '-f', resolve(root, 'compose.yaml'), '-f', overridePath, 'up', '-d', 'livekit'], { cwd: root, stdio: 'inherit' });
  if (compose.error) throw compose.error;
  if (compose.status !== 0) throw new Error('Docker Compose could not start LiveKit.');
  const env = { ...process.env, PORT: String(config.serverPort), BIND_HOST: '127.0.0.1', DATABASE_URL: databasePath, PUBLIC_SERVER_URL: officeUrl, ALLOWED_ORIGINS: origins, LIVEKIT_PUBLIC_URL: `wss://${lanName}:${config.livekitPort}`, LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880', AI_USAGE_DATABASE: usageDatabasePath };
  const serverChild = spawn(process.execPath, ['--import', 'tsx', '--env-file-if-exists=.env', 'server/src/index.ts'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  serverChild.on('error', () => { process.exitCode = 1; void stop(); });
  serverChild.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; void stop(); } });
  const openSockets = new Set();
  let stopping = false;
  let office, livekit, webhook;
  async function stop() {
    if (stopping) return;
    stopping = true;
    office?.closeAllConnections(); livekit?.closeAllConnections(); webhook?.closeAllConnections();
    for (const socket of openSockets) socket.destroy();
    if (office?.listening) office.close(); if (livekit?.listening) livekit.close(); if (webhook?.listening) webhook.close();
    if (serverChild.exitCode === null) serverChild.kill('SIGTERM');
  }
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try {
    await waitForServer(config.serverPort, serverChild);
    const { onRequest: officeRequest, onUpgrade: officeUpgrade } = createOfficeLanProxy({ port: config.serverPort, hostname: '127.0.0.1' });
    const { onRequest: livekitRequest, onUpgrade: livekitUpgrade } = createOfficeLanProxy({ port: 7880, hostname: '127.0.0.1' });
    const webhookProxy = createOfficeLanProxy({ port: config.serverPort, hostname: '127.0.0.1' });
    office = createHttpsServer({ cert: certificate, key: privateKey }, officeRequest);
    livekit = createHttpsServer({ cert: certificate, key: privateKey }, livekitRequest);
    webhook = createHttpServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/livekit/webhook') { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found.'); return; }
      webhookProxy.onRequest(req, res);
    });
    for (const server of [office, livekit]) server.on('upgrade', (req, socket, head) => { openSockets.add(socket); socket.once('close', () => openSockets.delete(socket)); (server === office ? officeUpgrade : livekitUpgrade)(req, socket, head); });
    // Settle every bind before cleanup, so a late successful listener cannot
    // reopen after another port failed and stop() already ran.
    const listeners = await Promise.allSettled([listen(office, config.officePort, config.lanIp), listen(livekit, config.livekitPort, config.lanIp), listen(webhook, config.webhookPort, '0.0.0.0')]);
    const failed = listeners.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (error) { await stop(); throw error; }
  console.log(`Office: ${officeUrl}`);
  console.log(`LiveKit WSS: wss://${lanName}:${config.livekitPort}`);
  console.log(`LiveKit ICE: ${config.lanIp}:7881/TCP and ${config.lanIp}:7882/UDP.`);
  console.log(`Webhook receiver: POST ${config.webhookPort}/api/livekit/webhook only (signed LiveKit callbacks).`);
  console.log(`Persistent SQLite data: ${databasePath}; shared live-model usage: ${usageDatabasePath}. Ctrl+C stops the host server and TLS proxies; LiveKit remains running.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
