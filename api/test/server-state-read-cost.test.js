/* GET /api/data/rev is polled every 30 s and on every return to the foreground, so it must stay
   cheap however large the profile has grown: it answers from the `rev` column of the profile's
   row and never loads the document (measured once on a 2.4 MB state: 31 ms per poll when it
   parsed the whole of it). This used to be a stat cache of parsed documents; the cache is gone
   with the files, and the properties it was tested for are restated against the database:

   - a poll right after a sync reports the revision that sync returned (the PUT and the column
     are one write, so there is no window for a stale answer -- the case the cache needed an
     eviction for);
   - the poll really is answered from the column: a revision changed in the column alone, with
     the document untouched, is what the poll reports;
   - the poll handler does not load the document at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, testDb } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = { Cookie: `gymsid=${mintSession('u_cost_1')}`, 'Content-Type': 'application/json' };

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-statecost-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const db = await testDb('rcost');
  await db.seed({ users: [{ id: 'u_cost_1', name: 'One', created: new Date().toISOString() }] });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...db.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { api: '', port: 0, dataDir, db, log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(async () => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); await db.drop(); });
  // The boot line carries the port the listener bound, so it is both the address and the
  // readiness signal — see boundPort in helpers.mjs for why the test does not pick one.
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  return h;
}

/* One keep-alive socket, strictly one request at a time — the next is written only once the
   previous response has been read in full, which is the ordering a browser gives. A raw socket
   keeps the poll as close behind the sync as a client can get it.
   Deliberately NOT pipelined: pipelining lets the server start the poll's handler before the
   PUT's has finished, which is a different effect and would prove nothing about the cache. */
async function keepAlive(t, port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.once('connect', r));
  t.after(() => sock.destroy());
  let buf = Buffer.alloc(0), want = null;
  const parse = () => {
    if (!want) return;
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    const head = buf.slice(0, i).toString();
    const cl = /content-length: (\d+)/i.exec(head);
    let body;
    if (cl) {
      const n = +cl[1];
      if (buf.length < i + 4 + n) return;
      body = buf.slice(i + 4, i + 4 + n).toString();
      buf = buf.slice(i + 4 + n);
    } else {                                  // json() sets no length, so node chunks it
      let off = i + 4; body = '';
      for (;;) {
        const j = buf.indexOf('\r\n', off);
        if (j < 0) return;
        const n = parseInt(buf.slice(off, j).toString(), 16);
        if (n === 0) { if (buf.length < j + 4) return; off = j + 4; break; }
        if (buf.length < j + 2 + n + 2) return;
        body += buf.slice(j + 2, j + 2 + n).toString(); off = j + 2 + n + 2;
      }
      buf = buf.slice(off);
    }
    const w = want; want = null; w(JSON.parse(body));
  };
  sock.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
  const send = raw => new Promise(res => { want = res; sock.write(raw); parse(); });
  return {
    put: ts => {
      const b = JSON.stringify({ state: { _ts: ts, workouts: [], routines: [] } });
      return send(`PUT /api/data HTTP/1.1\r\nHost: x\r\nCookie: ${headers.Cookie}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
    },
    rev: () => send(`GET /api/data/rev HTTP/1.1\r\nHost: x\r\nCookie: ${headers.Cookie}\r\n\r\n`)
  };
}

test('a poll right after a sync reports the revision that sync returned, not the one before it', async t => {
  const h = await startServer(t);
  const c = await keepAlive(t, h.port);

  // The client's real loop: sync, poll, sync, poll, back to back on one socket.
  const stale = [];
  for (let i = 0; i < 20; i++) {
    const wrote = await c.put(100 + i);
    const polled = await c.rev();
    if (polled.rev !== wrote.rev) stale.push(`round ${i}: PUT returned rev ${wrote.rev}, the poll said ${polled.rev}`);
  }
  assert.deepEqual(stale, [], 'every poll saw the write that preceded it');

  // and what the polls were reporting is what is actually stored
  assert.equal((await c.rev()).rev, (await h.db.state('u_cost_1'))._rev);
});

test('the poll is answered from the rev column, not from the document', async t => {
  const h = await startServer(t);
  const rev = async () => (await fetch(`${h.api}/api/data/rev`, { headers }).then(r => r.json())).rev;
  const put = await fetch(`${h.api}/api/data`, {
    method: 'PUT', headers, body: JSON.stringify({ state: { _ts: 1, workouts: [], routines: [] } })
  }).then(r => r.json());
  assert.equal(await rev(), put.rev, 'a write through the app is on the very next poll');

  // Move the column alone. The document still says what the PUT stamped, so a poll that loaded it
  // would answer with that; this one reports the column.
  await h.db.store.q('UPDATE user_state SET rev = 41 WHERE user_id = $1', ['u_cost_1']);
  assert.equal((await h.db.state('u_cost_1'))._rev, put.rev, 'the document is untouched');
  assert.equal(await rev(), 41);
});

// The push routes read `lang` for their payload, which nothing outside the push service can
// observe -- so the cheap one is pinned at the only place that can see it: the source.
test('GET /api/data/rev asks for the revision alone and never loads the document', () => {
  const src = fs.readFileSync(path.join(API, 'server.js'), 'utf8');
  // Every route is one `'METHOD /path': async (req, res) => {` entry in the routes object, so a
  // handler runs from its key to the start of the next one.
  const handler = key => {
    const at = src.indexOf(`'${key}':`);
    assert.notEqual(at, -1, `route ${key} is gone -- this test needs rewriting`);
    const end = src.indexOf("\n  '", at + 1);
    return src.slice(at, end === -1 ? undefined : end);
  };
  const body = handler('GET /api/data/rev');
  assert.match(body, /store\.state\.rev\(user\.id\)/);
  assert.doesNotMatch(body, /readState\(|store\.state\.get\(/, 'the poll loads the whole document');
  // GET /api/data hands out the document itself -- that one does load it.
  assert.match(handler('GET /api/data'), /readState\(user\.id\)|store\.state\.get\(/);
});
