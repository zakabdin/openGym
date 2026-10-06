// Running inside a Telegram Mini App. telegram-web-app.js (index.html) fills window.Telegram
// before the app starts; outside Telegram it is absent and everything here is a no-op, so the
// ordinary web and phone builds never notice it.
import { api, setRemoteAuth } from './api.js'

const wa = () => window.Telegram?.WebApp
// initData is empty when the script loaded in an ordinary browser, which is the signal.
export const IN_TELEGRAM = !!wa()?.initData

export function initTelegram() {
  const w = wa()
  if (!IN_TELEGRAM || !w) return
  try {
    w.ready()
    w.expand()
    w.disableVerticalSwipes?.()   // a swipe down would close the app mid-set
    document.documentElement.classList.add('tg')
  } catch { /* an old client without these calls */ }
}

// Signs in with initData and installs the Bearer token for every later request. The token is not
// kept: Telegram signs fresh initData on each launch, and a stored one would only outlive it.
export async function telegramSession() {
  const r = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: wa().initData }) })
  if (!r.token || !r.user?.id) throw Object.assign(new Error('bad sign-in answer'), { status: 200, code: 'bad-response' })
  setRemoteAuth('', r.token)
  return { user: r.user }
}

// Telegram's own back arrow in the header, so the app has one back control, not two.
export function bindTelegramBack(show, onBack) {
  const b = wa()?.BackButton
  if (!IN_TELEGRAM || !b) return () => {}
  if (!show) { b.hide(); return () => {} }
  b.show(); b.onClick(onBack)
  return () => { b.offClick(onBack); b.hide() }
}

export const telegramHaptic = kind => { try { wa()?.HapticFeedback?.notificationOccurred(kind) } catch { /* optional */ } }
