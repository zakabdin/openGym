/* The operator's admin site (/admin, api/admin-site.js), against the real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, testDb } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const CREDS = { ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'a long enough admin passphrase' };
const NOW = new Date().toISOString();

async function start(t, { env = CREDS, users = [], states = {}, assignments = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-adminsite-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const db = await testDb('adm');
  await db.seed({ users, states, assignments });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...db.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env }
  });
  const h = { log: '', db };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(async () => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); await db.drop(); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.req = async (method, p, { body, cookie, csrf, headers } = {}) => {
    const r = await fetch(h.api + p, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body && JSON.stringify(body)
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: r.status, json, text, headers: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  h.login = async () => {
    const r = await h.req('POST', '/admin/api/login', { body: { username: CREDS.ADMIN_USERNAME, password: CREDS.ADMIN_PASSWORD } });
    assert.equal(r.status, 200, r.text);
    const page = await h.req('GET', '/admin/overview', { cookie: r.cookie });
    return { cookie: r.cookie, csrf: /name="csrf" content="([^"]+)"/.exec(page.text)[1] };
  };
  return h;
}
const user = (id, name, extra = {}) => ({ id, name, created: NOW, ...extra });

test('there is no admin site while ADMIN_USERNAME / ADMIN_PASSWORD are unset', async t => {
  const h = await start(t, { env: {} });
  assert.equal((await h.req('GET', '/admin')).status, 404);
  assert.equal((await h.req('GET', '/admin/login')).status, 404);
  assert.equal((await h.req('POST', '/admin/api/login', { body: { username: 'x', password: 'y' } })).status, 404);
});

test('pages and data need a session; a wrong password is refused and counted', async t => {
  const h = await start(t);
  const r = await h.req('GET', '/admin/users');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/login');
  assert.equal((await h.req('GET', '/admin/api/users')).status, 401);
  assert.equal((await h.req('GET', '/admin/login')).status, 200);
  const bad = await h.req('POST', '/admin/api/login', { body: { username: 'boss', password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.cookie, '');
  await new Promise(r => setTimeout(r, 150));   // the audit row lands just after the answer
  const rows = await h.db.audit();
  assert.ok(rows.some(x => x.ev === 'admin.site.login' && x.ok === false));
});

test('signing in gives a locked-down session cookie and the pages', async t => {
  const h = await start(t, { users: [user('u1', 'Ana')] });
  const ok = await h.req('POST', '/admin/api/login', { body: { username: 'boss', password: CREDS.ADMIN_PASSWORD } });
  assert.equal(ok.status, 200);
  const raw = ok.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Path=\/admin/);
  const page = await h.req('GET', '/admin/users', { cookie: ok.cookie });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal((await h.req('GET', '/admin/api/users', { cookie: ok.cookie })).status, 200);
});

test('a cookie of the app is not an admin session, and a tampered one is refused', async t => {
  const h = await start(t, { users: [user('u1', 'Ana')] });
  const payload = `u1:${Date.now() + 86400000}:0`;
  const appCookie = payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  assert.equal((await h.req('GET', '/admin/api/users', { cookie: `og_admin=${appCookie}` })).status, 401);
  const { cookie } = await h.login();
  assert.equal((await h.req('GET', '/admin/api/users', { cookie: cookie.slice(0, -2) + 'xx' })).status, 401);
});

test('the user list: search, role filter, workouts and the trainer link', async t => {
  const h = await start(t, {
    users: [
      user('t1', 'Coach Kim', { role: 'trainer', tg: { id: 11, username: 'coachkim' } }),
      user('c1', 'Sam', { trainerId: 't1', tg: { id: 12 } }),
      user('x1', 'Zoe', { disabled: true })
    ],
    states: { c1: { _rev: 2, _ts: Date.now(), workouts: [{ d: '2026-10-01', name: 'Leg' }, 7, { d: '2026-10-05', name: 'Push' }] } }
  });
  const { cookie } = await h.login();
  const list = q => h.req('GET', '/admin/api/users' + q, { cookie }).then(r => r.json);
  const all = await list('');
  assert.equal(all.total, 3);
  const sam = all.items.find(u => u.id === 'c1');
  assert.equal(sam.workouts, 2);
  assert.equal(sam.lastWorkout, '2026-10-05');
  assert.equal(sam.trainerName, 'Coach Kim');
  assert.equal(all.items.find(u => u.id === 't1').clients, 1);
  assert.deepEqual((await list('?q=coachkim')).items.map(u => u.id), ['t1']);
  assert.deepEqual((await list('?q=12')).items.map(u => u.id), ['c1']);
  assert.deepEqual((await list('?role=trainer')).items.map(u => u.id), ['t1']);
  assert.deepEqual((await list('?role=client')).items.map(u => u.id), ['c1']);
  assert.deepEqual((await list('?role=disabled')).items.map(u => u.id), ['x1']);
  assert.equal((await list("?q=%25")).total, 0, 'a % in the search is a character, not a wildcard');
  const one = (await h.req('GET', '/admin/api/user?id=c1', { cookie })).json;
  assert.equal(one.workouts.length, 2);
  assert.equal(one.workouts[0].d, '2026-10-05');
  assert.equal((await h.req('GET', '/admin/api/user?id=nobody', { cookie })).status, 404);
  const ov = (await h.req('GET', '/admin/api/overview', { cookie })).json;
  assert.equal(ov.users, 3); assert.equal(ov.trainers, 1); assert.equal(ov.clients, 1); assert.equal(ov.workouts, 2);
});

test('disable and delete need the CSRF token, the app origin, and do what the app does', async t => {
  const h = await start(t, {
    users: [user('u1', 'Ana', { tg: { id: 5 } })],
    states: { u1: { _rev: 1, workouts: [] } }
  });
  const { cookie, csrf } = await h.login();
  const body = { id: 'u1', disabled: true };
  assert.equal((await h.req('POST', '/admin/api/user/disable', { body, cookie })).status, 403, 'no token');
  assert.equal((await h.req('POST', '/admin/api/user/disable', { body, cookie, csrf: 'forged' })).status, 403, 'wrong token');
  assert.equal((await h.req('POST', '/admin/api/user/disable', { body, cookie, csrf, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-site');
  assert.equal((await h.db.user('u1')).disabled, undefined);

  const dis = await h.req('POST', '/admin/api/user/disable', { body, cookie, csrf });
  assert.equal(dis.status, 200, dis.text);
  assert.equal((await h.db.user('u1')).disabled, true);
  const en = await h.req('POST', '/admin/api/user/disable', { body: { id: 'u1', disabled: false }, cookie, csrf });
  assert.equal(en.json.disabled, false);

  assert.equal((await h.req('POST', '/admin/api/user/delete', { body: { id: 'nobody' }, cookie, csrf })).status, 404);
  const del = await h.req('POST', '/admin/api/user/delete', { body: { id: 'u1' }, cookie, csrf });
  assert.equal(del.status, 200, del.text);
  assert.equal(await h.db.user('u1'), null);
  assert.equal(await h.db.state('u1'), null, 'the training history goes with the profile');
  await new Promise(r => setTimeout(r, 150));
  const evs = (await h.db.audit()).map(x => x.ev);
  for (const ev of ['admin.site.login', 'admin.user.disable', 'admin.user.enable', 'admin.user.delete']) assert.ok(evs.includes(ev), ev);
});

test('the activity log pages and filters, and signing out ends the session', async t => {
  const h = await start(t);
  const { cookie, csrf } = await h.login();
  await h.req('POST', '/admin/api/login', { body: { username: 'boss', password: 'wrong' } });
  await new Promise(r => setTimeout(r, 150));
  const fails = (await h.req('GET', '/admin/api/audit?cat=fail', { cookie })).json;
  assert.ok(fails.events.length >= 1 && fails.events.every(e => e.ok === false));
  const admin = (await h.req('GET', '/admin/api/audit?cat=admin', { cookie })).json;
  assert.ok(admin.events.every(e => e.ev.startsWith('admin.')));
  const out = await h.req('POST', '/admin/api/logout', { body: {}, cookie, csrf });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('repeated wrong passwords pause sign-in, even for the right password', async t => {
  const h = await start(t);
  let last;
  for (let i = 0; i < 8; i++) last = await h.req('POST', '/admin/api/login', { body: { username: 'boss', password: 'wrong' + i } });
  assert.equal(last.status, 429);
  const right = await h.req('POST', '/admin/api/login', { body: { username: 'boss', password: CREDS.ADMIN_PASSWORD } });
  assert.equal(right.status, 429);
});

test('a workout start is logged once per workout, and shows on the user page and the Workouts filter', async t => {
  const h = await start(t, { users: [user('u1', 'Ana'), user('u2', 'Bo')] });
  const mint = uid => { const p = `${uid}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };
  const beat = (uid, body) => h.req('POST', '/api/activity', { body: { active: true, exIdx: 0, exTotal: 5, setsDone: 0, setsTotal: 15, ...body }, cookie: mint(uid) });
  const first = Date.now() - 60000;
  assert.equal((await beat('u1', { name: 'Leg Day', startedAt: first })).status, 200);
  assert.equal((await beat('u1', { name: 'Leg Day', startedAt: first, setsDone: 3 })).status, 200);   // same workout, still on screen
  assert.equal((await beat('u1', { name: 'Leg Day', startedAt: first, setsDone: 6 })).status, 200);
  assert.equal((await beat('u2', { name: 'Push', startedAt: first })).status, 200);
  assert.equal((await beat('u1', { name: 'Pull', startedAt: first + 3600000 })).status, 200);         // a second workout
  await new Promise(r => setTimeout(r, 200));
  const starts = (await h.db.audit()).filter(x => x.ev === 'workout.started');
  assert.deepEqual(starts.map(x => `${x.name}:${x.msg}`), ['Ana:Leg Day', 'Bo:Push', 'Ana:Pull']);

  const { cookie } = await h.login();
  const mine = (await h.req('GET', '/admin/api/user?id=u1', { cookie })).json;
  assert.deepEqual(mine.events.filter(e => e.ev === 'workout.started').map(e => e.msg).sort(), ['Leg Day', 'Pull']);
  assert.ok(mine.events.every(e => e.uid === 'u1' || e.tgt === 'u1'), 'only this profile’s events');
  const wk = (await h.req('GET', '/admin/api/audit?cat=workout', { cookie })).json;
  assert.equal(wk.events.length, 3);
  assert.equal((await h.req('GET', '/admin/api/audit?cat=workout&uid=u2', { cookie })).json.events.length, 1);
});

test('reset data empties a profile for a fresh start, stamps it so devices follow, and keeps the account', async t => {
  const h = await start(t, {
    users: [user('u1', 'Ana', { tg: { id: 5 }, trainerId: 't1' }), user('t1', 'Coach', { role: 'trainer' })],
    states: { u1: { _rev: 7, lang: 'de', langAuto: false, workouts: [{ d: '2026-10-01', id: 'w1', entries: [] }], routines: [{ id: 'r1', name: 'Push', ex: [] }], week: { 1: ['r1'] }, bodyweight: [{ d: '2026-10-01', w: 80 }] } }
    ,
    assignments: { u1: [{ id: 'a1', from: 't1', status: 'pending', bundle: { routines: [] }, created: Date.now() }] }
  });
  assert.equal((await h.db.assignments('u1')).length, 1);
  const { cookie, csrf } = await h.login();
  const body = { id: 'u1' };
  assert.equal((await h.req('POST', '/admin/api/user/reset', { body })).status, 401, 'no session');
  assert.equal((await h.req('POST', '/admin/api/user/reset', { body, cookie })).status, 403, 'no token');
  assert.equal((await h.req('POST', '/admin/api/user/reset', { body: { id: 'nobody' }, cookie, csrf })).status, 404);
  assert.equal((await h.db.state('u1')).workouts.length, 1, 'nothing happened yet');

  const before = Date.now();
  const r = await h.req('POST', '/admin/api/user/reset', { body, cookie, csrf });
  assert.equal(r.status, 200, r.text);
  const s = await h.db.state('u1');
  assert.deepEqual(Object.keys(s).sort(), ['_rev', 'lang', 'langAuto', 'resetAt']);
  assert.equal(s._rev, 8, 'the revision moves on, so every device pulls it');
  assert.ok(s.resetAt >= before, 'stamped now');
  assert.equal(s.resetIds, undefined, 'no id list: a device that missed the reset keeps only what it made after the stamp');
  assert.equal(s.langAuto, true, 'the language is chosen afresh, as for a new profile');
  const u = await h.db.user('u1');
  assert.equal(u.name, 'Ana'); assert.equal(u.tg.id, 5); assert.equal(u.trainerId, 't1');   // the account stays
  assert.deepEqual(await h.db.assignments('u1'), [], 'the inbox is empty');
  await new Promise(r => setTimeout(r, 150));
  assert.ok((await h.db.audit()).some(x => x.ev === 'admin.user.reset'));

  // A second reset moves the stamp forward, never back.
  const again = await h.req('POST', '/admin/api/user/reset', { body, cookie, csrf });
  assert.equal(again.status, 200);
  const s2 = await h.db.state('u1');
  assert.ok(s2.resetAt > s.resetAt); assert.equal(s2._rev, 9);
});

test('reset data also works for a profile that never synced a document', async t => {
  const h = await start(t, { users: [user('u2', 'Bo')] });
  const { cookie, csrf } = await h.login();
  assert.equal((await h.req('POST', '/admin/api/user/reset', { body: { id: 'u2' }, cookie, csrf })).status, 200);
  const s = await h.db.state('u2');
  assert.equal(s._rev, 1); assert.ok(s.resetAt > 0);
});
