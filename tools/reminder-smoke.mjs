import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const [mode, statePath] = process.argv.slice(2);
assert(['seed', 'verify'].includes(mode) && statePath, 'Usage: npm run smoke:reminders -- seed|verify /private/path/state.json');
const base = process.env.PUBLIC_SERVER_URL ?? 'http://localhost:2567';
const api = async (path, method = 'GET', body, token) => {
  const response = await fetch(base + path, {method, headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  assert(response.ok, `${path} failed (${response.status})`); return response.json();
};
if (mode === 'seed') {
  assert(process.env.GUEST_INVITE_CODE, 'GUEST_INVITE_CODE is required');
  const guest = await api('/api/sessions/guest', 'POST', {displayName:'Reminder smoke', inviteCode:process.env.GUEST_INVITE_CODE});
  const reminder = await api('/api/reminders', 'POST', {requestId:randomUUID(), text:`Container replacement reminder ${randomUUID()}`, dueAt:new Date(Date.now()-1000).toISOString(), timezone:'America/Denver'}, guest.token);
  writeFileSync(statePath, JSON.stringify({guest, reminder}), {mode:0o600, flag:'wx'});
  console.log('PASS: confirmed an offline reminder. Replace the server container while retaining its volume, then run verify with the same state file.');
} else {
  const {guest, reminder} = JSON.parse(readFileSync(statePath, 'utf8'));
  const before = await api('/api/reminders', 'GET', undefined, guest.token);
  assert(before.reminders.some(item => item.id === reminder.id && ['scheduled','due'].includes(item.status)), 'Reminder did not survive replacement');
  const moduleName = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
  const {chromium} = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
  const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}), args:['--no-sandbox']});
  const until = async (check, label, timeout = 15000) => {
    const start = Date.now();
    while (!await check()) { assert(Date.now()-start < timeout, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  try {
    const context = await browser.newContext();
    await context.addInitScript(token => {
      sessionStorage.setItem('media-harness.guest', token);
      window.__blockReminderAck = true;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : ArrayBuffer.isView(data) ? new TextDecoder().decode(data) : '';
        if (window.__blockReminderAck && text.includes('reminder.ack')) return;
        return send.call(this, data);
      };
    }, guest.token);
    const page = await context.newPage(); let deliveries = 0;
    page.on('websocket', socket => socket.on('framereceived', ({payload}) => { if (payload.toString().includes('reminder.due')) deliveries++; }));
    await page.goto(base + '/media-harness/'); await page.locator('#resume').click();
    const notification = page.locator('#reminder-notifications [data-notification-id]');
    await until(async () => await notification.count() === 1, 'offline reminder rendered');
    assert((await notification.textContent()).includes(reminder.text), 'Wrong reminder displayed');
    const id = await notification.getAttribute('data-notification-id');
    await until(() => deliveries >= 2, 'server at-least-once retry');
    assert.equal(await notification.count(), 1, 'Retry displayed a duplicate reminder');
    await page.evaluate(() => { window.__blockReminderAck = false; });
    await until(async () => { await new Promise(resolve => setTimeout(resolve, 750)); return (await api('/api/reminders', 'GET', undefined, guest.token)).reminders.find(item => item.id === reminder.id)?.status === 'acknowledged'; }, 'durable acknowledgement');
    // Explicitly release the seat before reload; an abrupt socket loss reserves it
    // for Colyseus reconnection, while this harness uses a fresh manual join.
    await page.locator('#leave').click();
    await page.reload();
    await page.locator('#resume').click();
    await until(async () => await notification.count() === 1, 'persisted notification restored on reload');
    assert.equal(await notification.getAttribute('data-notification-id'), id, 'Notification identity changed');
    await until(async () => (await page.locator('#status').textContent()).startsWith('Connected as'), 'saved guest resumed');
    const text = `Browser reminder ${randomUUID()}`;
    await page.locator('#reminder-text').fill(text);
    await page.locator('#reminder-timezone').fill('America/Denver');
    await page.locator('#reminder-due').fill('2030-01-15T09:00');
    await page.locator('#reminder-submit').click();
    const row = page.locator('.reminder-row').filter({hasText:text});
    await until(async () => await row.count() === 1, 'browser reminder creation');
    const created = (await api('/api/reminders', 'GET', undefined, guest.token)).reminders.find(item => item.text === text);
    assert.equal(created?.dueAt, '2030-01-15T16:00:00.000Z', 'Selected IANA timezone must determine UTC due time');
    await row.getByRole('button', {name:'Edit / reschedule'}).click();
    await page.locator('#reminder-text').fill(`${text} revised`);
    await page.locator('#reminder-due').fill('2030-01-16T09:00');
    await page.locator('#reminder-submit').click();
    const edited = page.locator('.reminder-row').filter({hasText:`${text} revised`});
    await until(async () => await edited.count() === 1, 'browser rescheduling');
    await edited.getByRole('button', {name:'Cancel', exact:true}).click();
    await until(async () => (await edited.textContent())?.includes('canceled'), 'browser cancellation');
    if (process.env.REMINDER_SMOKE_SCREENSHOT) await page.locator('#reminder-panel').screenshot({path:process.env.REMINDER_SMOKE_SCREENSHOT});
    console.log('PASS: offline reminder survived container replacement, repeated private delivery rendered once, acknowledgement persisted, and notification restored once on reload.');
    console.log('PASS: browser creates, edits, reschedules and cancels a reminder with selected-zone UTC conversion.');
  } finally { await browser.close(); }
}
