/* PostgreSQL storage for openGym.
 *
 * Everything the API keeps about people — accounts, passkeys, push subscriptions, invites,
 * training documents, the trainer inbox and the audit log — lives in these tables, and nothing is held in memory between requests: every route
 * asks the database. What stays in files is only what is not data about people — the session
 * secret, the VAPID keys, uploaded media and the Coach's own folder.
 *
 * Shape. A user is one row whose `data` column is the record exactly as it was in db.json
 * (`pw`, `pwReset`, `tg`, `sv`, `lastReminder`…), plus a few derived columns the queries need
 * (`name_key`, `email`, `tg_id`, `trainer_id`, `has_pw`…). The derived columns are rewritten from
 * `data` on every save, so `data` is the single source of truth and the columns are an index.
 *
 * Concurrency. The old code was correct because nothing awaited between "read" and "write". Now
 * everything awaits, so a read-modify-write goes through `users.mutate` / `state.update`, which
 * lock the row (SELECT … FOR UPDATE) for the length of the change; a check that must hold at the
 * moment of a write (a name, an e-mail, an invite) is a unique index or a conditional UPDATE.
 */
import pg from 'pg';
import { nameKey } from './password.js';

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  seq           bigserial UNIQUE,
  id            text PRIMARY KEY,
  name          text NOT NULL,
  name_key      text NOT NULL,
  email         text,
  tg_id         bigint,
  role          text,
  trainer_id    text,
  trainer_code  text,
  admin         boolean NOT NULL DEFAULT false,
  disabled      boolean NOT NULL DEFAULT false,
  has_pw        boolean NOT NULL DEFAULT false,
  pw_reset_exp  bigint,
  created       text,
  last_pull     bigint,
  data          jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_tg_id ON users (tg_id) WHERE tg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_name_key ON users (name_key);
CREATE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_trainer_id ON users (trainer_id) WHERE trainer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_trainer_code ON users (trainer_code) WHERE trainer_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS credentials (
  seq         bigserial UNIQUE,
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key  text NOT NULL,
  counter     bigint NOT NULL DEFAULT 0,
  transports  jsonb,
  name        text,
  created     text,
  last_used   text
);
CREATE INDEX IF NOT EXISTS credentials_user ON credentials (user_id);

CREATE TABLE IF NOT EXISTS push_subs (
  seq        bigserial UNIQUE,
  endpoint   text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  keys       jsonb NOT NULL,
  device_id  text,
  created    text
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id);

