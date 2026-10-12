// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// IN_TELEGRAM is decided when the module loads, so each case sets up window.Telegram first.
async function load(webApp) {
  vi.resetModules()
  window.Telegram = { WebApp: { initData: 'x=1', ready() {}, expand() {}, ...webApp } }
  vi.doMock('./api.js', () => ({ api: vi.fn(() => new Promise(() => {})), setRemoteAuth: vi.fn(), gateRequests: vi.fn() }))
  return import('./telegram.js')
}

describe('askBotMessages: ask Telegram for permission to message the person, once', () => {
  beforeEach(() => localStorage.clear())

  it('asks when the bot is not allowed to write, and not a second time', async () => {
    const requestWriteAccess = vi.fn()
    const { askBotMessages } = await load({ requestWriteAccess, initDataUnsafe: { user: { allows_write_to_pm: false } } })
    expect(askBotMessages()).toBe(true)
    expect(askBotMessages()).toBe(false)
    expect(requestWriteAccess).toHaveBeenCalledTimes(1)
  })

  it('does not ask when the person already allowed it, or the client cannot ask', async () => {
    const requestWriteAccess = vi.fn()
    let m = await load({ requestWriteAccess, initDataUnsafe: { user: { allows_write_to_pm: true } } })
    expect(m.askBotMessages()).toBe(false)
    m = await load({ initDataUnsafe: { user: { allows_write_to_pm: false } } })
    expect(m.askBotMessages()).toBe(false)
    expect(requestWriteAccess).not.toHaveBeenCalled()
  })
})
