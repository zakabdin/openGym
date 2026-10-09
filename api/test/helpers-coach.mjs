/* The Coach no longer reads state-<uid>.json: jobs.js asks an injectable source for a profile's
   training document (server.js points it at Postgres). Tests keep the documents in memory.
   `writeState(dir, uid, S)` keeps the shape of helpers.mjs's, so call sites read the same. A
   document is held as JSON text and parsed on every read, as a file was, so a job never shares
   an object with the test. */
export function makeStates(jobs) {
  const docs = new Map();
  jobs.setStateSource({
    read: async uid => (docs.has(uid) ? JSON.parse(docs.get(uid)) : null),
    ids: async () => [...docs.keys()]
  });
  return function writeState(_dir, uid, S) { docs.set(uid, JSON.stringify(S)); };
}
