/* Shared scaffolding for the api tests.
 *
 * Every module under coach/ resolves DATA_DIR at import time (the same way server.js does),
 * so a test that wants its own data directory has to set the variable before the first
 * import. Hence dynamic imports everywhere below, and one helper that does it in the right
 * order. node:test runs each file in its own process, so one directory per file is enough.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* The port a spawned server.js actually bound.
 *
 * Never pick one for it. Opening a listener on 0, reading the port, closing it and handing the
 * number to a child that binds it a process start later leaves a window the kernel re-issues
 * ephemeral ports inside -- 8 repeats in 400 open/close rounds on this box -- and a dozen test
 * files spawn servers at once, so two draw the same number, one child loses the bind and dies,
 * and the other file's server answers on it: a different data dir, a db.json without the test's
 * user, and a 401 where the answer belongs. It cost one unreproducible failure before anyone
 * looked.
 *
 * So the child picks its own port (PORT=0) and says which on its boot line. That line cannot be
 * printed before the socket is bound, which makes it the readiness signal as well -- no polling
 * /api/health, and no waiting on a server that died at boot either.
 *
 * `tail` supplies whatever the caller has collected of the child's output, for the message.
 */
export function boundPort(child, tail = () => '') {
  return new Promise((resolve, reject) => {
    let seen = '';
    const give = setTimeout(() => reject(new Error(`server never announced a port:\n${tail() || seen}`)), 20000);
    const look = d => {
      seen += d;
      const m = /gym-api on :(\d+)/.exec(seen);
      if (!m) return;
      clearTimeout(give);
      child.stdout.off('data', look);
      resolve(+m[1]);
    };
    child.stdout.on('data', look);
    child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${tail() || seen}`)); });
  });
}

export function tempData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-test-'));
  fs.writeFileSync(path.join(dir, 'secret'), 'a'.repeat(64), { mode: 0o600 });
  process.env.DATA_DIR = dir;
  return dir;
}

export function writeState(dir, uid, S) {
  fs.writeFileSync(path.join(dir, 'state-' + uid + '.json'), JSON.stringify(S));
}

/** A profile that has consented and has some history — the usual starting point. */
export function sampleState(over = {}) {
  return {
    unit: 'kg', lang: 'en', effort: 'rpe', targetW: 80,
    coach: { consent: { agreedAt: new Date().toISOString(), version: 1 }, profile: { goal: 'muscle', daysPerWeek: 3, equipment: ['dumbbell'] } },
    routines: [{
      id: 'r1', name: 'Full body A', emoji: '💪', prog: 'linear',
      ex: [
        { id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear' },
        { id: '0007', sets: 3, sec: 45, mode: 'time' }
      ]
    }],
    week: { 1: 'r1', 3: 'r1', 5: 'r1' },
    dayPlan: {},
    exWeights: { '0001': { w: 20 } },
    bodyweight: [{ d: '2026-07-01', w: 78 }, { d: '2026-07-20', w: 78.5 }],
    customEx: [],
    workouts: [{
      id: 'w1', d: '2026-07-20', name: 'Full body A', start: 1000, end: 1000 + 45 * 60000, vol: 600, prs: [],
      entries: [{
        id: '0001', target: { sets: 3, reps: 10, weight: 20 },
        sets: [{ w: 20, r: 10, done: true, rpe: 9.5 }, { w: 20, r: 9, done: true, rpe: 10 }, { w: 20, r: 8, done: true, rpe: 10 }]
      }]
    }],
    ...over
  };
}

/** A Telegram Mini App initData string signed the way Telegram signs it, for `token`. */
export function signInitData(fields, token) {
  const p = new URLSearchParams(fields);
  const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return p.toString();
}

/* ---------- PostgreSQL for the tests ----------
 *
 * The API keeps everything in Postgres, so a test that spawns server.js needs a database. Each test
 * file gets a schema of its own (DB_SCHEMA), created here and dropped when the test is done, so
 * files can run side by side against one server. Point TEST_DATABASE_URL (or DATABASE_URL) at a
 * Postgres you do not mind tests creating schemas in:
 *
 *   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=opengym postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/opengym npm test
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:test@localhost:5433/opengym';

/** A fresh schema with the tables in it, plus what a test needs to put rows in and read them back.
 *  Call `await db.drop()` (or hand it to t.after) when done. */
export async function testDb(prefix = 't') {
  const { openStore } = await import('../store.js');
  const schema = `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  const store = await openStore({ url: TEST_DB_URL, schema, log: { error() {}, warn() {}, log() {} } });
  const env = { DATABASE_URL: TEST_DB_URL, DB_SCHEMA: schema };
  return {
    store, schema, env,
    /** Rows in the shapes the old db.json had: { users, creds, subs, invites, deviceLinks }, plus
     *  `states` ({ uid: document }) and `assignments` ({ uid: [..] }). */
    async seed({ users = [], creds = [], subs = [], invites = [], deviceLinks = [], states = {}, assignments = {} } = {}) {
      for (const u of users) await store.users.insert(u);
      for (const c of creds) {
        await store.q(
          `INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created, last_used)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.id, c.userId, c.publicKey ?? '', c.counter || 0, c.transports ? JSON.stringify(c.transports) : null, c.name ?? null, c.created ?? null, c.lastUsed ?? null]
        );
      }
      for (const s of subs) {
        await store.q(
          'INSERT INTO push_subs (endpoint, user_id, keys, device_id, created) VALUES ($1,$2,$3,$4,$5)',
          [s.endpoint, s.userId, JSON.stringify(s.keys || { p256dh: 'p', auth: 'a' }), s.deviceId ?? null, s.created ?? null]
        );
      }
      for (const i of invites) {
        await store.q(
          'INSERT INTO invites (code, note, created_by, created, used_by, used_at, revoked) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [i.code, i.note ?? '', i.createdBy ?? null, i.created ?? null, i.usedBy ?? null, i.usedAt ?? null, !!i.revoked]
        );
      }
      for (const l of deviceLinks) {
        await store.q('INSERT INTO device_links (h, user_id, exp, created) VALUES ($1,$2,$3,$4)', [l.h, l.userId, l.exp, l.created || Date.now()]);
      }
      for (const [uid, S] of Object.entries(states)) await this.setState(uid, S);
      for (const [uid, list] of Object.entries(assignments)) {
        await store.q('INSERT INTO assignments (user_id, items) VALUES ($1,$2)', [uid, JSON.stringify(list)]);
      }
    },
    async setState(uid, S) {
      await store.q(
        `INSERT INTO user_state (user_id, rev, state) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET rev = $2, state = $3`,
        [uid, +S._rev || 0, JSON.stringify(S)]
      );
    },
    async state(uid) { return store.state.get(uid); },
    async user(uid) { return store.users.byId(uid); },
    async users() { return store.users.all(); },
    async creds(uid) { return uid ? store.creds.ofUser(uid) : (await store.q('SELECT * FROM credentials ORDER BY seq')).rows; },
    async subs(uid) { return uid ? store.subs.ofUser(uid) : (await store.q('SELECT * FROM push_subs ORDER BY seq')).rows; },
    async invites() { return store.invites.all(); },
    async deviceLinks() { return (await store.q('SELECT * FROM device_links')).rows; },
    async audit() { return (await store.q('SELECT * FROM audit ORDER BY id')).rows; },
    async assignments(uid) { return store.assignments.get(uid); },
    async drop() {
      try { await store.q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* already gone */ }
      try { await store.close(); } catch { /* closed */ }
    }
  };
}
