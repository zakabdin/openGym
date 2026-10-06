// Applying and taking back a program a trainer sent (api/trainer.js keeps it in the client's
// inbox until they answer). Pure edits of a draft state `s` — call inside store.update — built on
// plan-share's merge, so a program arrives exactly like an imported plan: new routines with fresh
// ids, never over the client's own, and the week replaced only when asked for.
import { parsePlan, mergePlan } from './plan-share.js'

const MAX_PROGRAMS = 20
const clone = v => JSON.parse(JSON.stringify(v))

/**
 * Merge the inbox item's bundle into `s` and record what was added in `s.programs`, which is what
 * undoProgram reads. Throws (parsePlan's message) when the bundle is not a plan.
 * → { routines, dropped }
 */
export function applyProgram(s, item, { schedule = false } = {}) {
  const parsed = parsePlan(item.bundle, s.unit)
  s.routines = s.routines || []
  s.week = s.week || {}
  const had = new Set(s.routines.map(r => r.id))
  const prevWeek = schedule ? clone(s.week) : null
  mergePlan(s, parsed, { schedule })
  const routineIds = s.routines.filter(r => !had.has(r.id)).map(r => r.id)
  s.programs = [
    {
      id: item.id, name: parsed.name || item.note || '', from: item.fromName || '',
      routineIds, ...(prevWeek ? { prevWeek } : {}), at: Date.now()
    },
    ...(s.programs || []).filter(p => p.id !== item.id)
  ].slice(0, MAX_PROGRAMS)
  return { routines: routineIds.length, dropped: parsed.dropped }
}

/**
 * Take a program back: its routines go, every day and date that pointed at them is cleared, and
 * the week it replaced comes back. Returns false when there is no such program.
 */
export function undoProgram(s, id) {
  const p = (s.programs || []).find(x => x.id === id)
  if (!p) return false
  const gone = new Set(p.routineIds)
  s.routines = (s.routines || []).filter(r => !gone.has(r.id))
  if (p.prevWeek) s.week = clone(p.prevWeek)
  else {
    Object.keys(s.week || {}).forEach(d => {
      const ids = [].concat(s.week[d]).filter(x => !gone.has(x))
      if (ids.length) s.week[d] = ids; else delete s.week[d]
    })
  }
  Object.keys(s.dayPlan || {}).forEach(d => { if (gone.has(s.dayPlan[d])) delete s.dayPlan[d] })
  s.programs = s.programs.filter(x => x.id !== id)
  return true
}
