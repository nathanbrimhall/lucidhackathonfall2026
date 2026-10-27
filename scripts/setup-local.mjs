import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const file = new URL('../.env', import.meta.url);
if (existsSync(file)) {
  console.log('Existing .env preserved. No values changed.');
} else {
  let text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const values = {
    SESSION_SECRET: randomBytes(32).toString('hex'),
    LIVEKIT_API_SECRET: randomBytes(32).toString('hex'),
    AI_WORKER_SECRET: randomBytes(32).toString('hex'),
    GUEST_INVITE_CODE: randomBytes(12).toString('hex'),
    DATABASE_URL: './data/office.sqlite',
    LIVEKIT_INTERNAL_URL: 'http://localhost:7880',
    AI_SERVER_URL: 'http://localhost:2567',
  };
  for (const [key, value] of Object.entries(values)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  console.log('Created git-ignored .env for local Node development with fresh secrets. AI remains disabled until a provider key is configured.');
}
