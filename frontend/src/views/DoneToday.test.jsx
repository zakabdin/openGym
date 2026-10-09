// @vitest-environment happy-dom
// The screen behind the bot's /done button: logs today's plan, saves it before closing, tells the chat — and
// leaves alone a workout that is running, already logged today, or not planned.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { todayISO } from '../lib/format.js'

const env = vi.hoisted(() => ({ minutes: undefined, inTelegram: true }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ minutes: env.minutes }), useNavigate: () => vi.fn() }))
const apiMock = vi.fn()
vi.mock('../lib/api.js', () => ({ api: (...a) => apiMock(...a) }))
const tg = vi.hoisted(() => ({ close: vi.fn(), haptic: vi.fn() }))
vi.mock('../lib/telegram.js', () => ({ get IN_TELEGRAM() { return env.inTelegram }, telegramClose: tg.close, telegramHaptic: tg.haptic }))
const { default: DoneToday } = await import('./DoneToday.jsx')

let host, root, push
const wd = () => new Date(todayISO() + 'T12:00:00').getDay()
const base = over => ({
  unit: 'kg', exWeights: {}, customEx: [], dayPlan: {}, workouts: [], bodyweight: [], active: null,
  routines: [{ id: 'a', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }],
  week: { [wd()]: ['a'] }, ...over
})
const mount = async () => { await act(async () => { root.render(<DoneToday />) }); await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  apiMock.mockReset().mockResolvedValue({ ok: true })
  tg.close.mockClear(); tg.haptic.mockClear()
  env.minutes = undefined; env.inTelegram = true
  push = vi.fn(async () => {})
  useStore.setState(s => ({ S: { ...s.S, ...base() }, user: { id: 'u', name: 'Ana' }, pushState: push }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('DoneToday', () => {
  it("logs today's planned workout, saves it to the server, then tells the chat", async () => {
    env.minutes = '45'
    await mount()
    const S = useStore.getState().S
    expect(S.workouts).toHaveLength(1)
    expect(S.workouts[0].d).toBe(todayISO())
    expect(S.workouts[0].end - S.workouts[0].start).toBe(45 * 60000)
    expect(push).toHaveBeenCalledOnce()
    expect(apiMock).toHaveBeenCalledWith('/api/telegram/say', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(apiMock.mock.calls[0][1].body)).toEqual({ key: 'workoutLogged', name: 'Push' })
    expect(host.textContent).toContain('Workout logged')
    expect(tg.haptic).toHaveBeenCalledWith('success')
  })

  it('does not log a second one for a day that already has a workout', async () => {
    useStore.setState(s => ({ S: { ...s.S, workouts: [{ id: 'w', d: todayISO(), entries: [] }] } }))
    await mount()
    expect(useStore.getState().S.workouts).toHaveLength(1)
    expect(push).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Already logged today')
  })

  it('leaves a workout in progress alone', async () => {
    useStore.setState(s => ({ S: { ...s.S, active: { id: 'x', entries: [] } } }))
    await mount()
    expect(useStore.getState().S.workouts).toHaveLength(0)
    expect(host.textContent).toContain('in progress in the app')
  })

  it('has nothing to log on a rest day', async () => {
    useStore.setState(s => ({ S: { ...s.S, week: {} } }))
    await mount()
    expect(useStore.getState().S.workouts).toHaveLength(0)
    expect(host.textContent).toContain('Rest day — no workout to log.')
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('says so when saving fails, and never closes on its own then', async () => {
    push.mockRejectedValue(new Error('x'))
    await mount()
    expect(host.textContent).toContain('Could not log the workout')
    expect(tg.close).not.toHaveBeenCalled()
  })

  it('logs only once however often it renders', async () => {
    await mount()
    await act(async () => { root.render(<DoneToday />) })
    expect(useStore.getState().S.workouts).toHaveLength(1)
  })
})
