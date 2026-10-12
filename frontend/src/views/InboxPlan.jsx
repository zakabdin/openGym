import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { planTitle, openPlanPreview } from '../components/PlanInbox.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// Opened by the button under the bot's "your trainer sent you a plan" message (#/inbox/<id>): the plan's
// preview, ready to start or put off. Trainer screens are English-only, like the preview itself.
export default function InboxPlan() {
  const { id } = useParams()
  const nav = useNavigate()
  const [state, setState] = useState({ status: 'loading', item: null })   // loading | waiting | answered | missing | error
  const asked = useRef('')

  const load = () => api('/api/inbox').then(r => {
    const item = (r.items || []).find(i => i.id === id)
    setState(!item ? { status: 'missing', item: null } : item.status === 'pending' ? { status: 'waiting', item } : { status: 'answered', item })
  }).catch(() => setState({ status: 'error', item: null }))
  useEffect(() => { load() }, [id])

  // The preview opens by itself once, the way the person expects from the button they tapped.
  const answered = () => nav('/home')
  useEffect(() => {
    if (state.status === 'waiting' && asked.current !== id) { asked.current = id; openPlanPreview(state.item, answered) }
  }, [state.status, id])

  const text = {
    loading: 'Opening the plan…', error: 'Could not load the plan — try again.',
    missing: 'This plan is no longer here.', answered: 'You already answered this plan.',
    waiting: state.item ? planTitle(state.item) + (state.item.fromName ? ' · from ' + state.item.fromName : '') : ''
  }[state.status]
  return <div className="narrow" style={{ textAlign: 'center', paddingTop: '26vh' }}>
    <div style={{ fontSize: 34, color: 'var(--label-3)', marginBottom: 14 }}><Icon name="calendar" /></div>
    <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 18 }}>{text}</div>
    {state.status === 'waiting' && <><Button variant="primary" onClick={() => openPlanPreview(state.item, answered)}>See the plan</Button><div style={{ height: 8 }} /></>}
    {state.status === 'error' && <><Button variant="primary" onClick={load}>Try again</Button><div style={{ height: 8 }} /></>}
    {state.status !== 'loading' && <Button onClick={() => nav('/home')}>Go to Home</Button>}
  </div>
}
