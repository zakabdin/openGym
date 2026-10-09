/* This file used to pin the bounds of the stat cache of parsed state documents (64 users, a TTL)
   that sat behind GET /api/data/rev, the reminder tick and the push routes. The cache is gone:
   the database is read on every request and nothing is held in memory between them, so there is
   nothing to bound. What replaces the two bounds is the property they existed for -- many
   profiles must not cost the process memory or staleness:

   - a revision poll answers from the `rev` column of the profile's row for any number of
     profiles, and always with the current value (no entry to evict, no TTL to outlive);
   - the reminder query returns the `reminder` block of the profiles that asked for one and have a
     push subscription, one small object each, never the documents. */
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
const PROBE = 'u_cache_probe';
const FILLERS = Array.from({ length: 64 }, (_, i) => `u_cache_${i}`);

const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const headers = uid => ({ Cookie: `gymsid=${mint(uid)}` });

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cachebound-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const db = await testDb('cbound');
  const ids = [PROBE, ...FILLERS];
  await db.seed({
    users: ids.map(id => ({ id, name: id, created: new Date().toISOString() })),
    states: Object.fromEntries(ids.map(id => [id, { _rev: 1, workouts: [], routines: [] }]))
  });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...db.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env }
  });
  t.after(async () => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); await db.drop(); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const port = await boundPort(child, () => log);
  return { api: `http://127.0.0.1:${port}`, dataDir, db };
}

test('the revision poll has no per-user entries to evict: 65 profiles, and the probe is always current', async t => {
  const h = await startServer(t);
  const rev = async uid => (await fetch(`${h.api}/api/data/rev`, { headers: headers(uid) }).then(r => r.json())).rev;
  const setRev = (uid, n) => h.db.store.q('UPDATE user_state SET rev = $2 WHERE user_id = $1', [uid, n]);

  await setRev(PROBE, 7);
  assert.equal(await rev(PROBE), 7);
  await setRev(PROBE, 8);
  assert.equal(await rev(PROBE), 8, 'a second poll is not served from anything held in memory');

  // Everyone else polls, as the cache's cap used to be tested with.
  for (const uid of FILLERS) assert.equal(await rev(uid), 1, uid);

  await setRev(PROBE, 9);
  assert.equal(await rev(PROBE), 9, 'and the probe is still current after all of them');
});

test('an old row is as current as a new one: there is no TTL to outlive', async t => {
  const h = await startServer(t, { STATE_CACHE_TTL_MS: '150' });
  const rev = async uid => (await fetch(`${h.api}/api/data/rev`, { headers: headers(uid) }).then(r => r.json())).rev;
  await h.db.store.q('UPDATE user_state SET rev = 7 WHERE user_id = $1', [PROBE]);
  assert.equal(await rev(PROBE), 7);
  await new Promise(r => setTimeout(r, 400));
  await h.db.store.q('UPDATE user_state SET rev = 8 WHERE user_id = $1', [PROBE]);
  assert.equal(await rev(PROBE), 8);
});

test('the reminder query returns reminder blocks only, for profiles that asked and can be pushed to', async t => {
  const db = await testDb('cboundrem');
  t.after(() => db.drop());
  const ids = Array.from({ length: 80 }, (_, i) => `u_rem_${i}`);
  await db.seed({
    users: ids.map(id => ({ id, name: id, created: new Date().toISOString() })),
    // every document carries a payload that would be megabytes if the query dragged it along
    states: Object.fromEntries(ids.map((id, i) => [id, {
      _rev: 1, workouts: [], routines: [], pad: 'x'.repeat(2000),
      reminder: { on: i % 4 !== 0, time: '07:30', tz: 'UTC' }
    }])),
    subs: ids.filter((_, i) => i % 2 === 0 || i % 3 === 0).map(id => ({ userId: id, endpoint: 'https://push.example/' + id }))
  });
  const rows = await db.store.state.reminders();
  const want = ids.filter((_, i) => i % 4 !== 0 && (i % 2 === 0 || i % 3 === 0));
  assert.deepEqual(rows.map(r => r.id).sort(), want.sort(), 'only profiles with the reminder on and a subscription');
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'reminder'], 'no document rides along');
    assert.deepEqual(r.reminder, { on: true, time: '07:30', tz: 'UTC' });
  }
});
