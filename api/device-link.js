/* One-time device links (#95).
 *
 * A signed-in device shows a code, and a QR code of a link that carries it. Another device of the
 * same person redeems it by creating a passkey of its own, and that passkey is what signs it in.
 * For those few minutes the code is the whole credential, so:
 *
 *   - 12 characters from the pairing alphabet (no 0/O/1/I), 60 bits, typed as XXXX-XXXX-XXXX when
 *     the other device cannot scan;
 *   - stored only as a SHA-256, like an admin's reset code: a copy of the database holds no code that
 *     works. The code is random, so a slow hash would add nothing;
 *   - one per profile — a new one replaces the one before — good for DEVICE_LINK_TTL_MS, and gone
 *     with the first passkey made with it. An expired one is dropped the next time links are read.
 *
 * Rows live in the `device_links` table (store.js); the routes, the throttle and the audit are server.js's. */
import crypto from 'node:crypto';

// Long enough to walk to the other device, find the camera and sign in; short enough that a code
// photographed off a screen is dead by the time anyone could use it.
export const DEVICE_LINK_TTL_MS = 10 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 12;

export function makeLinkCode() {
  // 256 is a multiple of 32, so the modulo is unbiased.
  const raw = Array.from(crypto.randomBytes(LENGTH), b => ALPHABET[b % ALPHABET.length]).join('');
  return raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8);
}
// Dashes, spaces and case are how a person types it, not part of it.
const clean = code => (typeof code === 'string' ? code : '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashLinkCode = code => crypto.createHash('sha256').update('opengym-link:' + clean(code)).digest('hex');

// → { code, link }. The code is returned once and never stored.
export async function createDeviceLink(store, userId, now = Date.now(), ttlMs = DEVICE_LINK_TTL_MS) {
  const code = makeLinkCode();
  const link = { h: hashLinkCode(code), userId, exp: now + ttlMs, created: now };
  await store.deviceLinks.create(userId, link);
  return { code, link };
}

// The live link a code belongs to, or null — a wrong code, a used one and an expired one all look
// the same from outside. Finding a link does not use it up; burnDeviceLink does.
export async function findDeviceLink(store, code, now = Date.now()) {
  if (clean(code).length !== LENGTH) return null;
  return store.deviceLinks.find(hashLinkCode(code), now);
}

// True for the request that actually burned it: of two racing with one code, only one gets true.
export const burnDeviceLink = (store, link) => store.deviceLinks.burn(link.h);

// Every unused link of a profile, for the moments its sessions end: an unused link is a way in
// waiting to be taken, like a pairing code.
export const dropDeviceLinks = (store, userId) => store.deviceLinks.dropFor(userId);
