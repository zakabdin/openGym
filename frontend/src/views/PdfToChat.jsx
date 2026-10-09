import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { effectiveRoutineIds } from '../lib/history.js'
import { makePdfFor, blobToBase64, getPdfPictures, sharePlanPdf } from '../lib/plan-pdf.js'
import { IN_TELEGRAM, telegramClose, telegramHaptic } from '../lib/telegram.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// Opened by the bot's PDF button (/plan, /today): makes the PDF here, where the exercise catalogue is,
// drops it into the person's own Telegram chat, and closes. Outside Telegram it just offers the file.
export default function PdfToChat() {
  const { kind } = useParams()
  const nav = useNavigate()
  const [status, setStatus] = useState('working')   // working | sent | rest | error
  const ran = useRef(null)   // which kind has been started, so a re-render never makes it twice

  useEffect(() => {
    if (ran.current === kind) return
    ran.current = kind
    setStatus('working')
    const { S, user } = useStore.getState()
    const owner = user?.name || ''
    const which = kind === 'today' ? 'today' : 'plan'
    ;(async () => {
      try {
        if (!IN_TELEGRAM) { await sharePlanPdf(S, owner, which === 'today' ? { routineIds: effectiveRoutineIds(S, todayISO()), pictures: getPdfPictures() } : { pictures: getPdfPictures() }); setStatus('sent'); return }
        const made = await makePdfFor(which, S, owner, { pictures: getPdfPictures(), today: which === 'today' ? effectiveRoutineIds(S, todayISO()) : undefined })
        if (!made) { setStatus('rest'); return }
        const data = await blobToBase64(made.blob)
        await api('/api/telegram/document', { method: 'POST', body: JSON.stringify({ name: made.title, caption: made.title, data }) })
        setStatus('sent'); telegramHaptic('success')
        setTimeout(telegramClose, 1200)
      } catch { setStatus('error') }
    })()
  }, [kind])

  const text = { working: t('Making PDF…'), sent: t('Sent to your chat ✅'), rest: t('Rest day — no workout to send.'), error: t('Could not send the PDF — open the bot chat and press Start.') }[status]
  return <div className="narrow" style={{ textAlign: 'center', paddingTop: '28vh' }}>
    <div style={{ fontSize: 34, color: 'var(--label-3)', marginBottom: 14 }}><Icon name={status === 'working' ? 'download' : status === 'sent' ? 'check' : 'dumbbell'} /></div>
    <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 18 }}>{text}</div>
    {status !== 'working' && <Button onClick={() => (IN_TELEGRAM ? telegramClose() : nav('/home'))}>{t('Close')}</Button>}
  </div>
}
