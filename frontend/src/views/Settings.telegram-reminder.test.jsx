// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// In the Mini App the bot is the only notification channel, and `/reminders on` refuses until a
// timezone is stored, so Settings has to be able to switch the reminder on and stamp the tz.
const mocks = vi.hoisted(() => ({ S: null, user: { uid: 'u1', name: 'Ana' } }))
vi.mock('../store/useStore.js', () => {
  const snapshot = () => ({
    S: mocks.S, user: mocks.user, coachLocal: null,
    update: mut => { const next = structuredClone(mocks.S); mut(next); mocks.S = next },
    replaceState: vi.fn(), resetEverything: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  const useStore = selector => selector ? selector(snapshot()) : snapshot()
  useStore.getState = snapshot
  return { useStore, DEF: { reminder: { on: false, time: '17:30', tz: null }, workouts: [] }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.resolve({ ok: true })), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/telegram.js', () => ({ IN_TELEGRAM: true }))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('../lib/coach-api.js', () => ({ forgetCoach: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

let host, root
beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none', gifSize: 'full', workouts: [], routines: [], exWeights: {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = () => act(() => root.render(<Settings />))
const reminderRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Workout day reminder'))

describe('Settings — reminder inside Telegram', () => {
  it('offers the workout day reminder, and switching it on stores the timezone', () => {
    mount()
    expect(reminderRow()).toBeTruthy()
    expect(host.textContent).not.toContain('Reminder time')
    act(() => { reminderRow().querySelector('[role=switch]').click() })
    mount()
    expect(mocks.S.reminder.on).toBe(true)
    expect(mocks.S.reminder.tz).toBeTruthy()
    expect(host.textContent).toContain('Reminder time')
  })

  it('shows no browser push switch', () => {
    mount()
    expect(host.textContent).not.toContain('Push notifications')
  })
})
