// @vitest-environment happy-dom
// The screen the bot's PDF buttons open: it makes the PDF here, drops it into the person's chat and
// closes. A rest day has nothing to send; a refusal says what to do; outside Telegram it just shares.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { todayISO } from '../lib/format.js'

const env = vi.hoisted(() => ({ kind: 'plan', inTelegram: true }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ kind: env.kind }), useNavigate: () => vi.fn() }))
const apiMock = vi.fn()
vi.mock('../lib/api.js', () => ({ api: (...a) => apiMock(...a) }))
const pdf = vi.hoisted(() => ({
  makePdfFor: vi.fn(), blobToBase64: vi.fn(async () => 'QkFTRTY0'), getPdfPictures: () => true, sharePlanPdf: vi.fn(async () => 'downloaded')
}))
vi.mock('../lib/plan-pdf.js', () => pdf)
const tg = vi.hoisted(() => ({ close: vi.fn(), haptic: vi.fn() }))
vi.mock('../lib/telegram.js', () => ({ get IN_TELEGRAM() { return env.inTelegram }, telegramClose: tg.close, telegramHaptic: tg.haptic }))
const { default: PdfToChat } = await import('./PdfToChat.jsx')

let host, root
const mount = async () => { await act(async () => { root.render(<PdfToChat />) }); await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useRealTimers()
  apiMock.mockReset().mockResolvedValue({ ok: true })
  pdf.makePdfFor.mockReset().mockResolvedValue({ blob: new Blob(['%PDF']), title: 'Weekly Training Plan' })
  pdf.sharePlanPdf.mockClear(); tg.close.mockClear(); tg.haptic.mockClear()
  env.kind = 'plan'; env.inTelegram = true
  const today = todayISO()
  useStore.setState(s => ({
    S: { ...s.S, unit: 'kg', routines: [{ id: 'a', name: 'Push', ex: [] }, { id: 'b', name: 'Pull', ex: [] }], week: { [new Date(today + 'T12:00:00').getDay()]: ['a', 'b'] }, dayPlan: {} },
    user: { id: 'u', name: 'Ana' }
  }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('PdfToChat', () => {
  it('makes the plan PDF, posts it to the chat route and says it was sent', async () => {
    await mount()
    expect(pdf.makePdfFor).toHaveBeenCalledWith('plan', expect.anything(), 'Ana', expect.objectContaining({ pictures: true }))
    expect(apiMock).toHaveBeenCalledOnce()
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe('/api/telegram/document')
    expect(JSON.parse(init.body)).toEqual({ name: 'Weekly Training Plan', caption: 'Weekly Training Plan', data: 'QkFTRTY0' })
    expect(host.textContent).toContain('Sent to your chat')
    expect(tg.haptic).toHaveBeenCalledWith('success')
  })

  it("makes today's PDF from the routines planned for today, together", async () => {
    env.kind = 'today'
    await mount()
    expect(pdf.makePdfFor).toHaveBeenCalledWith('today', expect.anything(), 'Ana', expect.objectContaining({ today: ['a', 'b'] }))
    expect(apiMock).toHaveBeenCalledOnce()
  })

  it('has nothing to send on a rest day', async () => {
    env.kind = 'today'
    pdf.makePdfFor.mockResolvedValue(null)
    await mount()
    expect(apiMock).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Rest day — no workout to send.')
  })

  it('tells the person what to do when Telegram refuses the file', async () => {
    apiMock.mockRejectedValue(new Error('502'))
    await mount()
    expect(host.textContent).toContain('open the bot chat and press Start')
    expect(tg.close).not.toHaveBeenCalled()
  })

  it('outside Telegram it offers the file instead', async () => {
    env.inTelegram = false
    await mount()
    expect(pdf.sharePlanPdf).toHaveBeenCalledOnce()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('makes the other PDF when the screen is reused for it', async () => {
    await mount()
    env.kind = 'today'
    await act(async () => { root.render(<PdfToChat />) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(pdf.makePdfFor.mock.calls.map(c => c[0])).toEqual(['plan', 'today'])
  })

  it('makes it once, however often the screen renders', async () => {
    await mount()
    await act(async () => { root.render(<PdfToChat />) })
    expect(pdf.makePdfFor).toHaveBeenCalledOnce()
  })
})
