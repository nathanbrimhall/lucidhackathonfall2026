import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { certificateProblem, isPrivateLanIp, parseLanArgs } from './start-office-lan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const valueFlags = new Set(['--ip', '--hostname', '--cert-dir', '--office-port']);
const vpnInterface = /^(utun|ipsec|ppp|tun|tap|wg)/i;
const quote = text => /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

export function parseSetupArgs(args) {
  const values = {};
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--force') { force = true; continue; }
    if (!valueFlags.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Expected a value after ${flag ?? 'argument'}; use --help for usage.`);
    if (values[flag]) throw new Error(`Option supplied twice: ${flag}`);
    values[flag] = args[++i];
  }
  const officePort = Number(values['--office-port'] ?? 8443);
  if (!Number.isInteger(officePort) || officePort < 1 || officePort > 65535) throw new Error('Invalid office port.');
  return { ip: values['--ip'], hostname: values['--hostname'], certDir: values['--cert-dir'] ?? 'data/office-lan/certs', officePort, force };
}

// Pure: networkInterfaces()-shaped input -> [{ name, address }] of private, non-VPN, non-internal IPv4 addresses.
export function listLanCandidates(interfaces) {
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    if (vpnInterface.test(name)) continue;
    for (const entry of addresses ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && isPrivateLanIp(entry.address)) found.push({ name, address: entry.address });
    }
  }
  return found;
}

export function joinSheet({ officeUrl, rootCaPath }) {
  return `# Join the office

Office address: ${officeUrl}

Open exactly this address. Do not use localhost, and do not use a different address for the host laptop.

## 1. Trust the host's certificate authority (once per device)

The host will send you one file: \`${rootCaPath}\` (the public root certificate, rootCA.pem).
Install it and trust it, then fully restart your browser. mkcert's instructions: https://github.com/FiloSottile/mkcert#installing-the-ca-on-other-systems

- macOS: open the file in Keychain Access, add it to the System keychain, open it, expand Trust and choose Always Trust.
- Windows: double-click the file, choose Install Certificate, Local Machine, place it in Trusted Root Certification Authorities.
- Linux: copy it to /usr/local/share/ca-certificates/ as a .crt file and run \`sudo update-ca-certificates\`. Firefox keeps its own trust store (Settings, Privacy & Security, View Certificates, Authorities, Import).
- iOS: AirDrop or email the file, install the profile, then enable it under Settings, General, About, Certificate Trust Settings.
- Android: Settings, Security, Install a certificate, CA certificate.

Only trust rootCA.pem from the host. Never share rootCA-key.pem or office-key.pem; they stay on the host laptop and must not be sent to anyone.

## 2. Join

1. Open the office address above in your browser.
2. Enter your display name.
3. Get the invite code privately from the host (not in a group chat or this sheet).
4. Allow the microphone when the browser asks.

Both of you must be on the same network; guest Wi-Fi may block device-to-device traffic.
`;
}

const mkcertHelp = 'mkcert is not installed. Install it, then re-run:\n  brew install mkcert\n  mkcert -install';

// deps: { interfaces, run(cmd, args) -> { status, stdout, error }, rootDir }. Returns { code, lines }.
export function runSetup(options, deps = {}) {
  const { interfaces = networkInterfaces(), run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }), rootDir = root } = deps;
  const lines = [];
  const fail = (...messages) => ({ code: 2, lines: [...lines, ...messages] });
  const candidates = listLanCandidates(interfaces);
  let ip = options.ip;
  if (!ip) {
    if (candidates.length === 0) return fail('No private LAN IPv4 address found (VPN, tunnel and loopback interfaces are ignored). Connect to the LAN, or pass --ip explicitly.');
    if (candidates.length > 1) return fail('Several candidate LAN addresses found; choose one with --ip:', ...candidates.map(c => `  ${c.address}  (${c.name})`));
    ip = candidates[0].address;
    lines.push(`Using ${ip} (${candidates[0].name}).`);
  }
  const certDir = resolve(rootDir, options.certDir);
  const certPath = join(certDir, 'office.pem');
  const keyPath = join(certDir, 'office-key.pem');
  try { parseLanArgs(['--ip', ip, ...options.hostname ? ['--hostname', options.hostname] : [], '--cert', certPath, '--key', keyPath], {}); } catch (error) { return fail(error.message); }
  const caRoot = run('mkcert', ['-CAROOT']);
  if (caRoot.error || caRoot.status !== 0 || !caRoot.stdout?.trim()) return { code: 1, lines: [...lines, mkcertHelp] };
  const rootCaPath = join(caRoot.stdout.trim(), 'rootCA.pem');
  const haveCert = existsSync(certPath), haveKey = existsSync(keyPath);
  let reuse = false;
  if ((haveCert || haveKey) && !options.force) {
    const problem = haveCert && haveKey ? certificateProblem(readFileSync(certPath), ip, options.hostname) : 'incomplete';
    if (problem) return fail(`Existing certificate in ${options.certDir} is unusable (${problem === 'san' ? `its SAN does not cover ${[ip, options.hostname].filter(Boolean).join(' / ')}` : problem === 'validity' ? 'not currently valid' : 'cert/key pair incomplete'}). Re-run with --force to regenerate it.`);
    reuse = true;
    lines.push(`Reusing existing certificate ${certPath}.`);
  }
  if (!reuse) {
    mkdirSync(certDir, { recursive: true });
    const made = run('mkcert', ['-cert-file', certPath, '-key-file', keyPath, ip, ...options.hostname ? [options.hostname] : []]);
    if (made.error || made.status !== 0) return { code: 1, lines: [...lines, made.error?.code === 'ENOENT' ? mkcertHelp : 'mkcert failed to create the certificate.'] };
    lines.push(`Created certificate ${certPath}.`);
  }
  const officeUrl = `https://${options.hostname ?? ip}:${options.officePort}`;
  const joinPath = resolve(rootDir, 'data/office-lan/JOIN.md');
  mkdirSync(dirname(joinPath), { recursive: true });
  writeFileSync(joinPath, joinSheet({ officeUrl, rootCaPath }));
  const show = file => quote(file.startsWith(rootDir) ? file.slice(rootDir.length + 1) : file);
  lines.push(
    `Join sheet written to ${joinPath}. Send it with ${rootCaPath} (that file only) to collaborators; give the invite code privately.`,
    'Never share rootCA-key.pem or office-key.pem.',
    '', 'Start the office:',
    `  npm run office:lan -- --ip ${ip}${options.hostname ? ` --hostname ${options.hostname}` : ''} --cert ${show(certPath)} --key ${show(keyPath)}${options.officePort === 8443 ? '' : ` --office-port ${options.officePort}`}`,
    '', 'Then verify from a machine that can reach the laptop:',
    `  NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" npm run agent:deployment-check -- --allow-lan --office-url "${officeUrl}" --livekit-url "wss://${options.hostname ?? ip}:8444"`);
  return { code: 0, lines };
}

function help() {
  console.log('Usage: node scripts/office-lan-setup.mjs [--ip <LAN-IPv4>] [--hostname office.local] [--cert-dir data/office-lan/certs] [--office-port 8443] [--force]');
  console.log('Lists LAN candidates (requires --ip when several), creates/reuses an mkcert certificate and writes data/office-lan/JOIN.md.');
}
function main() {
  let options;
  try { options = parseSetupArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); help(); process.exitCode = 2; return; }
  if (options.help) { help(); return; }
  const { code, lines } = runSetup(options);
  for (const line of lines) (code ? console.error : console.log)(line);
  process.exitCode = code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
