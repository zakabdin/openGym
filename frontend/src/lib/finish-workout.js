// The persisted boundary for a finished session. Keep this pure so compatibility tests can
// exercise the exact shape the UI writes without mounting React or mutating store state.
import { bestWeightForEntry, bestWeightFor, cleanupSg, workoutVolume } from './history.js'
import { hasCompletedWork, isSideSet, isWarmupRow } from './workout-model.js'
import { betterWeight, beatsWeight, EXIDX } from './exercises.js'
import { is1RMRecord } from './onerm.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { markAllSetsDone } from './backfill.js'
import { buildCombinedEntries, deriveSessionName } from './session-merge.js'
import { uid, todayISO } from './format.js'

// planSec is live-session bookkeeping: a hold displaced before it finished puts its plan aside so
// the row still knows what it is asking for (Workout.startTimed). A finished session keeps only
// what was logged, so the key never reaches S.workouts — an unfinished row goes back to recording
// its plan, exactly as it did before any of this.
//
// weightOrigin is the same kind of bookkeeping (#209): it marks a load typed by hand so a later
// edit of an earlier set does not cascade over it. Once the session is over there is nothing left
// to cascade, and every load in history is simply the one logged. Kept, it would ride into the
// saved workout, the server copy and every backup as a field nothing reads — on the row and on
// each side of a per-side row, where the side keeps its own.
//
// Rows that carry neither are passed through by reference, so an ordinary session is the shape
// it always was.
function finishedRow(set) {
  if (!set) return set
  const sideMarked = isSideSet(set) && (set.sides.L.weightOrigin != null || set.sides.R.weightOrigin != null)
  if (set.planSec == null && set.weightOrigin == null && !sideMarked) return set
  const { planSec, weightOrigin, ...rest } = set
  if (sideMarked) {
    const side = ({ weightOrigin: _, ...kept }) => kept
    rest.sides = { ...rest.sides, L: side(rest.sides.L), R: side(rest.sides.R) }
  }
  return planSec == null || rest.done ? rest : { ...rest, sec: planSec }
}

export function buildCompletedWorkout(active, { end = Date.now(), prs = [], snapshotFor } = {}) {
  const entries = (active?.entries || []).map(entry => {
    const completed = {
      id: entry.id,
      // Only what was logged — the live-session bookkeeping on a row stays behind (finishedRow).
      sets: (entry.sets || []).map(finishedRow),
      topW: bestWeightForEntry(entry) || null,
      target: entry.target || null,
      // Which routine this entry came from, and whether it counts for progression. Written
      // only when set/true, so a single-routine non-excluded session is byte-for-byte the
      // shape it always was. Without this the whitelist drops both at finish.
      ...(entry.rid ? { rid: entry.rid } : {}),
      ...(entry.noProg === true ? { noProg: true } : {}),
      // What the routine asked for when the session was built (session-start.js), next to the
      // target the prescription moved — how the next session tells an edited plan (#275).
      ...(entry.planned ? { planned: entry.planned } : {}),
      // The superset the exercise was done in, so the history can show the pairing. Without it
      // the workout forgot at finish what it had been all session.
      ...(entry.sg ? { sg: entry.sg } : {}),
    }
    const snapshot = typeof snapshotFor === 'function' ? snapshotFor(entry) : null
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Object.keys(snapshot).length) {
      completed.muscleSnapshot = { ...snapshot }
    }
    // What you typed about this exercise today, and whether you asked to see it again next
    // time. Written only when there is something to keep, so an untouched entry is byte-for-byte
    // the shape it always was.
    const note = (entry.note || '').trim()
    if (note) {
      completed.note = note
      if (entry.notePin) completed.notePin = true
    }
    return completed
  }).filter(entry => entry.sets.some(hasCompletedWork))
  // An exercise left without a single set drops out above, and its partner is then a superset
  // of one. cleanupSg clears the tag it no longer shares with a neighbour; the entries are this
  // function's own copies, so the running session is left alone.
  cleanupSg(entries)

  const sessionNote = (active?.note || '').trim()
  const routineIds = [].concat(active?.routineIds ?? (active?.routineId ? [active.routineId] : []))
  // Legacy `w.excludeFromProgression` mirror: kept for older builds and external readers, but
  // it only makes sense when the *whole* session is excluded. Derived from the completed
  // entries, not read from `active` (which no longer carries the flag). A mixed session omits
  // it — that case is new territory only the per-entry `noProg` readers handle.
  const allNoProg = entries.length > 0 && entries.every(e => e.noProg === true)

  return {
    id: active.id,
    d: active.d,
    start: active.start,
    end,
    routineIds,
    routineId: routineIds[0] ?? null,
    name: active.name,
    bw: active.bw,
    entries,
    prs,
    ...(allNoProg ? { excludeFromProgression: true } : {}),
    ...(sessionNote ? { note: sessionNote } : {}),
  }
}

