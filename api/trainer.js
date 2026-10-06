/* Trainer / trainee bookkeeping.
 *
 * A trainer is a user with `role: 'trainer'` and a reusable `trainerCode`; a trainee is any user
 * whose `trainerId` names one. Programs a trainer sends do not touch the trainee's own state
 * document (a trainee's PUT /api/data would race with it); they wait in `assignments-<uid>.json`,
 * which only these helpers write, until the trainee accepts or declines.
 *
 * Pure bookkeeping over db.users and that file's contents; routes, auth and audit are server.js's. */
import crypto from 'node:crypto';

export const ROLES = ['trainer', 'trainee'];
export const MAX_ASSIGNMENTS = 50;              // pending + history kept per trainee
export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_NOTE = 500;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const makeTrainerCode = () =>
  Array.from(crypto.randomBytes(10), b => ALPHABET[b % ALPHABET.length]).join('');

// "t_<code>" is what a deep link carries in `startapp`.
export const trainerCodeFromStart = p => (/^t_([a-z0-9]{6,32})$/.exec(p || '') || [])[1] || null;

export const findTrainerByCode = (users, code) =>
  code ? users.find(u => u.role === 'trainer' && u.trainerCode === code && !u.disabled) || null : null;

export const clientsOf = (users, trainerId) => users.filter(u => u.trainerId === trainerId && !u.disabled);
export const isClientOf = (user, trainer) => !!user && !!trainer && user.trainerId === trainer.id && trainer.role === 'trainer';

// Accept only what lib/plan-share.js buildPlanBundle produces (routines, week, customEx and its header).
// Anything else is dropped, so a trainer cannot smuggle keys into the trainee's state.
export function cleanBundle(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.routines)) return null;
  const routines = b.routines.filter(r => r && typeof r === 'object' && typeof r.name === 'string' && Array.isArray(r.ex));
  if (!routines.length) return null;
  // The scalar header buildPlanBundle writes (format marker, unit, name) rides along: the app's
  // parsePlan refuses a bundle without it, and converts prescriptions by `unit`.
  const out = {
    ...(b.opengym_plan != null ? { opengym_plan: b.opengym_plan } : {}),
    ...(b.unit === 'kg' || b.unit === 'lb' ? { unit: b.unit } : {}),
    ...(typeof b.name === 'string' ? { name: b.name.slice(0, 80) } : {}),
    routines,
    week: b.week && typeof b.week === 'object' && !Array.isArray(b.week) ? b.week : {},
    customEx: Array.isArray(b.customEx) ? b.customEx.filter(e => e && typeof e === 'object') : []
  };
  return JSON.stringify(out).length > MAX_BUNDLE_BYTES ? null : out;
}

export function newAssignment({ from, fromName, note, bundle, now = Date.now() }) {
  return {
    id: crypto.randomBytes(9).toString('base64url'),
    from, fromName: String(fromName || '').slice(0, 60),
    note: String(note || '').slice(0, MAX_NOTE),
    bundle, created: now, status: 'pending'
  };
}

// Newest first, capped; resolved ones go before pending ones are ever dropped.
export function addAssignment(list, a) {
  const all = [a, ...(Array.isArray(list) ? list : [])];
  if (all.length <= MAX_ASSIGNMENTS) return all;
  const pending = all.filter(x => x.status === 'pending');
  const done = all.filter(x => x.status !== 'pending');
  return [...pending, ...done].slice(0, MAX_ASSIGNMENTS).sort((x, y) => y.created - x.created);
}

export function resolveAssignment(list, id, status, now = Date.now()) {
  if (status !== 'accepted' && status !== 'declined') return null;
  const a = (Array.isArray(list) ? list : []).find(x => x.id === id);
  if (!a || a.status !== 'pending') return null;
  a.status = status; a.resolved = now;
  return a;
}
