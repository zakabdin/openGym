import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtVol, uid } from '../lib/format.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { undoProgram } from '../lib/trainer.js'
import { copyRoutine } from '../lib/routines.js'
import { usePendingPlans, openPlanPreview, planTitle } from '../components/PlanInbox.jsx'
import { IN_TELEGRAM } from '../lib/telegram.js'
import { DEFAULT_GLYPH } from '../lib/glyphs.js'
import Icon from '../components/Icon.jsx'
import '../team.css'
import { Button, Section, Row, TextField } from '../components/ui.jsx'

// Trainers and their clients. Like the admin dashboard this screen is English-only: it is not
// part of the translated end-user surface, so it stays out of the per-language string packs.

const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase()

const rel = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return Math.floor(s / 86400) + ' d ago'
}

function Header({ title, sub, back }) {
  const nav = useNavigate()
  return <div className="hdr">
    <button className="iconbtn" onClick={() => nav(back)} aria-label="Back"><Icon name="chevronLeft" /></button>
    <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
  </div>
}

// Re-run `load` when the app comes back to the front and every 20 s while it is open, so a client
// who just joined, or a plan just answered, shows up without a reload.
function useRefresh(load) {
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', on)
    const tm = setInterval(on, 20000)
    return () => { document.removeEventListener('visibilitychange', on); clearInterval(tm) }
  }, [load])
}

// The signed-in profile's side: its trainer, the plans waiting, and the ones it started.
function MyTrainer() {
  const update = useStore(s => s.update)
  const plans = useStore(s => s.S.programs)
  const user = useStore(s => s.user)
  const setUser = useStore(s => s.setUser)
  const toast = useUI(s => s.toast)
  const [mine, setMine] = useState(undefined)
  const [code, setCode] = useState('')
  const [codeOpen, setCodeOpen] = useState(false)
  const [pending, reloadPending] = usePendingPlans()
  const load = useCallback(() => {
    api('/api/trainer/mine').then(r => setMine(r.trainer)).catch(() => setMine(null))
    reloadPending()
  }, [reloadPending])
  useEffect(load, [load])

  const join = async () => {
    try { const r = await api('/api/trainer/join', { method: 'POST', body: JSON.stringify({ code: code.trim() }) }); setUser(r.user); setCode(''); toast('Joined ' + r.trainer.name); load() }
    catch (e) { toast(e.message) }
  }
  const leave = async () => {
    try { const r = await api('/api/trainer/leave', { method: 'POST', body: '{}' }); setUser(r.user); setMine(null); toast('You left your trainer') }
    catch (e) { toast(e.message) }
  }
  const undo = id => { update(s => { undoProgram(s, id) }); toast('Plan removed') }

  return <>
    {pending.length > 0 && <Section title="New plans">
      {pending.map(i => <Row key={i.id} icon="calendar" title={planTitle(i)} subtitle={'from ' + i.fromName + ' · ' + rel(i.created)} accessory="chevron" onClick={() => openPlanPreview(i, load)} />)}
    </Section>}

    {(plans || []).length > 0 && <Section title="Your plans" footer="Undo removes the workouts it added, and puts your previous week back if it replaced it.">
      {plans.map(p => <Row key={p.id} icon="calendar" title={p.name || 'Plan'} subtitle={'from ' + (p.from || 'your trainer') + ' · ' + p.routineIds.length + ' ' + (p.routineIds.length === 1 ? 'workout' : 'workouts')}>
        <Button size="sm" onClick={() => undo(p.id)}>Undo</Button>
      </Row>)}
    </Section>}

    {(mine || user?.role !== 'trainer') && <Section title="Your trainer" footer={mine ? 'Your trainer can see your workouts and body weight, and can send you plans. Nothing changes until you start one.' : undefined}>
      {mine ? <>
        <div className="tm-client"><span className="tm-ava">{initial(mine.name)}</span><div><div className="nm">{mine.name}</div><div className="sb">Your trainer</div></div></div>
        <Row icon="reset" title="Leave this trainer" onClick={leave} danger />
      </> : mine === null ? (codeOpen ? <div style={{ padding: 12 }}>
        <TextField value={code} placeholder="Trainer code" autoCapitalize="none" onChange={e => setCode(e.target.value)} />
        <div style={{ height: 8 }} /><Button variant="primary" onClick={join} disabled={code.trim().length < 6}>Join</Button>
      </div> : <Row icon="plus" title="Have a code or link from a trainer?" subtitle="Opening their link joins you automatically" accessory="chevron" onClick={() => setCodeOpen(true)} />) : null}
    </Section>}

    {user?.role !== 'trainer' && <Section title="Train others" footer="Become a trainer to invite clients and send them plans.">
      <Row icon="plus" title="Become a trainer" onClick={async () => {
        try { await api('/api/trainer/enable', { method: 'POST', body: '{}' }); setUser({ ...user, role: 'trainer' }) } catch (e) { toast(e.message) }
      }} accessory="chevron" />
    </Section>}
  </>
}

