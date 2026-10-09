/* Telegram sign-in, trainer links and the program inbox, against the real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { boundPort, signInitData, testDb } from './helpers.mjs';
import { webhookSecret } from '../bot.js';
import { sendTelegramDocument } from '../telegram.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT = '123456:TEST-token';

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-trainer-'));
  const db = await testDb('trainer');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...db.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_USERNAME: 'openGymBot', ...env }
  });
  const h = { log: '', dataDir, db };
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

test('the bot webhook refuses anyone without the secret Telegram was told to send, and answers 200 to the real one', async t => {
  const h = await startServer(t);
  const post = (headers, body) => fetch(h.api + '/api/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const update = { message: { text: '/help', chat: { id: 5, type: 'private' }, from: { id: 5, language_code: 'az' } } };
  assert.equal((await post({}, update)).status, 403);
  assert.equal((await post({ 'X-Telegram-Bot-Api-Secret-Token': 'guess' }, update)).status, 403);
  assert.equal((await post({ 'X-Telegram-Bot-Api-Secret-Token': webhookSecret(BOT) }, update)).status, 200);
  // An update that is not a message at all is accepted and ignored, not an error.
  assert.equal((await post({ 'X-Telegram-Bot-Api-Secret-Token': webhookSecret(BOT) }, { edited_message: {} })).status, 200);
});

test('a Telegram sign-in remembers the person\'s Telegram language and refreshes it', async t => {
  const h = await startServer(t);
  const mk = lang => signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 77, first_name: 'Lang', language_code: lang })
  }, BOT);
  assert.equal((await call(h)('POST', '/api/auth/telegram', { initData: mk('az') })).status, 200);
  const langNow = async () => {
    const c = new pg.Client({ connectionString: h.db.env.DATABASE_URL });
    await c.connect();
    try { await c.query(`SET search_path TO "${h.db.env.DB_SCHEMA}"`); return (await c.query("SELECT data->'tg'->>'lang' AS l FROM users WHERE tg_id = 77")).rows[0]?.l; } finally { await c.end(); }
  };
  assert.equal(await langNow(), 'az');
  assert.equal((await call(h)('POST', '/api/auth/telegram', { initData: mk('ru') })).status, 200);
  assert.equal(await langNow(), 'ru');
});

test('the PDF drop-off: only for a signed-in Telegram profile, only a real PDF, bounded, and only to its own chat', async t => {
  const h = await startServer(t);
  const sign = async id => {
    const r = await call(h)('POST', '/api/auth/telegram', { initData: initData(id, 'Pdf' + id) });
    return call(h, r.body.token);
  };
  const pdf = '%PDF-1.4\n' + 'x'.repeat(200);
  const b64 = Buffer.from(pdf).toString('base64');
  assert.equal((await call(h)('POST', '/api/telegram/document', { data: b64 })).status, 401, 'no session');
  const ana = await sign(41);
  assert.equal((await ana('POST', '/api/telegram/document', { data: Buffer.from('not a pdf').toString('base64') })).status, 400, 'not a PDF');
  assert.equal((await ana('POST', '/api/telegram/document', {})).status, 400, 'nothing');
  // a chat id in the request is not a thing: the fake bot token means Telegram refuses, which is a 502
  const sent = await ana('POST', '/api/telegram/document', { name: '../../etc/passwd', data: b64, chat_id: 999 });
  assert.equal(sent.status, 502, 'accepted and handed to Telegram, which refuses a made-up token');
  // a dozen an hour
  let last;
  for (let i = 0; i < 12; i++) last = await ana('POST', '/api/telegram/document', { data: b64 });
  assert.equal(last.status, 429);
  // another profile has its own allowance
  const bo = await sign(42);
  assert.notEqual((await bo('POST', '/api/telegram/document', { data: b64 })).status, 429);
});

test('sendTelegramDocument posts the file as multipart to the chat it was given', async () => {
  const seen = [];
  const ok = await sendTelegramDocument('T0KEN', 77, Buffer.from('%PDF-1.4 x'), 'Plan.pdf', 'cap', async (url, init) => { seen.push({ url, form: init.body }); return { ok: true }; });
  assert.equal(ok, true);
  assert.equal(seen[0].url, 'https://api.telegram.org/botT0KEN/sendDocument');
  assert.equal(seen[0].form.get('chat_id'), '77');
  assert.equal(seen[0].form.get('caption'), 'cap');
  assert.equal(seen[0].form.get('document').name, 'Plan.pdf');
  assert.equal(await sendTelegramDocument('T0KEN', 77, Buffer.from('x'), 'a.pdf', '', async () => ({ ok: false })), false);
  assert.equal(await sendTelegramDocument('T0KEN', 77, Buffer.from('x'), 'a.pdf', '', async () => { throw new Error('net'); }), false);
  assert.equal(await sendTelegramDocument('', 77, Buffer.from('x'), 'a.pdf'), false);
});

test('the "logged" confirmation: only that message, only to the signed-in Telegram profile\'s own chat, bounded', async t => {
  const h = await startServer(t);
  const r = await call(h)('POST', '/api/auth/telegram', { initData: initData(51, 'Say') });
  const me = call(h, r.body.token);
  assert.equal((await call(h)('POST', '/api/telegram/say', { key: 'workoutLogged' })).status, 401, 'no session');
  assert.equal((await me('POST', '/api/telegram/say', { key: 'anything else' })).status, 400, 'only the one fixed message');
  assert.equal((await me('POST', '/api/telegram/say', { key: 'workoutLogged', name: 'Push', chat_id: 1 })).status, 502, 'handed to Telegram, which refuses a made-up token');
  let last;
  for (let i = 0; i < 30; i++) last = await me('POST', '/api/telegram/say', { key: 'workoutLogged', name: 'Push' });
  assert.equal(last.status, 429);
});
