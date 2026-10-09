/* Shared by the sign-in suites (server-passkeys, server-password): the database read-backs
   that used to be "parse db.json" / "parse audit.log". */

// Every passkey row, in the shape the old db.json had (`userId`, `lastUsed`; absent when null).
export async function allCreds(db) {
  const r = await db.store.q('SELECT * FROM credentials ORDER BY seq');
  return r.rows.map(x => ({
    id: x.id, userId: x.user_id, publicKey: x.public_key, counter: Number(x.counter),
    ...(x.transports ? { transports: x.transports } : {}),
    ...(x.name ? { name: x.name } : {}),
    ...(x.created ? { created: x.created } : {}),
    ...(x.last_used ? { lastUsed: x.last_used } : {})
  }));
}

// Pending device links as db.json held them: { h, userId, exp, created }.
export async function allLinks(db) {
  return (await db.deviceLinks()).map(l => ({ h: l.h, userId: l.user_id, exp: Number(l.exp), created: Number(l.created) }));
}