/**
 * What a session just finished is a record in: the exercises whose heaviest completed set beat the best
 * so far, and those whose estimated 1RM did without a heavier top set (the same weight for more reps).
 * `st` is the state BEFORE the session is filed. → { prs: [exerciseId], e1prs: [{ id, ... }] }
 */
export function recordsOf(st, entries) {
  const prs = [], e1prs = []
  for (const e of entries) {
    const loads = e.sets.filter(s => s.done && !isWarmupRow(s)).map(s => s.w).filter(w => w > 0)
    const mx = loads.length ? loads.reduce((a, b) => betterWeight(e.id, a, b)) : 0
    if (beatsWeight(e.id, mx, bestWeightFor(st, e.id))) prs.push(e.id)
    const rec = is1RMRecord(st, e.id, e)
    if (rec && !prs.includes(e.id)) e1prs.push({ id: e.id, ...rec })
  }
  return { prs, e1prs }
}

/**
 * Today's planned routines logged as done exactly as planned — every set ticked at the planned weight and
 * reps, the way "mark all sets done" does for a past workout. `minutes` is how long it took; without it the
 * time is an estimate from the number of sets. Pure: returns the finished workout, nothing is stored.
 * → { w, prs, e1prs, minutes } | null when the routines hold nothing to log
 */
export function quickDone(S, routineIds, { minutes, now = Date.now() } = {}) {
  const { entries, routineIds: rids, routines } = buildCombinedEntries(S, routineIds)
  const done = markAllSetsDone(entries).filter(e => e.sets.some(s => s.done))
  if (!done.length) return null
  const workSets = done.reduce((n, e) => n + e.sets.filter(s => s.done && !isWarmupRow(s)).length, 0)
  const given = Math.round(Number(minutes))
  const mins = given >= 1 && given <= 600 ? given : Math.min(240, Math.max(10, Math.round(workSets * 2.5)))
  const A = {
    id: uid(), d: todayISO(), start: now - mins * 60000, routineIds: rids,
    name: routines.length ? deriveSessionName(routines.map(r => r.name)) : '', bw: null, cur: 0, entries: done
  }
  const { prs, e1prs } = recordsOf(S, A.entries)
  const w = buildCompletedWorkout(A, { end: now, prs, snapshotFor: e => (EXIDX[e.id]?.custom ? exerciseMuscleSnapshot(EXIDX[e.id]) : null) })
  w.vol = workoutVolume(w)
  return { w, prs, e1prs, minutes: mins }
}

/** File a finished session in the state `s` (call inside store.update): the heaviest weights move on too. */
export function fileWorkout(s, w) {
  w.entries.forEach(e => {
    const mx = bestWeightForEntry(e)
    if (mx > 0 && beatsWeight(e.id, mx, (s.exWeights[e.id] || {}).w || 0)) s.exWeights[e.id] = { w: mx, d: w.d }
  })
  s.workouts.push(w)
}
