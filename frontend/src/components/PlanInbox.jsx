import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { parsePlan } from '../lib/plan-share.js'
import { applyProgram, undoProgram } from '../lib/trainer.js'
import { exOr } from '../lib/exercises.js'
import { exerciseNameText, DAYS } from '../lib/format.js'
import { telegramHaptic } from '../lib/telegram.js'
import { tappable } from '../lib/use-sheet-keyboard.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

// A plan from the trainer, as the client meets it: a banner on Home, one preview, one button.
// English-only like the rest of the trainer screens (they are not in the translated surface).

const WEEK = [1, 2, 3, 4, 5, 6, 0]
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)

/** The waiting plans from the trainer, newest first; refreshed when the app comes back to the front. */
export function usePendingPlans() {
  const trainerId = useStore(s => s.user?.trainerId)
  const [items, setItems] = useState([])
  const load = useCallback(() => {
    if (!trainerId) { setItems([]); return }
    api('/api/inbox').then(r => setItems((r.items || []).filter(i => i.status === 'pending'))).catch(() => {})
  }, [trainerId])
  useEffect(() => {
    load()
    const on = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', on)
    const tm = setInterval(on, 30000)
    return () => { document.removeEventListener('visibilitychange', on); clearInterval(tm) }
  }, [load])
  return [items, load]
}

/** The plan's title: its own name, else the first workout's. */
export const planTitle = item => item.bundle?.name || item.bundle?.routines?.[0]?.name || 'New plan'

/** Put the plan in the profile and the week, then tell the trainer. Resolves to what was added. */
export async function startPlan(item) {
  let res
  // A plan with no days leaves the client's own week alone; with days it sets the week.
  const days = parsePlan(item.bundle, useStore.getState().S.unit).scheduledDays
  useStore.getState().update(s => { res = applyProgram(s, item, { schedule: days > 0 }) })
  telegramHaptic('success')
  await api('/api/inbox/resolve', { method: 'POST', body: JSON.stringify({ id: item.id, status: 'accepted' }) })
  return res
}
export const declinePlan = item => api('/api/inbox/resolve', { method: 'POST', body: JSON.stringify({ id: item.id, status: 'declined' }) })

function Preview({ item, close, onDone }) {
  const toast = useUI(s => s.toast)
  const unit = useStore(s => s.S.unit)
  const hasWeek = useStore(s => Object.values(s.S.week || {}).some(v => [].concat(v).length))
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  let plan
  try { plan = parsePlan(item.bundle, unit) } catch { plan = null }
  if (!plan) return <><h3>Plan</h3><div className="muted">This plan can’t be opened.</div><Button onClick={close}>Close</Button></>

  const dayOf = {}
  WEEK.forEach(d => [].concat(plan.week[d] || []).forEach(id => { (dayOf[id] = dayOf[id] || []).push(DAYS[d]) }))
  const run = async fn => { setBusy(true); try { await fn() } catch (e) { toast(e.message) } setBusy(false) }

  if (started) return <>
    <h3>Plan added</h3>
    <div className="muted" style={{ margin: '4px 0 14px' }}>{planTitle(item)} is added.</div>
    <Button variant="primary" onClick={() => { close(); onDone?.() }}>Done</Button>
    <div style={{ height: 8 }} />
    <Button onClick={() => { useStore.getState().update(s => { undoProgram(s, item.id) }); toast('Plan removed'); close(); onDone?.() }}>Undo</Button>
  </>

  return <>
    <h3>{planTitle(item)}</h3>
    <div className="muted small">from {item.fromName} · {plural(plan.routineCount, 'workout', 'workouts')} · {plural(plan.exerciseCount, 'exercise', 'exercises')}</div>
    {item.note && <div style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 12, background: 'var(--surface-3)' }}>{item.note}</div>}
    <div className="list" style={{ margin: '12px 0' }}>
      {plan.routines.map(r => <div key={r.id}>
        <div className="item" {...tappable(() => setOpen(open === r.id ? null : r.id))}>
          <div className="grow">
            <div className="tt">{r.name}</div>
            <div className="ss">{plural(r.ex.length, 'exercise', 'exercises')}{dayOf[r.id] ? ' · ' + dayOf[r.id].join(' ') : ''}</div>
          </div>
          <Icon name={open === r.id ? 'chevronUp' : 'chevronRight'} className="chev" />
        </div>
        {open === r.id && <div style={{ padding: '2px 14px 10px' }}>
          {r.ex.map((e, i) => <div key={i} className="small" style={{ padding: '3px 0' }}>{exerciseNameText(exOr(e.id)) || exOr(e.id).n}{e.sets && e.reps ? <span className="muted"> · {e.sets} × {e.reps}</span> : null}</div>)}
        </div>}
      </div>)}
    </div>
    {plan.scheduledDays > 0 && <div className="muted small" style={{ marginBottom: 10 }}>{hasWeek ? 'This replaces your current week with the days above.' : 'This sets your week to the days above.'} You can undo it right after.</div>}
    <Button variant="primary" disabled={busy} onClick={() => run(async () => { await startPlan(item); setStarted(true) })}>Start this plan</Button>
    <div style={{ height: 8 }} />
    <Button disabled={busy} onClick={() => run(async () => { await declinePlan(item); toast('Not now — your trainer was told'); close(); onDone?.() })}>Not now</Button>
  </>
}

export const openPlanPreview = (item, onDone) => useUI.getState().openSheet(close => <Preview item={item} close={close} onDone={onDone} />)

/** The card on Home. Renders nothing when there is nothing waiting. */
export default function PlanBanner() {
  const [items, reload] = usePendingPlans()
  if (!items.length) return null
  const first = items[0]
  const more = items.length - 1
  return <div className="card tappable" style={{ cursor: 'pointer', border: '1px solid var(--accent)' }} {...tappable(() => openPlanPreview(first, reload))}>
    <div className="row between">
      <div>
        <div className="row" style={{ gap: 7, fontSize: 17, fontWeight: 600 }}><Icon name="calendar" />{first.fromName} sent you a plan</div>
        <div className="muted small" style={{ marginTop: 2 }}>{planTitle(first)}{more > 0 ? ' + ' + more + ' more' : ''} · tap to see it</div>
      </div>
      <Icon name="chevronRight" className="chev" />
    </div>
  </div>
}
