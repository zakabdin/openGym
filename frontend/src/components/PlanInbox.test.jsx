// @vitest-environment happy-dom
// A plan from the trainer, from the client's side: Home shows one banner while a plan waits, and
// "Start this plan" sets the week only when the plan names days — a plan without days must not
// blank the client's own week.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { buildPlanBundle } from '../lib/plan-share.js'

const apiMock = vi.fn()
vi.mock('../lib/api.js', () => ({ api: (...a) => apiMock(...a) }))
const { default: PlanBanner, startPlan, planTitle } = await import('./PlanInbox.jsx')

const bundle = week => buildPlanBundle({
  unit: 'kg', customEx: [], week,
  routines: [{ id: 'p', name: 'Push day A', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] }],
}, '')
const item = week => ({ id: 'a1', fromName: 'Coach', note: 'Go light', status: 'pending', bundle: bundle(week) })

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  apiMock.mockReset().mockResolvedValue({ ok: true })
  useStore.setState(s => ({ S: { ...s.S, unit: 'kg', routines: [{ id: 'mine', name: 'Mine', ex: [] }], week: { 2: ['mine'] }, dayPlan: {}, customEx: [], programs: [] }, user: { id: 'u', name: 'Azer', trainerId: 't' } }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('startPlan', () => {
  it('sets the week when the plan has days', async () => {
    await startPlan(item({ 1: ['p'], 3: ['p'] }))
    const S = useStore.getState().S
    expect(Object.keys(S.week).sort()).toEqual(['1', '3'])
    expect(S.routines.map(r => r.name)).toContain('Push day A')
    expect(apiMock).toHaveBeenCalledWith('/api/inbox/resolve', expect.objectContaining({ method: 'POST' }))
  })
  it('leaves the client\'s own week alone when the plan has no days', async () => {
    await startPlan(item({}))
    const S = useStore.getState().S
    expect(S.week).toEqual({ 2: ['mine'] })
    expect(S.routines.map(r => r.name)).toEqual(['Mine', 'Push day A'])
  })
})

describe('planTitle', () => {
  it('uses the plan name, else the first workout', () => {
    expect(planTitle({ bundle: { name: 'Block A', routines: [{ name: 'X' }] } })).toBe('Block A')
    expect(planTitle(item({}))).toBe('Push day A')
  })
})

describe('PlanBanner', () => {
  it('shows who sent a plan, once, and nothing when nothing waits', async () => {
    apiMock.mockResolvedValue({ items: [item({}), { ...item({}), id: 'a2' }, { ...item({}), id: 'a3', status: 'accepted' }] })
    await act(async () => { root.render(<PlanBanner />) })
    expect(host.textContent).toContain('Coach sent you a plan')
    expect(host.textContent).toContain('+ 1 more')
    apiMock.mockResolvedValue({ items: [] })
    await act(async () => { root.unmount(); root = createRoot(host); root.render(<PlanBanner />) })
    expect(host.textContent).toBe('')
  })
  it('does not ask the server when the profile has no trainer', async () => {
    useStore.setState(s => ({ user: { ...s.user, trainerId: undefined } }))
    await act(async () => { root.render(<PlanBanner />) })
    expect(apiMock).not.toHaveBeenCalled()
  })
})
