/* Telegram initData verification (telegram.js): only a string Telegram signed for this bot, recently,
   for a real user, opens an account. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData } from '../telegram.js';
import { signInitData as sign } from './helpers.mjs';
const signInitData = (f, tok = TOKEN) => sign(f, tok);

const TOKEN = '123456:TEST-token';
const now = Date.now();
const fresh = (over = {}) => ({
  auth_date: String(Math.floor(now / 1000) - 10),
  user: JSON.stringify({ id: 42, first_name: 'Ada', last_name: 'L', username: 'ada' }),
  start_param: 't_abcdef23',
  ...over
});

test('a genuine, fresh initData yields the Telegram user', () => {
  const u = verifyInitData(signInitData(fresh()), TOKEN, now);
  assert.equal(u.id, 42);
  assert.equal(u.name, 'Ada L');
  assert.equal(u.startParam, 't_abcdef23');
});

test('wrong bot token, tampered field, missing hash, junk', () => {
  const good = signInitData(fresh());
  assert.equal(verifyInitData(good, 'other:token', now), null);
  assert.equal(verifyInitData(good.replace('Ada', 'Eve'), TOKEN, now), null);
  assert.equal(verifyInitData(good.replace(/hash=[0-9a-f]+/, ''), TOKEN, now), null);
  for (const bad of ['', null, undefined, 42, 'hash=zz', 'x'.repeat(5000)]) assert.equal(verifyInitData(bad, TOKEN, now), null);
  assert.equal(verifyInitData(good, '', now), null);
});

test('stale or future auth_date is refused', () => {
  const old = signInitData(fresh({ auth_date: String(Math.floor(now / 1000) - 90000) }));
  assert.equal(verifyInitData(old, TOKEN, now), null);
  const future = signInitData(fresh({ auth_date: String(Math.floor(now / 1000) + 3600) }));
  assert.equal(verifyInitData(future, TOKEN, now), null);
});

test('bots and malformed users are refused', () => {
  assert.equal(verifyInitData(signInitData(fresh({ user: JSON.stringify({ id: 1, is_bot: true }) })), TOKEN, now), null);
  assert.equal(verifyInitData(signInitData(fresh({ user: '{nope' })), TOKEN, now), null);
  assert.equal(verifyInitData(signInitData(fresh({ user: JSON.stringify({ id: 'x' }) })), TOKEN, now), null);
});
