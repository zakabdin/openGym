// @vitest-environment happy-dom
// The screen behind the button under the bot's "your trainer sent you a plan" message: it opens that plan's
// preview by itself, and says so plainly when the plan is gone or was already answered.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'

const env = vi.hoisted(() => ({ id: 'a1', nav: vi.fn(), preview: vi.fn() }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: env.id }), useNavigate: () => env.nav }))
const apiMock = vi.fn()
vi.mock('../lib/api.js', () => ({ api: (...a) => apiMock(...a) }))
vi.mock('../components/PlanInbox.jsx', () => ({ planTitle: i => i.bundle?.name || 'New plan', openPlanPreview: (...a) => env.preview(...a) }))
const { default: InboxPlan } = await import('./InboxPlan.jsx')

let host, root
const item = over => ({ id: 'a1', fromName: 'Coach', status: 'pending', bundle: { name: 'Strength block' }, ...over })
const mount = async () => { await act(async () => { root.render(<InboxPlan />) }); await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  apiMock.mockReset(); env.nav.mockClear(); env.preview.mockClear(); env.id = 'a1'
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the plan from the trainer, opened from the bot message', () => {
  it('opens the preview of that plan, once, and names it and the trainer', async () => {
    apiMock.mockResolvedValue({ items: [item({ id: 'zz' }), item()] })
    await mount()
    expect(env.preview).toHaveBeenCalledTimes(1)
    expect(env.preview.mock.calls[0][0].id).toBe('a1')
    expect(host.textContent).toContain('Strength block · from Coach')
    // answering sends the person to Home
    env.preview.mock.calls[0][1]()
    expect(env.nav).toHaveBeenCalledWith('/home')
  })
  it('says so when the plan was already answered or is gone, without opening anything', async () => {
    apiMock.mockResolvedValue({ items: [item({ status: 'accepted' })] })
    await mount()
    expect(host.textContent).toContain('You already answered this plan.')
    apiMock.mockResolvedValue({ items: [] })
    await act(async () => { root.unmount(); root = createRoot(host); root.render(<InboxPlan />) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.textContent).toContain('This plan is no longer here.')
    expect(env.preview).not.toHaveBeenCalled()
  })
  it('offers a retry when the inbox cannot be read', async () => {
    apiMock.mockRejectedValue(new Error('offline'))
    await mount()
    expect(host.textContent).toContain('Could not load the plan')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toContain('Try again')
  })
})
