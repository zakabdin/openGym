import { describe, expect, it } from 'vitest'
import { quickDone, fileWorkout, recordsOf } from './finish-workout.js'
import { todayISO } from './format.js'

const S = (over = {}) => ({
  unit: 'kg', exWeights: {}, customEx: [], dayPlan: {}, workouts: [], bodyweight: [],
  routines: [
    { id: 'a', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }, { id: '0001', sets: 3, reps: 12, weight: 0 }] },
    { id: 'b', name: 'Pull', ex: [{ id: '0003', sets: 2, reps: 10, weight: 20 }] }
  ],
  week: {}, ...over
})

describe('quickDone — today logged as planned, without a session', () => {
  it('ticks every planned set at its planned weight and reps, dated today', () => {
    const r = quickDone(S(), ['a'], { minutes: 40, now: Date.parse('2026-10-10T10:00:00Z') })
    expect(r.w.d).toBe(todayISO())
    expect(r.w.name).toBe('Push')
    expect(r.w.entries.map(e => e.id)).toEqual(['0025', '0001'])
    const bench = r.w.entries[0]
    expect(bench.sets.every(s => s.done)).toBe(true)
    expect(bench.sets.filter(s => !s.warm).some(s => s.w === 60 && s.r === 8)).toBe(true)
    expect(bench.topW).toBeGreaterThan(0)
    expect(r.w.end - r.w.start).toBe(40 * 60000)
    expect(r.w.vol).toBeGreaterThan(0)
    expect(r.w.active).toBeUndefined()
  })

  it('combines several routines of the day into one session named for them', () => {
    const r = quickDone(S(), ['a', 'b'])
    expect(r.w.name).toBe('Push + Pull')
    expect(r.w.entries.map(e => e.id)).toEqual(['0025', '0001', '0003'])
    expect(r.w.routineIds).toEqual(['a', 'b'])
  })

  it('estimates the time from the sets when none is given, and ignores a silly one', () => {
    const none = quickDone(S(), ['a'])
    expect(none.minutes).toBeGreaterThanOrEqual(10)
    expect(none.minutes).toBeLessThanOrEqual(240)
    expect(quickDone(S(), ['a'], { minutes: 9999 }).minutes).toBe(none.minutes)
    expect(quickDone(S(), ['a'], { minutes: 0 }).minutes).toBe(none.minutes)
    expect(quickDone(S(), ['a'], { minutes: 45 }).minutes).toBe(45)
  })

  it('has nothing to log for no routine', () => {
    expect(quickDone(S(), [])).toBeNull()
    expect(quickDone(S(), ['gone'])).toBeNull()
  })

  it('files it like a finished session: in the history, and the heaviest weight moves on', () => {
    const s = S()
    const r = quickDone(s, ['a'])
    fileWorkout(s, r.w)
    expect(s.workouts).toHaveLength(1)
    expect(s.exWeights['0025'].w).toBe(60)
    expect(s.exWeights['0025'].d).toBe(todayISO())
  })

  it('feeds progression like any finished session: the next one is planned heavier, and that is a record', () => {
    const s = S()
    const first = quickDone(s, ['a'])
    expect(first.prs).toContain('0025')
    fileWorkout(s, first.w)
    const next = quickDone(s, ['a'])
    expect(next.w.entries[0].sets[0].w).toBeGreaterThan(60)
    expect(next.prs).toContain('0025')
    // the same weight again is not a record
    expect(recordsOf(s, first.w.entries).prs).not.toContain('0025')
  })
})
