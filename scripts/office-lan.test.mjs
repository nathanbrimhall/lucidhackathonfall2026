import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeLanOverride, livekitLanConfig, parseLanArgs } from './start-office-lan.mjs';
import { createOfficeLanProxy } from './office-lan-proxy.mjs';

const servers = new Set();
const upgradedSockets = new Set();
async function listen(server) { servers.add(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
afterEach(async () => { for (const socket of upgradedSockets) socket.destroy(); upgradedSockets.clear(); await Promise.all([...servers].map(server => new Promise(resolve => server.close(() => resolve())))); servers.clear(); });

describe('LAN office launcher configuration', () => {
  it('requires an explicit LAN IPv4 and supplied certificate and key', () => {
    expect(() => parseLanArgs(['--cert', 'office.crt', '--key', 'office.key'])).toThrow('--ip');
    expect(() => parseLanArgs(['--ip', '127.0.0.1', '--cert', 'office.crt', '--key', 'office.key'])).toThrow('LAN IPv4');
    expect(() => parseLanArgs(['--ip', '192.168.1.10'])).toThrow('--cert and --key');
  });

  it('uses separate ports and explicit LAN ICE advertisement with external discovery disabled', () => {
    const options = parseLanArgs(['--ip', '192.168.1.10', '--hostname', 'office.local', '--cert', 'office.crt', '--key', 'office.key']);
    expect(options.officePort).toBe(8443);
    expect(options.livekitPort).toBe(8444);
    expect(livekitLanConfig(options.lanIp, options.webhookPort)).toContain('node_ip: 192.168.1.10\n  use_external_ip: false');
    expect(livekitLanConfig(options.lanIp, options.webhookPort)).toContain('host.docker.internal:7883/api/livekit/webhook');
    const override = composeLanOverride({ lanIp: options.lanIp, livekitConfigPath: '/tmp/lucid office/livekit.yaml' });
    expect(override).toContain('192.168.1.10:7881:7881/tcp');
    expect(override).toContain('192.168.1.10:7882:7882/udp');
    expect(override).toContain('source: "/tmp/lucid office/livekit.yaml"');
    expect(override).toContain('host.docker.internal:host-gateway');
  });

  it('rejects a shared public server port that would collide with a proxy port', () => {
    expect(() => parseLanArgs(['--ip', '192.168.1.10', '--cert', 'a', '--key', 'b', '--server-port', '8443'])).toThrow('must be different');
    expect(() => parseLanArgs(['--ip', '192.168.1.10', '--cert', 'a', '--key', 'b', '--webhook-port', '7881'])).toThrow('reserved for LiveKit');
  });

  it('preserves the configured host database and shared usage database paths', () => {
    const options = parseLanArgs(['--ip', '192.168.1.10', '--cert', 'a', '--key', 'b'], { DATABASE_URL: './data/office.sqlite', AI_USAGE_DATABASE: './data/ai-usage.sqlite' });
    expect(options.databasePath).toBe(resolve('data/office.sqlite'));
    expect(options.usageDatabasePath).toBe(resolve('data/ai-usage.sqlite'));
    expect(() => parseLanArgs(['--ip', '192.168.1.10', '--cert', 'a', '--key', 'b'], { DATABASE_URL: '/data/office.sqlite', AI_USAGE_DATABASE: '/usage/ai-usage.sqlite' })).toThrow('host-readable persistent path');
    const explicit = parseLanArgs(['--ip', '192.168.1.10', '--cert', 'a', '--key', 'b', '--database', './data/shared-office.sqlite', '--usage-database', './data/shared-usage.sqlite'], {});
    expect(explicit.databasePath).toBe(resolve('data/shared-office.sqlite'));
    expect(explicit.usageDatabasePath).toBe(resolve('data/shared-usage.sqlite'));
  });
});

describe('LAN reverse proxy', () => {
  it('forwards HTTP request body, status and forwarded headers', async () => {
    const upstream = createHttpServer((req, res) => { let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, method: req.method, body, proto: req.headers['x-forwarded-proto'], host: req.headers['x-forwarded-host'] })); }); });
    const upstreamPort = await listen(upstream);
    const handlers = createOfficeLanProxy({ port: upstreamPort });
    const proxy = createHttpServer(handlers.onRequest); proxy.on('upgrade', handlers.onUpgrade);
    const proxyPort = await listen(proxy);
    const result = await new Promise((resolve, reject) => { const req = httpRequest({ hostname: '127.0.0.1', port: proxyPort, path: '/api/check?x=1', method: 'POST', headers: { host: 'office.local:8443' } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end('fixture-body'); });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ path: '/api/check?x=1', method: 'POST', body: 'fixture-body', proto: 'https', host: 'office.local:8443' });
  });

  it('forwards a WebSocket upgrade and pipes the upgraded connection', async () => {
    const upstream = createHttpServer();
    let upstreamClosed;
    const upstreamDidClose = new Promise(resolve => { upstreamClosed = resolve; });
    upstream.on('upgrade', (_req, socket) => { upgradedSockets.add(socket); socket.on('close', () => { upgradedSockets.delete(socket); upstreamClosed(); }); socket.on('end', () => socket.end()); socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Fixture: yes\r\n\r\n'); socket.write('fixture-ws-ready'); });
    const upstreamPort = await listen(upstream);
    const handlers = createOfficeLanProxy({ port: upstreamPort });
    const proxy = createHttpServer(handlers.onRequest); proxy.on('upgrade', (req,socket,head)=>{upgradedSockets.add(socket);socket.on('close',()=>upgradedSockets.delete(socket));handlers.onUpgrade(req,socket,head);});
    const proxyPort = await listen(proxy);
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(proxyPort, '127.0.0.1'); let data = '';
      upgradedSockets.add(socket);socket.on('close',()=>upgradedSockets.delete(socket));
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket proxy response timed out')); }, 2000);
      socket.on('connect', () => socket.write('GET /rtc HTTP/1.1\r\nHost: office.local:8444\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
      socket.on('data', chunk => { data += chunk.toString('latin1'); if (data.includes('fixture-ws-ready')) { clearTimeout(timer); socket.destroy(); resolve(data); } });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
    });
    expect(response).toContain('HTTP/1.1 101 Switching Protocols');
    expect(response).toContain('X-Fixture: yes');
    expect(response).toContain('fixture-ws-ready');
    await expect(Promise.race([upstreamDidClose, new Promise((_,reject)=>setTimeout(()=>reject(new Error('Upstream WebSocket stayed open after client disconnect')),2000))])).resolves.toBeUndefined();
  });
});