const chip = c => c.pending > 0 ? ['Plan waiting', 'var(--orange)'] : c.accepted > 0 ? ['Active', 'var(--green)'] : ['No plan yet', 'var(--text-3, #888)']

function Clients() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const [list, setList] = useState(null)
  const [inv, setInv] = useState(null)
  const load = useCallback(() => { api('/api/trainer/clients').then(r => setList(r.clients)).catch(e => toast(e.message)) }, [])
  useEffect(() => { load(); api('/api/trainer/invite').then(setInv).catch(() => {}) }, [load])
  useRefresh(load)
  const link = inv?.link || inv?.code
  const copy = () => { navigator.clipboard?.writeText(link).catch(() => {}); toast('Link copied') }
  const share = () => {
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(inv.link) + '&text=' + encodeURIComponent('Train with me on openGym')
    if (IN_TELEGRAM && window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url)
    else window.open(url, '_blank')
  }
  const reset = async () => { try { setInv(await api('/api/trainer/invite/reset', { method: 'POST', body: '{}' })); toast('New link — the old one stopped working') } catch (e) { toast(e.message) } }
  return <>
    <div style={{ margin: '4px 0 14px' }}>
      {inv?.link ? <Button variant="primary" icon="plus" onClick={share}>Invite a client</Button> : inv ? <Button variant="primary" icon="plus" onClick={copy}>Copy invite code</Button> : null}
      {inv && <div className="row" style={{ justifyContent: 'center', gap: 4, marginTop: 6 }}>
        <Button size="sm" variant="ghost" onClick={copy}>Copy link</Button>
        <Button size="sm" variant="ghost" onClick={reset}>New link</Button>
      </div>}
    </div>
    <Section title="Your clients" footer={list?.length ? undefined : 'Send your invite link. When they open it they appear here.'}>
      {list === null ? <div className="muted small" style={{ padding: 12 }}>Loading…</div>
        : !list.length ? <div className="tm-empty">No clients yet.</div>
        : list.map(c => { const [label, color] = chip(c); return <button key={c.id} className="tm-client" onClick={() => nav('/team/c/' + c.id)}>
          <span className="tm-ava">{initial(c.name)}</span>
          <span style={{ minWidth: 0 }}>
            <div className="nm">{c.name}</div>
            <div className="sb">{c.lastWorkout ? 'last trained ' + fmtDate(c.lastWorkout) : c.workouts + ' workouts'}</div>
          </span>
          <span className="tm-badge" style={{ color, background: 'color-mix(in srgb,' + color + ' 16%,transparent)' }}>{label}</span>
          <Icon name="chevronRight" className="lrow-c" />
        </button> })}
    </Section>
  </>
}

