import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { effectiveRoutineIds } from '../lib/history.js'
import { quickDone, fileWorkout } from '../lib/finish-workout.js'
import { IN_TELEGRAM, telegramClose, telegramHaptic } from '../lib/telegram.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// Opened by the bot's /done button: today's planned workout is logged as done exactly as planned — every set
// ticked at the planned weight and reps — without starting a session. Saved to the server before the app
// closes, and the chat is told. Never touches a workout that is already in progress or already logged today.
export default function DoneToday() {
  const { minutes } = useParams()
  const nav = useNavigate()
  const [status, setStatus] = useState('working')   // working | logged | already | rest | active | error
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    ;(async () => {
      try {
        const st = useStore.getState()
        const S = st.S
        if (S.active) { setStatus('active'); return }
        const day = todayISO()
        const ids = effectiveRoutineIds(S, day)
        if (!ids.length) { setStatus('rest'); return }
        if ((S.workouts || []).some(w => w.d === day)) { setStatus('already'); return }
        const r = quickDone(S, ids, { minutes })
        if (!r) { setStatus('rest'); return }
        st.update(s => { fileWorkout(s, r.w) })
        useStore.getState().autoBackupNow?.()
        await useStore.getState().pushState()
        if (IN_TELEGRAM) api('/api/telegram/say', { method: 'POST', body: JSON.stringify({ key: 'workoutLogged', name: r.w.name || '' }) }).catch(() => {})
        setStatus('logged'); telegramHaptic('success')
        if (IN_TELEGRAM) setTimeout(telegramClose, 1200)
      } catch { setStatus('error') }
    })()
  }, [minutes])

  const text = {
    working: t('Logging your workout…'), logged: t('Workout logged ✅'), already: t('Already logged today — nothing to add.'),
    rest: t('Rest day — no workout to log.'), active: t('A workout is in progress in the app — finish it there.'),
    error: t('Could not log the workout — try again in the app.')
  }[status]
  return <div className="narrow" style={{ textAlign: 'center', paddingTop: '28vh' }}>
    <div style={{ fontSize: 34, color: 'var(--label-3)', marginBottom: 14 }}><Icon name={status === 'logged' ? 'check' : 'dumbbell'} /></div>
    <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 18 }}>{text}</div>
    {status !== 'working' && <Button onClick={() => (IN_TELEGRAM ? telegramClose() : nav('/home'))}>{t('Close')}</Button>}
  </div>
}
