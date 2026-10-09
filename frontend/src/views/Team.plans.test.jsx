// @vitest-environment happy-dom
// The trainer's side: a client row says where their plan stands, and "Make a plan" saves the new
// plan in the trainer's own saved list — never in the routines they train with.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'

const nav = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => nav, useParams: () => ({ id: 'c1' }) }))
const apiMock = vi.fn()
vi.mock('../lib/api.js', () => ({ api: (...a) => apiMock(...a) }))
const { default: Team, TeamClient } = await import('./Team.jsx')

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  nav.mockClear(); apiMock.mockReset()
  useStore.setState(s => ({ S: { ...s.S, routines: [{ id: 'mine', name: 'Mine', ex: [] }], trainerPlans: [] }, user: { id: 't', name: 'Zeka', role: 'trainer' } }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const route = map => apiMock.mockImplementation(async p => map[p.split('?')[0]] ?? {})

describe('client status chips', () => {
  it('says Plan waiting, Active or No plan yet', async () => {
    route({
      '/api/trainer/clients': { clients: [
        { id: 'a', name: 'Anna', workouts: 0, pending: 1, accepted: 0 },
        { id: 'b', name: 'Bo', workouts: 3, pending: 0, accepted: 2 },
        { id: 'c', name: 'Cy', workouts: 0, pending: 0, accepted: 0 }] },
      '/api/trainer/invite': { link: 'https://t.me/x?startapp=t_abc', code: 'abc' },
      '/api/trainer/mine': { trainer: null }, '/api/inbox': { items: [] }
    })
    await act(async () => { root.render(<Team />) })
    const t = host.textContent
    expect(t).toContain('Plan waiting'); expect(t).toContain('Active'); expect(t).toContain('No plan yet')
    expect(t).toContain('Invite a client')
  })
})

describe('Make a plan', () => {
  it('saves it as a saved plan, not a routine, and opens the editor for that client', async () => {
    route({ '/api/trainer/client': { client: { id: 'c1', name: 'Azer' }, unit: 'kg', bodyweight: [], workouts: [], assignments: [], routines: [] } })
    await act(async () => { root.render(<TeamClient />) })
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Make a plan for Azer'))
    await act(async () => { btn.click() })
    const S = useStore.getState().S
    expect(S.trainerPlans).toHaveLength(1)
    expect(S.routines.map(r => r.id)).toEqual(['mine'])
    expect(nav).toHaveBeenCalledWith('/team/plan/' + S.trainerPlans[0].id + '?for=c1')
  })
  it('reuses a saved plan as a copy', async () => {
    useStore.setState(s => ({ S: { ...s.S, trainerPlans: [{ id: 'tp', name: 'Push', emoji: null, ex: [{ id: '0025' }] }] } }))
    route({ '/api/trainer/client': { client: { id: 'c1', name: 'Azer' }, unit: 'kg', bodyweight: [], workouts: [], assignments: [], routines: [] } })
    await act(async () => { root.render(<TeamClient />) })
    const row = [...host.querySelectorAll('button, [role=button], .lrow')].find(b => b.textContent.includes('Push'))
    await act(async () => { row.click() })
    const plans = useStore.getState().S.trainerPlans
    expect(plans).toHaveLength(2)
    expect(plans[0].ex).toHaveLength(1); expect(plans[1].id).not.toBe('tp'); expect(plans[1].ex).toHaveLength(1)
  })
})
