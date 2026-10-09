/* Telegram sign-in, trainer links and the program inbox, against the real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, signInitData, testDb } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT = '123456:TEST-token';

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-trainer-'));
  const db = await testDb('trainer');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...db.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_USERNAME: 'openGymBot', ...env }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(async () => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); await db.drop(); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  return h;
}
const call = (h, token) => async (method, p, body) => {
  const r = await fetch(h.api + p, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const initData = (id, name, start) => signInitData({
  auth_date: String(Math.floor(Date.now() / 1000)),
  user: JSON.stringify({ id, first_name: name }),
  ...(start ? { start_param: start } : {})
}, BOT);
async function signIn(h, id, name, start) {
  const r = await call(h)('POST', '/api/auth/telegram', { initData: initData(id, name, start) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, api: call(h, r.body.token) };
}

test('Telegram sign-in: bad initData refused, same Telegram id is the same account', async t => {
  const h = await startServer(t);
  assert.equal((await call(h)('POST', '/api/auth/telegram', { initData: 'hash=' + '0'.repeat(64) })).status, 401);
  const a = await signIn(h, 1001, 'Ann');
  assert.equal(a.created, true);
  const again = await signIn(h, 1001, 'Ann');
  assert.equal(again.created, false);
  assert.equal(again.user.id, a.user.id);
  assert.equal((await a.api('GET', '/api/me')).body.user.name, 'Ann');
});

test('Telegram sign-in is a 404 without a bot token', async t => {
  const h = await startServer(t, { TELEGRAM_BOT_TOKEN: '' });
  assert.equal((await call(h)('POST', '/api/auth/telegram', { initData: 'x' })).status, 404);
  assert.equal((await call(h)('GET', '/api/config')).body.telegram, undefined);
});

test('trainer links a client, assigns a program, client answers it', async t => {
  const h = await startServer(t);
  const coach = await signIn(h, 1, 'Coach');
  assert.equal((await coach.api('GET', '/api/trainer/clients')).status, 403);
  const en = await coach.api('POST', '/api/trainer/enable');
  assert.equal(en.status, 200);
  assert.match(en.body.link, /^https:\/\/t\.me\/openGymBot\?startapp=t_[a-z0-9]+$/);

  const kid = await signIn(h, 2, 'Kid', 't_' + en.body.code);
  assert.equal(kid.user.trainerId, coach.user.id);
  const stranger = await signIn(h, 3, 'Stranger');

  const list = await coach.api('GET', '/api/trainer/clients');
  assert.deepEqual(list.body.clients.map(c => c.name), ['Kid']);
  assert.equal((await coach.api('GET', '/api/trainer/client?id=' + kid.user.id)).status, 200);
  assert.equal((await coach.api('GET', '/api/trainer/client?id=' + stranger.user.id)).status, 404);

  const bundle = { routines: [{ id: 'r1', name: 'Push', ex: [{ id: 'bench', sets: 3, reps: 8 }] }], week: { 1: 'r1' }, customEx: [] };
  assert.equal((await coach.api('POST', '/api/trainer/assign', { clientId: stranger.user.id, bundle })).status, 404);
  assert.equal((await coach.api('POST', '/api/trainer/assign', { clientId: kid.user.id, bundle: { routines: [] } })).status, 400);
  assert.equal((await kid.api('POST', '/api/trainer/assign', { clientId: kid.user.id, bundle })).status, 403);
  const sent = await coach.api('POST', '/api/trainer/assign', { clientId: kid.user.id, bundle, note: 'Week 1' });
  assert.equal(sent.status, 200);

  assert.equal((await stranger.api('GET', '/api/inbox')).body.items.length, 0);
  const inbox = (await kid.api('GET', '/api/inbox')).body.items;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].note, 'Week 1');
  assert.equal(inbox[0].status, 'pending');
  assert.equal((await coach.api('GET', '/api/trainer/clients')).body.clients[0].pending, 1);
  assert.equal((await coach.api('GET', '/api/trainer/clients')).body.clients[0].accepted, 0);

  assert.equal((await stranger.api('POST', '/api/inbox/resolve', { id: inbox[0].id, status: 'accepted' })).status, 404);
  assert.equal((await kid.api('POST', '/api/inbox/resolve', { id: inbox[0].id, status: 'accepted' })).status, 200);
  assert.equal((await kid.api('POST', '/api/inbox/resolve', { id: inbox[0].id, status: 'declined' })).status, 404);
  const after = (await coach.api('GET', '/api/trainer/clients')).body.clients[0];
  assert.equal(after.pending, 0);
  assert.equal(after.accepted, 1);   // the client row's "Active" chip
});

test('trainer sees only profiles that joined them; leaving ends access; INVITE_ONLY needs a trainer link', async t => {
  const h = await startServer(t, { INVITE_ONLY: '1' });
  const refused = await call(h)('POST', '/api/auth/telegram', { initData: initData(9, 'Nobody') });
  assert.equal(refused.status, 403);

  // Bootstrap a trainer: an existing account can enable; here seed via a second instance-less path is not
  // possible on invite-only, so use the open instance for the rest.
  const h2 = await startServer(t);
  const coach = await signIn(h2, 1, 'Coach');
  const { body: { code } } = await coach.api('POST', '/api/trainer/enable');
  const kid = await signIn(h2, 2, 'Kid');
  assert.equal((await coach.api('GET', '/api/trainer/client?id=' + kid.user.id)).status, 404);
  assert.equal((await kid.api('POST', '/api/trainer/join', { code })).status, 200);
  assert.equal((await coach.api('GET', '/api/trainer/client?id=' + kid.user.id)).status, 200);
  assert.equal((await kid.api('POST', '/api/trainer/leave')).status, 200);
  assert.equal((await coach.api('GET', '/api/trainer/client?id=' + kid.user.id)).status, 404);
  // a reset code kills the old link
  const reset = await coach.api('POST', '/api/trainer/invite/reset');
  assert.notEqual(reset.body.code, code);
  assert.equal((await kid.api('POST', '/api/trainer/join', { code })).status, 400);
});