CREATE TABLE IF NOT EXISTS invites (
  seq         bigserial UNIQUE,
  code        text PRIMARY KEY,
  note        text,
  created_by  text,
  created     text,
  used_by     text,
  used_at     text,
  revoked     boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS device_links (
  h        text PRIMARY KEY,
  user_id  text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  exp      bigint NOT NULL,
  created  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS device_links_user ON device_links (user_id);

CREATE TABLE IF NOT EXISTS user_state (
  user_id     text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rev         integer NOT NULL DEFAULT 0,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  user_id  text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  items    jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS audit (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts     bigint NOT NULL,
  ev     text NOT NULL,
  ok     boolean NOT NULL DEFAULT true,
  uid    text,
  name   text,
  tgt    text,
  tname  text,
  msg    text,
  act    text,
  ip     text
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
`;

const hasPw = u => !!(u && u.pw && typeof u.pw.h === 'string');

// The columns derived from a user record. Kept in one place so insert and update cannot drift.
function userCols(u) {
  return [
    u.name, nameKey(u.name), u.email ?? null, u.tg?.id ?? null, u.role ?? null,
    u.trainerId ?? null, u.trainerCode ?? null, u.admin === true, !!u.disabled, hasPw(u),
    u.pwReset?.exp ?? null, u.created ?? null, u.lastPull ?? null
  ];
}
const USER_COLS = 'name, name_key, email, tg_id, role, trainer_id, trainer_code, admin, disabled, has_pw, pw_reset_exp, created, last_pull';

const credOut = r => ({
  id: r.id, userId: r.user_id, publicKey: r.public_key, counter: Number(r.counter),
  ...(r.transports ? { transports: r.transports } : {}),
  ...(r.name ? { name: r.name } : {}),
  ...(r.created ? { created: r.created } : {}),
  ...(r.last_used ? { lastUsed: r.last_used } : {})
});
const inviteOut = r => ({
  code: r.code,
  ...(r.note != null ? { note: r.note } : {}),
  ...(r.created_by ? { createdBy: r.created_by } : {}),
  ...(r.created ? { created: r.created } : {}),
  ...(r.used_by ? { usedBy: r.used_by } : {}),
  ...(r.used_at ? { usedAt: r.used_at } : {}),
  ...(r.revoked ? { revoked: true } : {})
});
const subOut = r => ({
  userId: r.user_id, endpoint: r.endpoint, keys: r.keys,
  ...(r.device_id ? { deviceId: r.device_id } : {}),
  ...(r.created ? { created: r.created } : {})
});
const auditOut = r => ({
  id: Number(r.id), ts: Number(r.ts), ev: r.ev, ok: r.ok,
  ...(r.uid ? { uid: r.uid } : {}), ...(r.name ? { name: r.name } : {}),
  ...(r.tgt ? { tgt: r.tgt } : {}), ...(r.tname ? { tname: r.tname } : {}),
  ...(r.msg ? { msg: r.msg } : {}), ...(r.act ? { act: r.act } : {}), ...(r.ip ? { ip: r.ip } : {})
});

// Thrown to roll a mutation back without it being an error.
export const ABORT = Symbol('abort');

export async function openStore({ url, schema, log = console } = {}) {
  if (!url) {
    throw new Error('DATABASE_URL is not set — openGym stores everything in PostgreSQL (see docs/SELF_HOSTING.md)');
  }
  if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DB_SCHEMA must be a plain lowercase identifier');
  const pool = new pg.Pool({
    connectionString: url, max: +(process.env.DB_POOL_MAX || 10) || 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {})
  });
  // A dropped idle connection must not take the process down.
  pool.on('error', e => log.error('postgres: idle client error', e.message));

  if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  // One boot at a time: two API processes starting together would both try to create the tables.
  const boot = await pool.connect();
  try {
    await boot.query('SELECT pg_advisory_lock(727001)');
    await boot.query(DDL);
    await boot.query(
      `INSERT INTO meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO NOTHING`, [String(SCHEMA_VERSION)]
    );
  } finally {
    try { await boot.query('SELECT pg_advisory_unlock(727001)'); } catch { /* connection is going back anyway */ }
    boot.release();
  }

  const q = (text, params) => pool.query(text, params);

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* already gone */ }
      throw e;
    } finally {
      c.release();
    }
  }
  const isUnique = e => e && e.code === '23505';

  /* ---------- users ---------- */
  const userFrom = row => (row ? row.data : null);
  const saveUserRow = (c, u) => c.query(
    `UPDATE users SET data = $1, ${USER_COLS.split(', ').map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $${USER_COLS.split(', ').length + 2}`,
    [JSON.stringify(u), ...userCols(u), u.id]
  );

  const users = {
    async byId(id) {
      if (typeof id !== 'string' || !id) return null;
      const r = await q('SELECT data FROM users WHERE id = $1', [id]);
      return userFrom(r.rows[0]);
    },
    async byTg(tgId) {
      const r = await q('SELECT data FROM users WHERE tg_id = $1', [tgId]);
      return userFrom(r.rows[0]);
    },
    async all() {
      const r = await q('SELECT data FROM users ORDER BY seq');
      return r.rows.map(userFrom);
    },
    async count() {
      return +(await q('SELECT count(*)::int AS n FROM users')).rows[0].n;
    },
    // Profiles that count as admins by their own flag. ADMIN_UIDS is the caller's to add.
    async adminFlagged() {
      const r = await q('SELECT id FROM users WHERE admin');
      return r.rows.map(x => x.id);
    },
    // The profile whose password signs in under this folded name.
    async passwordHolder(k) {
      const r = await q('SELECT data FROM users WHERE has_pw AND name_key = $1 ORDER BY seq LIMIT 1', [k]);
      return userFrom(r.rows[0]);
    },
    async emailHolder(e) {
      const r = await q('SELECT data FROM users WHERE has_pw AND email = $1 ORDER BY seq LIMIT 1', [e]);
      return userFrom(r.rows[0]);
    },
    // A name is held by a profile with a password, or with a reset code still good, and by an
    // e-mail address someone signs in with.
    async nameTaken(name, exceptId, exec = pool) {
      const k = nameKey(name);
      const r = await exec.query(
        `SELECT 1 FROM users WHERE ($2::text IS NULL OR id <> $2)
           AND (((has_pw OR pw_reset_exp > $3) AND name_key = $1) OR email = $1) LIMIT 1`,
        [k, exceptId ?? null, Date.now()]
      );
      return r.rowCount > 0;
    },
    async emailTaken(e, exceptId, exec = pool) {
      const r = await exec.query(
        `SELECT 1 FROM users WHERE ($2::text IS NULL OR id <> $2)
           AND (email = $1 OR ((has_pw OR pw_reset_exp > $3) AND name_key = $1)) LIMIT 1`,
        [e, exceptId ?? null, Date.now()]
      );
      return r.rowCount > 0;
    },
    // Candidates for a reset code: whoever holds a reset and answers to this name or address.
    async resetCandidates(k) {
      const r = await q('SELECT data FROM users WHERE pw_reset_exp IS NOT NULL AND (name_key = $1 OR email = $1) ORDER BY seq', [k]);
      return r.rows.map(userFrom);
    },
    async trainerByCode(code) {
      if (!code) return null;
      const r = await q(`SELECT data FROM users WHERE role = 'trainer' AND trainer_code = $1 AND NOT disabled LIMIT 1`, [code]);
      return userFrom(r.rows[0]);
    },
    async clientsOf(trainerId) {
      const r = await q('SELECT data FROM users WHERE trainer_id = $1 AND NOT disabled ORDER BY seq', [trainerId]);
      return r.rows.map(userFrom);
    },
    // Insert a new profile. False when its id or Telegram id is taken.
    async insert(u) {
      try {
        await q(
          `INSERT INTO users (id, data, ${USER_COLS}) VALUES ($1, $2, ${userCols(u).map((_, i) => '$' + (i + 3)).join(', ')})`,
          [u.id, JSON.stringify(u), ...userCols(u)]
        );
        return true;
      } catch (e) { if (isUnique(e)) return false; throw e; }
    },
    /* Read-modify-write under a row lock. `fn(user)` runs with the profile locked and may change
       it in place; its return value is handed back. Return ABORT (or throw) to leave the row
       as it was. Null when there is no such profile. `fn` must not wait on anything slow. */
    async mutate(id, fn, { names = false } = {}) {
      return tx(async c => {
        // A change that gives a profile a name or an address to sign in with is serialized with
        // every other such change, so "is it taken?" and "take it" cannot interleave.
        if (names) await c.query('SELECT pg_advisory_xact_lock(727002)');
        const r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
        if (!r.rows[0]) return null;
        const u = r.rows[0].data;
        const tools = {
          c,
          nameTaken: (name, except) => users.nameTaken(name, except, c),
          emailTaken: (e, except) => users.emailTaken(e, except, c)
        };
        const out = await fn(u, tools);
        if (out === ABORT) return ABORT;
        await saveUserRow(c, u);
        return out === undefined ? u : out;
      });
    },
    /* The profile and everything of theirs, in one go. The state, assignments, credentials,
       subscriptions and device links go with it (ON DELETE CASCADE). */
    async remove(id) {
      const r = await q('DELETE FROM users WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
    saveUserRow
  };

  /* ---------- credentials ---------- */
  const creds = {
    async byId(id) {
      if (typeof id !== 'string' || !id) return null;
      const r = await q('SELECT * FROM credentials WHERE id = $1', [id]);
      return r.rows[0] ? credOut(r.rows[0]) : null;
    },
    async ofUser(userId) {
      const r = await q('SELECT * FROM credentials WHERE user_id = $1 ORDER BY seq', [userId]);
      return r.rows.map(credOut);
    },
    async countOf(userId) {
      return +(await q('SELECT count(*)::int AS n FROM credentials WHERE user_id = $1', [userId])).rows[0].n;
    },
    // After a successful assertion: the counter moves forward and the use is noted.
    async touch(id, counter, lastUsed) {
      await q('UPDATE credentials SET counter = $2, last_used = $3 WHERE id = $1', [id, counter, lastUsed]);
    },
    /* The helpers in passkeys-store.js work on `{ creds: [...] }`. This hands them this profile's
       rows under the profile's lock, then writes back what they added, renamed or removed. */
    async withScratch(userId, fn, { alsoIds = [], burnLinkH = null } = {}) {
      return tx(async c => {
        const lock = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (!lock.rowCount) return null;
        const rows = (await c.query(
          'SELECT * FROM credentials WHERE user_id = $1 OR id = ANY($2::text[]) ORDER BY seq', [userId, alsoIds]
        )).rows.map(credOut);
        const before = new Map(rows.map(r => [r.id, JSON.stringify(r)]));
        const scratch = { creds: rows };
        const out = await fn(scratch, lock.rows[0].data);
        if (out === ABORT) return ABORT;
        // A device link is spent in the same step as the passkey it made: of two requests racing
        // with one code, only the first finds it to burn, and the other changes nothing.
        if (burnLinkH && out && out.ok) {
          const d = await c.query('DELETE FROM device_links WHERE h = $1', [burnLinkH]);
          if (!d.rowCount) return { error: 'link is gone', code: 'link-gone' };
        }
        const after = new Map(scratch.creds.map(r => [r.id, r]));
        for (const id of before.keys()) {
          if (!after.has(id)) await c.query('DELETE FROM credentials WHERE id = $1', [id]);
        }
        for (const [id, r] of after) {
          if (before.get(id) === JSON.stringify(r)) continue;
          await c.query(
            `INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created, last_used)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO UPDATE SET counter = $4, transports = $5, name = $6, last_used = $8`,
            [id, r.userId, r.publicKey, r.counter || 0, r.transports ? JSON.stringify(r.transports) : null,
              r.name ?? null, r.created ?? null, r.lastUsed ?? null]
          );
        }
        return out;
      });
    }
  };

  /* ---------- push subscriptions ---------- */
  const subs = {
    async ofUser(userId) {
      const r = await q('SELECT * FROM push_subs WHERE user_id = $1 ORDER BY seq', [userId]);
      return r.rows.map(subOut);
    },
    async has(userId, endpoint) {
      return (await q('SELECT 1 FROM push_subs WHERE user_id = $1 AND endpoint = $2', [userId, endpoint])).rowCount > 0;
    },
    async hasAny(userId) {
      return (await q('SELECT 1 FROM push_subs WHERE user_id = $1 LIMIT 1', [userId])).rowCount > 0;
    },
    async userIdsWithAny() {
      return new Set((await q('SELECT DISTINCT user_id FROM push_subs')).rows.map(r => r.user_id));
    },
    async removeEndpoints(endpoints) {
      if (!endpoints.length) return;
      await q('DELETE FROM push_subs WHERE endpoint = ANY($1::text[])', [endpoints]);
    },
    async remove(userId, endpoint) {
      await q('DELETE FROM push_subs WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
    },
    /* Upsert one subscription: the same endpoint sent again keeps its first `created`, and a
       profile never holds more than `max` — the oldest go first. */
    async upsert(userId, { endpoint, keys, deviceId }, max) {
      return tx(async c => {
        await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const prev = (await c.query('SELECT created FROM push_subs WHERE endpoint = $1', [endpoint])).rows[0];
        await c.query('DELETE FROM push_subs WHERE endpoint = $1', [endpoint]);
        const mine = (await c.query('SELECT endpoint FROM push_subs WHERE user_id = $1 ORDER BY seq', [userId])).rows;
        if (mine.length >= max) {
          const drop = mine.slice(0, mine.length - max + 1).map(r => r.endpoint);
          await c.query('DELETE FROM push_subs WHERE endpoint = ANY($1::text[])', [drop]);
        }
        await c.query(
          'INSERT INTO push_subs (endpoint, user_id, keys, device_id, created) VALUES ($1,$2,$3,$4,$5)',
          [endpoint, userId, JSON.stringify(keys), deviceId ?? null, prev?.created || new Date().toISOString()]
        );
      });
    }
  };

  /* ---------- invites ---------- */
  const invites = {
    async all() {
      return (await q('SELECT * FROM invites ORDER BY seq')).rows.map(inviteOut);
    },
    async usable(code) {
      const r = await q('SELECT * FROM invites WHERE code = $1 AND used_by IS NULL AND NOT revoked', [code]);
      return r.rows[0] ? inviteOut(r.rows[0]) : null;
    },
    async byCode(code) {
      const r = await q('SELECT * FROM invites WHERE code = $1', [code]);
      return r.rows[0] ? inviteOut(r.rows[0]) : null;
    },
    // False when the code is already taken.
    async create({ code, note, createdBy, created }) {
      try {
        await q('INSERT INTO invites (code, note, created_by, created) VALUES ($1,$2,$3,$4)', [code, note ?? '', createdBy ?? null, created ?? null]);
        return true;
      } catch (e) { if (isUnique(e)) return false; throw e; }
    },
    async remove(code) {
      await q('DELETE FROM invites WHERE code = $1', [code]);
    }
  };

  /* A new profile, with its first passkey and the invite it used: all of it or none. An invite
     that went to someone else between the check and now is the one thing that can refuse it. */
  async function register({ user, cred, inviteCode, checkNames = false }) {
    try {
      return await tx(async c => {
        if (checkNames) {
          await c.query('SELECT pg_advisory_xact_lock(727002)');
          if (await users.nameTaken(user.name, null, c)) return { error: 'name-taken' };
          if (user.email && await users.emailTaken(user.email, null, c)) return { error: 'email-taken' };
        }
        if (inviteCode) {
          const claimed = await c.query(
            `UPDATE invites SET used_by = $2, used_at = $3 WHERE code = $1 AND used_by IS NULL AND NOT revoked`,
            [inviteCode, user.id, user.created]
          );
          if (!claimed.rowCount) return { error: 'invite' };
        }
        await c.query(
          `INSERT INTO users (id, data, ${USER_COLS}) VALUES ($1, $2, ${userCols(user).map((_, i) => '$' + (i + 3)).join(', ')})`,
          [user.id, JSON.stringify(user), ...userCols(user)]
        );
        if (cred) {
          await c.query(
            `INSERT INTO credentials (id, user_id, public_key, counter, transports, created, last_used)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [cred.id, user.id, cred.publicKey, cred.counter || 0, JSON.stringify(cred.transports || []), cred.created ?? null, cred.lastUsed ?? null]
          );
        }
        return { ok: true };
      });
    } catch (e) {
      if (isUnique(e)) return { error: /credentials/.test(e.table || e.constraint || '') ? 'credential' : 'exists' };
      throw e;
    }
  }

  /* ---------- device links ---------- */
  const deviceLinks = {
    // One live link per profile: a new one replaces the one before it.
    async create(userId, { h, exp, created }) {
      await tx(async c => {
        await c.query('DELETE FROM device_links WHERE exp <= $1 OR user_id = $2', [Date.now(), userId]);
        await c.query('INSERT INTO device_links (h, user_id, exp, created) VALUES ($1,$2,$3,$4)', [h, userId, exp, created]);
      });
    },
    async find(h, now = Date.now()) {
      const r = await q('SELECT h, user_id, exp, created FROM device_links WHERE h = $1 AND exp > $2', [h, now]);
      const x = r.rows[0];
      return x ? { h: x.h, userId: x.user_id, exp: Number(x.exp), created: Number(x.created) } : null;
    },
    // True for the request that burned it; a second one racing it finds nothing.
    async burn(h) {
      return (await q('DELETE FROM device_links WHERE h = $1', [h])).rowCount > 0;
    },
    async dropFor(userId) {
      return (await q('DELETE FROM device_links WHERE user_id = $1', [userId])).rowCount > 0;
    }
  };

  /* ---------- per-profile training document ---------- */
  const state = {
    async get(uid) {
      if (typeof uid !== 'string' || !uid) return null;
      const r = await q('SELECT state FROM user_state WHERE user_id = $1', [uid]);
      return r.rows[0] ? r.rows[0].state : null;
    },
    async rev(uid) {
      const r = await q('SELECT rev FROM user_state WHERE user_id = $1', [uid]);
      return r.rows[0] ? r.rows[0].rev : 0;
    },
    async ids() {
      return (await q('SELECT user_id FROM user_state ORDER BY user_id')).rows.map(r => r.user_id);
    },
    /* Compare-and-write under the profile's lock. `fn(current)` returns `{ write: doc }` to
       store a document, or anything else to leave it; it is handed back untouched. */
    async update(uid, fn) {
      return tx(async c => {
        const lock = await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [uid]);
        if (!lock.rowCount) return null;
        const cur = (await c.query('SELECT state FROM user_state WHERE user_id = $1', [uid])).rows[0]?.state ?? null;
        const out = await fn(cur);
        if (out && out.write) {
          await c.query(
            `INSERT INTO user_state (user_id, rev, state, updated_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (user_id) DO UPDATE SET rev = $2, state = $3, updated_at = now()`,
            [uid, +out.write._rev || 0, JSON.stringify(out.write)]
          );
        }
        return out;
      });
    },
    // Profiles that asked for a day reminder: just the reminder block, never the whole document.
    async reminders() {
      const r = await q(
        `SELECT s.user_id, s.state->'reminder' AS reminder FROM user_state s
           WHERE s.state->'reminder'->>'on' = 'true'
             AND (EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = s.user_id)
                  OR EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.tg_id IS NOT NULL
                             AND coalesce(u.data->>'tgMute', '') = ''))`
      );
      return r.rows.map(x => ({ id: x.user_id, reminder: x.reminder }));
    }
  };

  /* ---------- trainer inbox ---------- */
  // Small named facts the server keeps for itself (the bot setup it last sent, and the like).
  const meta = {
    async get(key) { return (await q('SELECT value FROM meta WHERE key = $1', [key])).rows[0]?.value ?? null; },
    async set(key, value) { await q('INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, String(value)]); }
  };

  const assignments = {
    async get(uid) {
      const r = await q('SELECT items FROM assignments WHERE user_id = $1', [uid]);
      return Array.isArray(r.rows[0]?.items) ? r.rows[0].items : [];
    },
    async update(uid, fn) {
      return tx(async c => {
        const lock = await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [uid]);
        if (!lock.rowCount) return null;
        const cur = (await c.query('SELECT items FROM assignments WHERE user_id = $1', [uid])).rows[0]?.items;
        const list = Array.isArray(cur) ? cur : [];
        const out = await fn(list);
        if (out === ABORT) return ABORT;
        const next = out && out.items ? out.items : list;
        await c.query(
          `INSERT INTO assignments (user_id, items) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET items = $2`,
          [uid, JSON.stringify(next)]
        );
        return out;
      });
    }
  };

  /* ---------- audit log ---------- */
  const audit = {
    async add(rec) {
      await q(
        'INSERT INTO audit (ts, ev, ok, uid, name, tgt, tname, msg, act, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [rec.ts, rec.ev, rec.ok !== false, rec.uid ?? null, rec.name ?? null, rec.tgt ?? null, rec.tname ?? null,
          rec.msg ?? null, rec.act ?? null, rec.ip ?? null]
      );
    },
    // Newest first, paged by id. `cat` is 'fail' or an event family ('auth', 'admin', …).
    async page({ cat = '', before = null, limit = 100, uid = null } = {}) {
      const where = []; const p = [];
      // One profile's events: the ones it caused and the ones done to it (an admin's disable).
      if (uid) { p.push(uid); where.push(`(uid = $${p.length} OR tgt = $${p.length})`); }
      if (cat === 'fail') where.push('NOT ok');
      else if (cat) { p.push(cat.replace(/[\\%_]/g, '\\$&') + '.%'); where.push(`ev LIKE $${p.length}`); }
      const base = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = +(await q(`SELECT count(*)::int AS n FROM audit ${base}`, p)).rows[0].n;
      const p2 = [...p];
      const w2 = [...where];
      if (before != null) { p2.push(before); w2.push(`id < $${p2.length}`); }
      p2.push(limit);
      const rows = (await q(
        `SELECT * FROM audit ${w2.length ? 'WHERE ' + w2.join(' AND ') : ''} ORDER BY id DESC LIMIT $${p2.length}`, p2
      )).rows.map(auditOut);
      return { rows, total };
    },
    // Age first, then the newest `max` of what is left. Returns how many rows it removed.
    async prune({ days = 0, max = 0 } = {}) {
      let n = 0;
      if (days) n += (await q('DELETE FROM audit WHERE ts < $1', [Date.now() - days * 86400000])).rowCount;
      if (max) {
        n += (await q(
          'DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC OFFSET $1 LIMIT 1)', [max]
        )).rowCount;
      }
      return n;
    },
    // Ids are an identity column: clearing leaves a visible gap, as the file log's counter did.
    async clear() {
      await q('DELETE FROM audit');
    }
  };

  /* ---------- admin site (read side) ---------- */
  // Numbers read out of the training document in SQL, so a list of every profile never loads a
  // document. A `workouts` that is not an array (a document from before the entry filter) counts
  // as none, and an entry that is not an object has no date.
  const OBJS = `jsonb_path_query_array(CASE WHEN jsonb_typeof(s.state->'workouts') = 'array' THEN s.state->'workouts' ELSE '[]'::jsonb END, '$[*] ? (@.type() == "object")')`;
  const WORKOUTS_N = `jsonb_array_length(${OBJS})`;
  const LAST_WORKOUT = `(${OBJS})->-1->>'d'`;
  const adminOut = r => ({
    id: r.id, name: r.name, created: r.created, disabled: r.disabled, role: r.role,
    telegramId: r.tg_id == null ? null : Number(r.tg_id), username: r.username || null,
    trainerId: r.trainer_id, trainerName: r.trainer_name || null, clients: +r.clients || 0,
    workouts: +r.workouts || 0, lastWorkout: r.last_workout || null,
    lastSync: Math.max(+r.ts || 0, +r.last_pull || 0) || null, push: +r.push || 0, rev: r.rev == null ? 0 : +r.rev
  });
  const adminSelect = `
    SELECT u.id, u.name, u.created, u.disabled, u.role, u.tg_id, u.data->'tg'->>'username' AS username,
           u.trainer_id, t.name AS trainer_name,
           (SELECT count(*) FROM users c WHERE c.trainer_id = u.id) AS clients,
           ${WORKOUTS_N} AS workouts, ${LAST_WORKOUT} AS last_workout,
           CASE WHEN jsonb_typeof(s.state->'_ts') = 'number' THEN (s.state->>'_ts')::bigint END AS ts,
           u.last_pull, (SELECT count(*) FROM push_subs p WHERE p.user_id = u.id) AS push, s.rev
      FROM users u LEFT JOIN user_state s ON s.user_id = u.id LEFT JOIN users t ON t.id = u.trainer_id`;
  const adminWhere = (p, { q, role }) => {
    const w = [];
    if (q) {
      p.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
      w.push(`(u.name ILIKE $${p.length} OR u.data->'tg'->>'username' ILIKE $${p.length} OR u.id = $${p.length + 1} OR u.tg_id::text = $${p.length + 1})`);
      p.push(q);
    }
    if (role === 'trainer') w.push(`u.role = 'trainer'`);
    else if (role === 'client') w.push('u.trainer_id IS NOT NULL');
    else if (role === 'disabled') w.push('u.disabled');
    return w.length ? 'WHERE ' + w.join(' AND ') : '';
  };
  const admin = {
    async users({ q = '', role = '', page = 1, limit = 20 } = {}) {
      const p = [];
      const where = adminWhere(p, { q, role });
      const total = +(await pool.query(`SELECT count(*)::int AS n FROM users u ${where}`, p)).rows[0].n;
      const rows = (await pool.query(
        `${adminSelect} ${where} ORDER BY u.seq DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
        [...p, limit, (page - 1) * limit]
      )).rows.map(adminOut);
      return { items: rows, total };
    },
    async user(id) {
      const r = (await pool.query(`${adminSelect} WHERE u.id = $1`, [id])).rows[0];
      return r ? adminOut(r) : null;
    },
    async clientsOf(id) {
      const r = await pool.query(`${adminSelect} WHERE u.trainer_id = $1 ORDER BY u.seq`, [id]);
      return r.rows.map(adminOut);
    },
    // The newest workouts of one profile, trimmed to what a table shows.
    async recentWorkouts(id, n = 20) {
      const r = await pool.query(
        `SELECT w->>'d' AS d, w->>'name' AS name, w->>'vol' AS vol, w->>'start' AS start, w->>'end' AS "end",
                CASE WHEN jsonb_typeof(w->'entries') = 'array' THEN jsonb_array_length(w->'entries') END AS exercises
           FROM user_state s,
                LATERAL (SELECT e AS w FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.state->'workouts') = 'array' THEN s.state->'workouts' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, i)
                          WHERE jsonb_typeof(e) = 'object' ORDER BY i DESC LIMIT $2) x
          WHERE s.user_id = $1`, [id, n]
      );
      return r.rows.map(x => ({
        d: x.d || null, name: x.name || null, vol: x.vol == null ? null : +x.vol || null,
        minutes: x.start && x.end && +x.end > +x.start ? Math.round((+x.end - +x.start) / 60000) : null,
        exercises: x.exercises == null ? null : +x.exercises
      }));
    },
    async overview() {
      const n = async sql => +(await pool.query(sql)).rows[0].n;
      const week = Date.now() - 7 * 86400000;
      const day = Date.now() - 86400000;
      return {
        users: await n('SELECT count(*)::int AS n FROM users'),
        trainers: await n(`SELECT count(*)::int AS n FROM users WHERE role = 'trainer'`),
        clients: await n('SELECT count(*)::int AS n FROM users WHERE trainer_id IS NOT NULL'),
        disabled: await n('SELECT count(*)::int AS n FROM users WHERE disabled'),
        newWeek: await n(`SELECT count(*)::int AS n FROM users WHERE created >= '${new Date(week).toISOString()}'`),
        activeWeek: await n(`SELECT count(*)::int AS n FROM users u LEFT JOIN user_state s ON s.user_id = u.id
          WHERE u.last_pull >= ${week} OR (jsonb_typeof(s.state->'_ts') = 'number' AND (s.state->>'_ts')::bigint >= ${week})`),
        workouts: await n(`SELECT COALESCE(sum(jsonb_array_length(${OBJS})), 0)::int AS n FROM user_state s`),
        push: await n('SELECT count(*)::int AS n FROM push_subs'),
        events24h: await n(`SELECT count(*)::int AS n FROM audit WHERE ts >= ${day}`),
        failed24h: await n(`SELECT count(*)::int AS n FROM audit WHERE ts >= ${day} AND NOT ok`)
      };
    }
  };

  async function close() { await pool.end(); }
  async function ping() { await pool.query('SELECT 1'); }

  return {
    pool, q, tx, close, ping, register,
    users, creds, subs, invites, deviceLinks, state, assignments, audit, admin, meta
  };
}
