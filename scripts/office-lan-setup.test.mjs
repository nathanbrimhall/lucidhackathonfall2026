import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { joinSheet, listLanCandidates, parseSetupArgs, runSetup } from './office-lan-setup.mjs';

const nic = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'office-setup-')); dirs.push(dir); return dir; };
const options = (extra = {}) => ({ ...parseSetupArgs([]), ...extra });

describe('LAN candidate discovery', () => {
  it('keeps private non-VPN IPv4 and labels the interface', () => {
    const found = listLanCandidates({
      lo0: [nic('127.0.0.1', { internal: true })],
      en0: [nic('10.1.2.3'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      en1: [nic('172.31.0.5'), nic('172.32.0.5'), nic('8.8.8.8')],
      utun3: [nic('10.9.9.9')], ipsec0: [nic('192.168.5.5')], ppp0: [nic('10.0.0.9')], tun0: [nic('10.0.0.8')], tap0: [nic('10.0.0.7')], wg0: [nic('10.0.0.6')],
      eth1: [nic('192.168.1.20', { family: 4 })],
    });
    expect(found).toEqual([{ name: 'en0', address: '10.1.2.3' }, { name: 'en1', address: '172.31.0.5' }, { name: 'eth1', address: '192.168.1.20' }]);
  });
});

describe('setup flow', () => {
  const failingRun = () => { throw new Error('mkcert must not run'); };
  it('errors with no candidates', () => {
    const result = runSetup(options(), { interfaces: { lo0: [nic('127.0.0.1', { internal: true })] }, run: failingRun, rootDir: tmp() });
    expect(result.code).toBe(2);
    expect(result.lines.join('\n')).toContain('No private LAN IPv4');
  });

  it('refuses to guess between several candidates and lists them', () => {
    const result = runSetup(options(), { interfaces: { en0: [nic('10.1.2.3')], en1: [nic('192.168.1.9')] }, run: failingRun, rootDir: tmp() });
    expect(result.code).toBe(2);
    const text = result.lines.join('\n');
    expect(text).toContain('--ip');
    expect(text).toContain('10.1.2.3  (en0)');
    expect(text).toContain('192.168.1.9  (en1)');
  });

  it('reports install instructions when mkcert is missing', () => {
    const result = runSetup(options({ ip: '192.168.1.9' }), { interfaces: {}, run: () => ({ error: { code: 'ENOENT' } }), rootDir: tmp() });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('brew install mkcert');
  });

  it('invokes mkcert with the IP and hostname, writes the join sheet and prints next commands', () => {
    const rootDir = tmp(); const calls = [];
    const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: args[0] === '-CAROOT' ? '/ca/root\n' : '' }; };
    const result = runSetup(options({ ip: '192.168.1.9', hostname: 'office.lan' }), { interfaces: {}, run, rootDir });
    expect(result.code).toBe(0);
    expect(calls[1]).toEqual(['mkcert', '-cert-file', join(rootDir, 'data/office-lan/certs/office.pem'), '-key-file', join(rootDir, 'data/office-lan/certs/office-key.pem'), '192.168.1.9', 'office.lan']);
    const text = result.lines.join('\n');
    expect(text).toContain('npm run office:lan -- --ip 192.168.1.9 --hostname office.lan --cert data/office-lan/certs/office.pem --key data/office-lan/certs/office-key.pem');
    expect(text).toContain('agent:deployment-check -- --allow-lan --office-url "https://office.lan:8443"');
    expect(readFileSync(join(rootDir, 'data/office-lan/JOIN.md'), 'utf8')).toContain('https://office.lan:8443');
  });
});

describe('join sheet', () => {
  const sheet = joinSheet({ officeUrl: 'https://192.168.1.9:8443', rootCaPath: '/ca/root/rootCA.pem' });
  it('contains the URL, the root CA path and the guidance', () => {
    expect(sheet).toContain('https://192.168.1.9:8443');
    expect(sheet).toContain('/ca/root/rootCA.pem');
    expect(sheet).toContain('github.com/FiloSottile/mkcert');
    expect(sheet).toMatch(/microphone/);
    expect(sheet).toMatch(/localhost/);
    expect(sheet).toMatch(/invite code privately/);
  });
  it('names key files only as things never to share', () => {
    for (const line of sheet.split('\n').filter(l => /rootCA-key\.pem|office-key\.pem/.test(l))) expect(line).toMatch(/Never share/);
    expect(sheet).not.toMatch(/\/[^\s]*(rootCA-key|office-key)\.pem/);
  });
});
