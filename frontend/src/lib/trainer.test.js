import { describe, expect, it } from 'vitest'
import { applyProgram, undoProgram } from './trainer.js'
import { buildPlanBundle } from './plan-share.js'

// A program is what the trainer's own app exports with buildPlanBundle.
const bundleOf = () => buildPlanBundle({
  unit: 'kg', customEx: [], week: { 1: ['p'], 3: ['p'] },
  routines: [{ id: 'p', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] }],
}, 'Block A')
const item = { id: 'a1', fromName: 'Coach', note: 'Week 1', bundle: bundleOf() }
const mine = () => ({
  unit: 'kg', customEx: [], dayPlan: {},
  routines: [{ id: 'mine', name: 'Mine', ex: [] }],
  week: { 2: ['mine'] },
})

describe('applyProgram', () => {
  it('adds the routines as new ones and leaves the client\'s week alone by default', () => {
    const s = mine()
    const r = applyProgram(s, item)
    expect(r.routines).toBe(1)
    expect(s.routines.map(x => x.name)).toEqual(['Mine', 'Push'])
    expect(s.routines[1].id).not.toBe('p')
    expect(s.week).toEqual({ 2: ['mine'] })
    expect(s.programs[0]).toMatchObject({ id: 'a1', name: 'Block A', from: 'Coach', routineIds: [s.routines[1].id] })
  })

  it('replaces the week when asked, pointing at the new ids', () => {
    const s = mine()
    applyProgram(s, item, { schedule: true })
    const id = s.routines[1].id
    expect(s.week).toEqual({ 1: [id], 3: [id] })
  })

  it('refuses something that is not a plan, changing nothing', () => {
    const s = mine()
    expect(() => applyProgram(s, { id: 'x', bundle: { routines: [] } })).toThrow()
    expect(s.routines).toHaveLength(1)
    expect(s.programs).toBeUndefined()
  })

  it('keeps one record per program when applied twice', () => {
    const s = mine()
    applyProgram(s, item); applyProgram(s, item)
    expect(s.programs).toHaveLength(1)
  })
})

describe('undoProgram', () => {
  it('removes the routines and restores the previous week', () => {
    const s = mine()
    applyProgram(s, item, { schedule: true })
    expect(undoProgram(s, 'a1')).toBe(true)
    expect(s.routines.map(r => r.id)).toEqual(['mine'])
    expect(s.week).toEqual({ 2: ['mine'] })
    expect(s.programs).toEqual([])
  })

  it('without a schedule change, clears only what pointed at the program', () => {
    const s = mine()
    applyProgram(s, item)
    const id = s.routines[1].id
    s.week[5] = [id, 'mine']; s.dayPlan['2026-10-07'] = id; s.dayPlan['2026-10-08'] = 'mine'
    undoProgram(s, 'a1')
    expect(s.week).toEqual({ 2: ['mine'], 5: ['mine'] })
    expect(s.dayPlan).toEqual({ '2026-10-08': 'mine' })
  })

  it('is false for a program it never applied', () => {
    expect(undoProgram(mine(), 'nope')).toBe(false)
  })
})
