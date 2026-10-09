/* The device-link bookkeeping (#95): one code per profile, hashed at rest, good once and for a few
   minutes. The routes around it are in server-passkeys.test.js. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.mjs';
import {
  createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks, hashLinkCode, makeLinkCode, DEVICE_LINK_TTL_MS
} from '../device-link.js';

let db;
before(async () => {
  db = await testDb('dl');
  // device_links.user_id references users, so the profiles the tests name have to exist.
  await db.seed({ users: ['user-a', 'user-b'].map(id => ({ id, name: id, created: new Date().toISOString() })) });
});
after(async () => { await db.drop(); });
// Each test starts from an empty table.
const clear = () => db.store.q('DELETE FROM device_links');

describe('createDeviceLink', () => {
  it('issues a code bound to the user, with an expiry, and keeps only its hash', async () => {
    await clear();
    const now = 1_700_000_000_000;
    const { code, link } = await createDeviceLink(db.store, 'user-a', now, 10 * 60 * 1000);
    assert.equal(link.userId, 'user-a');
    assert.equal(link.exp, now + 10 * 60 * 1000);
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const rows = await db.deviceLinks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].h, hashLinkCode(code));
    // Nowhere in what is stored does the code itself appear.
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(code.replace(/-/g, '')));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(code));
  });

  it('lasts ten minutes unless told otherwise', async () => {
    await clear();
    const { link } = await createDeviceLink(db.store, 'user-a', 1000);
    assert.equal(link.exp, 1000 + DEVICE_LINK_TTL_MS);
    assert.equal(DEVICE_LINK_TTL_MS, 10 * 60 * 1000);
  });

  it('replaces any unused link for the same user', async () => {
    await clear();
    const first = await createDeviceLink(db.store, 'user-a', 1000, 60_000);
    const second = await createDeviceLink(db.store, 'user-a', 2000, 60_000);
    assert.equal((await db.deviceLinks()).length, 1);
    assert.equal(await findDeviceLink(db.store, first.code, 2500), null);
    assert.deepEqual(await findDeviceLink(db.store, second.code, 2500), second.link);
  });

  it('leaves another user’s unused link alone', async () => {
    await clear();
    await createDeviceLink(db.store, 'user-a', Date.now(), 60_000);
    await createDeviceLink(db.store, 'user-b', Date.now(), 60_000);
    assert.equal((await db.deviceLinks()).length, 2);
  });

  it('makes codes that differ', () => {
    const seen = new Set(Array.from({ length: 200 }, makeLinkCode));
    assert.equal(seen.size, 200);
  });
});

describe('findDeviceLink', () => {
  it('finds the link however the code is typed, without using it up', async () => {
    await clear();
    const { code, link } = await createDeviceLink(db.store, 'user-a', 1000, 60_000);
    assert.deepEqual(await findDeviceLink(db.store, code, 2000), link);
    assert.deepEqual(await findDeviceLink(db.store, ' ' + code.toLowerCase().replace(/-/g, ' ') + ' ', 2000), link);
    assert.equal((await db.deviceLinks()).length, 1);
  });

  it('is single use once burned', async () => {
    await clear();
    const { code, link } = await createDeviceLink(db.store, 'user-a', 1000, 60_000);
    assert.equal(await burnDeviceLink(db.store, link), true);
    // Of two requests racing with one code, only the one that burned it gets true.
    assert.equal(await burnDeviceLink(db.store, link), false);
    assert.equal(await findDeviceLink(db.store, code, 2000), null);
    assert.equal((await db.deviceLinks()).length, 0);
  });

  it('refuses an expired link, and the next link made drops it', async () => {
    await clear();
    const { code } = await createDeviceLink(db.store, 'user-a', 1000, 60_000);
    assert.equal(await findDeviceLink(db.store, code, 1000 + 60_000 + 1), null);
    // The store no longer deletes on read: expired rows are purged when the next link is created.
    await createDeviceLink(db.store, 'user-b', Date.now(), 60_000);
    const rows = await db.deviceLinks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'user-b');
  });

  it('refuses a wrong code without touching other links', async () => {
    // (The old "ignores rows that are not links" case is gone: a typed table cannot hold null or garbage rows.)
    await clear();
    await createDeviceLink(db.store, 'user-a', 1000, 60_000);
    assert.equal(await findDeviceLink(db.store, 'nope', 1000), null);
    assert.equal(await findDeviceLink(db.store, 'AAAA-AAAA-AAAA', 1000), null);
    assert.equal(await findDeviceLink(db.store, { toString: 1 }, 1000), null);
    assert.equal((await db.deviceLinks()).length, 1);
  });
});

describe('dropDeviceLinks', () => {
  it('drops only that user’s links and says whether any went', async () => {
    await clear();
    const now = Date.now();
    const a = await createDeviceLink(db.store, 'user-a', now, 60_000);
    const b = await createDeviceLink(db.store, 'user-b', now, 60_000);
    assert.equal(await dropDeviceLinks(db.store, 'user-a'), true);
    assert.equal(await dropDeviceLinks(db.store, 'user-a'), false);
    assert.equal(await findDeviceLink(db.store, a.code, now + 2000), null);
    assert.deepEqual(await findDeviceLink(db.store, b.code, now + 2000), b.link);
  });
});
