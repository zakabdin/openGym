/* Bot usage rows live in the audit table but are pruned apart from the security events, and
   summarised for the admin card. Needs the Postgres test container (TEST_DATABASE_URL). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../store.js';

const URL_ = process.env.TEST_DATABASE_URL;
const schema = 'audit_bot_' + Math.random().toString(36).slice(2, 8);

test('bot rows are capped on their own and never evict security events', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, async () => {
  const store = await openStore({ url: URL_, schema, log: { log() {}, error() {} } });
  try {
    const DAY = 86400000, now = Date.now();
    for (let i = 0; i < 6; i++) await store.audit.add({ ts: now - i, ev: 'auth.login.ok', uid: 'u' + i });
    for (let i = 0; i < 20; i++) await store.audit.add({ ts: now - i, ev: i % 2 ? 'bot.cmd.plan' : 'bot.btn.stats', uid: 'u' + (i % 3) });
    await store.audit.add({ ts: now - 40 * DAY, ev: 'bot.cmd.today', uid: 'u0' });      // older than the bot window
    await store.audit.add({ ts: now - 40 * DAY, ev: 'auth.login.ok', uid: 'u0' });      // same age, but a security event
    await store.audit.prune({ days: 90, max: 5, botDays: 30, botMax: 8 });
    const all = (await store.audit.page({ limit: 100 })).rows;
    assert.equal(all.filter(r => r.ev.startsWith('bot.')).length, 8, 'bot rows capped at botMax, old one gone');
    assert.equal(all.filter(r => !r.ev.startsWith('bot.')).length, 5, 'security rows kept to their own max');
    const s = await store.audit.botStats({ days: 7 });
    assert.equal(s.h24.events, 8);
    assert.equal(s.h24.users, 3);
    assert.deepEqual(s.top.map(t => t.ev).sort(), ['bot.btn.stats', 'bot.cmd.plan']);
    assert.equal((await store.audit.page({ cat: 'bot', limit: 100 })).total, 8);
  } finally { await store.close(); }
});