export function TeamClient() {
  const { id } = useParams()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const load = useCallback(() => { api('/api/trainer/client?id=' + encodeURIComponent(id)).then(setD).catch(e => toast(e.message)) }, [id])
  useEffect(load, [load])
  useRefresh(load)
  const open = pid => nav('/team/plan/' + pid + '?for=' + encodeURIComponent(id))
  // A new plan is a saved plan of the trainer's own, kept apart from the routines they train with.
  const make = () => {
    const r = { id: uid(), name: 'New plan', emoji: DEFAULT_GLYPH, ex: [] }
    update(s => { s.trainerPlans = [...(s.trainerPlans || []), r] })
    open(r.id)
  }
  // Starting from a saved plan works on a copy, so the saved one stays as it was.
  const reuse = r => {
    const copy = copyRoutine(r, r.name)
    copy.name = r.name
    update(s => { s.trainerPlans = [...(s.trainerPlans || []), copy] })
    open(copy.id)
  }
  if (!d) return <><Header title="Client" back="/team" /><div className="muted small">Loading…</div></>

  const saved = S.trainerPlans || []
  const lastBW = d.bodyweight[d.bodyweight.length - 1]
  return <>
    <Header title="Client" back="/team" />
    <div className="tm-who">
      <span className="tm-ava lg">{initial(d.client.name)}</span>
      <div><div style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 24, letterSpacing: '-.03em' }}>{d.client.name}</div>
        <div className="muted small">{d.lastSync ? 'active ' + rel(d.lastSync) : 'joined ' + (d.client.joined ? fmtDate(d.client.joined.slice(0, 10)) : '')}</div></div>
    </div>
    <div style={{ margin: '4px 0 14px' }}><Button variant="primary" icon="plus" onClick={make}>Make a plan for {d.client.name}</Button></div>
    {d.assignments.length > 0 && <Section title="Plans sent">
      {d.assignments.map(a => <Row key={a.id} icon="calendar" title={a.note || 'Plan'} subtitle={a.routines + (a.routines === 1 ? ' workout' : ' workouts') + ' · ' + rel(a.created)} value={a.status === 'accepted' ? 'started' : a.status === 'declined' ? 'not now' : 'waiting'} />)}
    </Section>}
    {saved.length > 0 && <Section title="Start from a saved plan" footer="Opens a copy, so your saved plan stays as it was.">
      {saved.map(r => <Row key={r.id} title={r.name} subtitle={(r.ex || []).length + ((r.ex || []).length === 1 ? ' exercise' : ' exercises')} accessory="chevron" onClick={() => reuse(r)} />)}
    </Section>}
    <div className="tm-stats">
      <div className="tm-stat"><b>{d.workouts.length}</b><span>Workouts</span></div>
      <div className="tm-stat"><b>{d.workouts[0] ? fmtDate(d.workouts[0].d) : '—'}</b><span>Last trained</span></div>
      <div className="tm-stat"><b>{lastBW ? lastBW.w : '—'}</b><span>{'Body ' + d.unit}</span></div>
    </div>
    <Section title="Recent workouts">
      {d.workouts.slice(0, 20).map(w => <Row key={w.id || w.d + w.name} title={w.name || 'Workout'}
        subtitle={fmtDate(w.d, true) + ' · ' + setsDone(w) + ' sets' + (w.prs?.length ? ' · ' + w.prs.length + ' PR' : '')} value={fmtVol(w.vol ?? workoutVolume(w), d.unit)} />)}
      {!d.workouts.length && <div className="muted small" style={{ padding: 12 }}>Nothing logged yet.</div>}
    </Section>
  </>
}

export default function Team() {
  const user = useStore(s => s.user)
  return <>
    <Header title="Team" sub={user?.role === 'trainer' ? 'Trainer' : undefined} back="/home" />
    {user ? <>{user.role === 'trainer' && <Clients />}<MyTrainer /></> : <div className="muted">Sign in with an account to use trainers and plans.</div>}
  </>
}
