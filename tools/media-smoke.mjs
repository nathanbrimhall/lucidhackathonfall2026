import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const moduleName = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
const base = process.env.PUBLIC_SERVER_URL ?? 'http://localhost:2567';
assert(process.env.GUEST_INVITE_CODE, 'GUEST_INVITE_CODE is required');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const users = [];
let prototypeLayout=false;
const runId = Date.now().toString(36);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function policy(user) { return user.page.locator('#policy').textContent(); }
async function has(user, speaker) { return (await policy(user)).includes(`${speaker.identity} · distance`); }
async function volumes(user) { return user.page.locator('#audio-elements audio').evaluateAll(elements => elements.filter(el => el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0).map(el => el.volume).sort((a,b) => a-b)); }
async function attached(user) { return user.page.locator('#audio-elements audio').evaluateAll(elements => elements.filter(el => el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0).length); }
async function audioStats(user) {
  return user.page.evaluate(async () => {
    const result = [];
    for (const pc of window.__mediaSmoke.pcs) if (pc.connectionState !== 'closed') for (const stat of (await pc.getStats()).values()) if (stat.type === 'inbound-rtp' && stat.kind === 'audio') result.push({ id: stat.id, track: stat.trackIdentifier, bytes: stat.bytesReceived ?? 0, energy: stat.totalAudioEnergy ?? 0, samples: stat.totalSamplesReceived ?? 0 });
    return result;
  });
}
const connects = async user => Number(/LiveKit connects this page[^:]*: (\d+)/.exec(await policy(user))?.[1] ?? -1);
const mode = async user => /mode (\w+)/.exec(await policy(user))?.[1];
const gainOf = async (user, speaker) => (await policy(user)).split('\n').find(line => line.startsWith(`${speaker.identity} · distance`))?.split('gain ')[1];
const totalBytes = async user => (await audioStats(user)).reduce((sum, s) => sum + s.bytes, 0);
async function moveRaw(user, x, y = 3) {
  const position = () => user.page.evaluate(name => window.__mediaSmoke.positions[name], user.name);
  await user.page.locator('#map').focus();
  for (let i = 0; i < 30; i++) {
    const current = await position(); assert(current, 'Avatar not rendered');
    const dx = x - current.x, dy = y - current.y;
    if (Math.abs(dx) < .21 && Math.abs(dy) < .21) return;
    const difference = Math.abs(dy) > .21 ? dy : dx;
    const key = Math.abs(dy) > .21 ? difference > 0 ? 'ArrowDown' : 'ArrowUp' : difference > 0 ? 'ArrowRight' : 'ArrowLeft';
    await user.page.keyboard.down(key); await delay(Math.max(100, Math.min(350, Math.abs(difference) / 4 * 1000))); await user.page.keyboard.up(key); await delay(180);
  }
  throw new Error('Could not reach target through keyboard movement');
}
try {
  await until(async () => (await fetch(`${base}/media-harness/`)).ok, 'harness HTTP readiness', 120000);
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ permissions: ['microphone'] });
    await context.addInitScript(() => {
      window.__mediaSmoke = { pcs: [], positions: {} };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__mediaSmoke.pcs.push(this); } };
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) { if (String(text).startsWith('Media smoke ')) window.__mediaSmoke.positions[text] = { x: x - .35, y }; return fillText.call(this, text, x, y, ...args); };
    });
    const page = await context.newPage(); const user = { context, page, name: `Media smoke ${runId} ${index + 1}`, identity: '' }; users.push(user);
    page.on('response', async response => { if (response.url().endsWith('/api/media/token') && response.ok()) { try { user.identity = (await response.json()).mediaIdentity; } catch {} } });
    await page.goto(`${base}/media-harness/`);
    await page.locator('#name').fill(user.name); await page.locator('#invite').fill(process.env.GUEST_INVITE_CODE);
    await page.locator('#join').click();
    await until(async () => (await page.locator('#status').textContent()).startsWith('Connected as'), `user ${index + 1} connected`, 25000);
    await page.locator('#mic').click(); await until(async () => (await page.locator('#mic').textContent()) === 'Mute microphone', 'fake microphone enabled');
    await page.locator('#audio').click();
  }
  const [a,b,c] = users;
  const guestToken=await a.page.evaluate(()=>sessionStorage.getItem('media-harness.guest'));
  const identity=await(await fetch(base+'/api/sessions/current',{headers:{Authorization:'Bearer '+guestToken}})).json();
  const map=await(await fetch(base+'/api/offices/'+encodeURIComponent(identity.officeId)+'/map',{headers:{Authorization:'Bearer '+guestToken}})).json();
  prototypeLayout=map.mapId==='prototype-office';assert(prototypeLayout||map.mapId==='office','Media smoke requires a supported office layout');
  if(prototypeLayout){await moveRaw(a,20,17.8);await moveRaw(b,21,17.8);await moveRaw(c,20,18.8);}
  await until(async () => await has(a,b) && await has(a,c) && await has(b,a) && await has(b,c), 'three nearby policies');
  await until(async () => (await audioStats(b)).filter(s => s.bytes > 0 && s.energy > 0).length >= 2, 'two actual remote RTP audio streams with energy');
  await until(async () => (await volumes(a)).length === 2 && (await volumes(a)).every(value => value > .98), 'full-gain playback element volumes');
  console.log('PASS: three Chromium contexts publish fake microphones and receive RTP audio with nonzero energy.');
  await move(b, 8); await move(c, 12);
  await until(async () => await has(a,b) && !await has(a,c) && await has(b,a) && await has(b,c) && await has(c,b) && !await has(c,a), 'independent three-person distances');
  await until(async () => await attached(a) === 1 && await attached(b) === 2 && await attached(c) === 1, 'independent subscriptions');
  for (const user of users) assert.equal(await user.page.locator('#audio-elements audio').count(), await attached(user), 'detached audio elements removed');
  await until(async () => { const values = await volumes(b); return values.length === 2 && values.every(value => value > 0 && value < .8); }, 'distance falloff reaches playback element volume');
  console.log('PASS: separated A/C each subscribe only to B; B subscribes to both.');
  await a.page.locator('#mic').click(); await until(async () => !await has(b,a), 'mute policy removal');
  await a.page.locator('#mic').click(); await until(async () => await has(b,a), 'unmute policy restoration');
  await b.page.locator('#deafen').click(); await until(async () => await attached(b) === 0, 'deafen unsubscribes');
  await b.page.locator('#deafen').click(); await until(async () => await attached(b) === 2, 'undeafen restores eligible tracks');
  const beforeRepublish = await audioStats(b);
  await a.page.locator('#republish').click(); await until(async () => !await a.page.locator('#republish').isDisabled(), 'republish completes');
  await until(async () => await attached(b) === 2, 'republished microphone attached');
  await delay(1500); assert((await audioStats(b)).some(s => !beforeRepublish.some(old => old.id === s.id) && s.bytes > 0 && s.energy > 0), 'new inbound RTP track with audio energy after republish');
  console.log('PASS: mute, deafen, and microphone republish retain expected subscriptions and audio.');
  await move(c, 9.5); await until(async () => !await has(a,c), 'entry hysteresis excludes 6.5 tile speaker');
  await move(c, 8.5); await until(async () => await has(a,c), 'entry within six tiles');
  await move(c, 9.5); await until(async () => await has(a,c) && (await policy(a)).split('\n').some(line => line.startsWith(c.identity) && line.endsWith('gain 0.00')), 'retained zero-gain hysteresis band');
  await until(async () => { const values = await volumes(a); return values.length === 2 && values[0] < .01 && values[1] > .1 && values[1] < .4; }, 'zero-gain band and independent nearby playback volume');
  await move(c, 10.5); await until(async () => !await has(a,c), 'exit beyond seven tiles');
  for (const user of users) assert.match(await policy(user), /LiveKit connects this page[^:]*: 1$/m, 'movement must not reconnect LiveKit');
  console.log('PASS: entry/exit hysteresis and zero-gain band; one LiveKit connection per browser throughout movement.');
  // M3: A and B enter the east meeting room through the doorway (wall x 21-21.5, gap y 6-8); C waits on the floor just outside.
  // Walk along y=3 first to avoid the desk block at x 8-12, y 5-7.
  if(prototypeLayout){for(const [user,x,y]of [[a,27.2,12.8],[b,27.5,13.2],[c,28.5,12.8]])await moveRaw(user,x,y);}
  else for (const [user, x, y] of [[a, 18, 7], [b, 18.5, 7], [c, 19.5, 7]]) { await move(user, x, 3); await move(user, x, y); }
  await until(async () => await mode(a) === 'floor' && await has(a,b) && await has(a,c), 'floor policies at the doorway');
  const floorConnects = await connects(c);
  if(prototypeLayout){await moveRaw(a,30.6,12.8);await moveRaw(a,35,14);await moveRaw(b,30.6,12.8);await moveRaw(b,36.5,14);}
  else {await move(a, 24, 6.5); await move(b, 24, 7.5);}
  await until(async () => (await a.page.locator('#meeting').textContent()).startsWith('In ') && (await b.page.locator('#meeting').textContent()).startsWith('In '), 'meeting entered status');
  await until(async () => await mode(a) === 'meeting' && await mode(b) === 'meeting' && await gainOf(a,b) === '1.00' && await gainOf(b,a) === '1.00', 'meeting policies with each other at gain 1', 30000);
  await until(async () => await connects(a) >= 2 && await connects(b) >= 2, 'transition reconnected both meeting participants');
  await until(async () => await attached(a) === 1 && await attached(b) === 1 && (await volumes(a))[0] > .98 && (await volumes(b))[0] > .98, 'meeting playback attached at full volume');
  await until(async () => (await audioStats(a)).some(s => s.bytes > 0 && s.energy > 0) && (await audioStats(b)).some(s => s.bytes > 0 && s.energy > 0), 'inbound meeting audio energy', 30000);
  await until(async () => await mode(c) === 'floor' && !await has(c,a) && !await has(c,b) && await attached(c) === 0, 'floor listener sees neither meeting occupant');
  const cBytes = await totalBytes(c); await delay(1500);
  assert.equal(await totalBytes(c), cBytes, 'C receives no inbound RTP from meeting occupants');
  assert.equal(await connects(c), floorConnects, 'floor listener not reconnected by others entering a room');
  console.log('PASS: A and B hear each other privately in the east meeting room; floor listener C hears neither.');
  const bConnects = await connects(b);
  if(prototypeLayout){await moveRaw(a,30.7,14);await moveRaw(a,30.7,12.8);await moveRaw(a,27.2,12.8);}
  else await move(a, 18, 7);
  await until(async () => await mode(a) === 'floor' && !await has(a,b) && (await a.page.locator('#meeting').textContent()).startsWith('On the open floor'), 'A returns to floor mode');
  await until(async () => await connects(b) > bConnects && await mode(b) === 'meeting', 'B rotates epoch and stays in meeting mode', 30000);
  await until(async () => !await has(b,a) && await attached(a) <= 1, 'A and B no longer hear each other');
  console.log('PASS: A exiting returns to floor audio; B epoch-rotates within the meeting and no longer receives A.');
  // Closing the signaling transports simulates an office transport failure without stopping shared services.
  await a.context.setOffline(true);
  await until(async () => (await a.page.locator('#media-status').textContent()).startsWith('Media stopped'), 'offline fail-closed UI', 25000);
  assert.equal(await attached(a), 0, 'remote playback removed on drop');
  assert(await a.page.evaluate(() => window.__mediaSmoke.pcs.every(pc => pc.connectionState === 'closed')), 'peer connections closed after drop');
  await a.context.setOffline(false);
  console.log('PASS: network drop closes peer connections and remote playback; retry remains manual.');
  console.log('Synthetic browser media smoke passed. This does not establish human audibility or separate-device/network connectivity.');
} catch (error) {
  for (const user of users) console.log(user.name, { policy: await policy(user), audioElements: await user.page.locator('#audio-elements audio').count(), status: await user.page.locator('#status').textContent(), media: await user.page.locator('#media-status').textContent(), meeting: await user.page.locator('#meeting').textContent() });
  throw new Error(error instanceof Error ? error.message.split('\n')[0] : 'Synthetic media validation failed');
} finally {
  await Promise.allSettled(users.map(user => user.page.locator('#leave').click({ timeout: 1500 })));
  await browser.close();
}
