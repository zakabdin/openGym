import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtVol, uid } from '../lib/format.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { buildPlanBundle } from '../lib/plan-share.js'
import { applyProgram, undoProgram } from '../lib/trainer.js'
import { IN_TELEGRAM, telegramHaptic } from '../lib/telegram.js'
import { DEFAULT_GLYPH } from '../lib/glyphs.js'
import Icon from '../components/Icon.jsx'
import '../team.css'
import { Button, Section, Row, Check, Switch, TextField, TextArea } from '../components/ui.jsx'

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

// The signed-in profile's side: its trainer, the programs waiting in the inbox, and the ones it took.
function MyTrainer() {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const user = useStore(s => s.user)
  const setUser = useStore(s => s.setUser)
  const toast = useUI(s => s.toast)
  const [mine, setMine] = useState(undefined)
  const [items, setItems] = useState([])
  const [code, setCode] = useState('')
  const [withWeek, setWithWeek] = useState(true)
  const load = useCallback(() => {
    api('/api/trainer/mine').then(r => setMine(r.trainer)).catch(() => setMine(null))
    api('/api/inbox').then(r => setItems(r.items || [])).catch(() => {})
  }, [])
  useEffect(load, [load])

  const join = async () => {
    try { const r = await api('/api/trainer/join', { method: 'POST', body: JSON.stringify({ code: code.trim() }) }); setUser(r.user); setCode(''); toast('Joined ' + r.trainer.name); load() }
    catch (e) { toast(e.message) }
  }
  const leave = async () => {
    try { const r = await api('/api/trainer/leave', { method: 'POST', body: '{}' }); setUser(r.user); setMine(null); toast('You left your trainer') }
    catch (e) { toast(e.message) }
  }
  const answer = async (item, status) => {
    try {
      if (status === 'accepted') {
        let res
        // The program lands in the profile first; only if that worked is the trainer told.
        update(s => { res = applyProgram(s, item, { schedule: withWeek }) })
        toast(res.routines + (res.routines === 1 ? ' routine added' : ' routines added') + (res.dropped ? ' · ' + res.dropped + ' unknown exercises skipped' : ''))
        telegramHaptic('success')
      }
      await api('/api/inbox/resolve', { method: 'POST', body: JSON.stringify({ id: item.id, status }) })
      load()
    } catch (e) { toast(e.message) }
  }
  const undo = id => { update(s => { undoProgram(s, id) }); toast('Program removed') }

  const pending = items.filter(i => i.status === 'pending')
  return <>
    {(mine || user?.role !== 'trainer') && <Section title="Your trainer" footer={mine ? 'Your trainer can see your workouts, body weight and routines, and can send you programs. Nothing changes in your plan until you accept one.' : 'Got a code or a link from your trainer? Opening their link joins you automatically.'}>
      {mine ? <>
        <div className="tm-client"><span className="tm-ava">{initial(mine.name)}</span><div><div className="nm">{mine.name}</div><div className="sb">Your trainer</div></div></div>
        <Row icon="reset" title="Leave this trainer" onClick={leave} danger />
      </> : mine === null ? <div style={{ padding: 12 }}>
        <TextField value={code} placeholder="Trainer code" autoCapitalize="none" onChange={e => setCode(e.target.value)} />
        <div style={{ height: 8 }} /><Button variant="primary" onClick={join} disabled={code.trim().length < 6}>Join</Button>
      </div> : null}
    </Section>}

    {pending.length > 0 && <Section title="New programs">
      {pending.map(i => <div key={i.id} style={{ padding: 12 }}>
        <div style={{ fontWeight: 600 }}>{i.bundle?.name || 'Program'} <span className="dim small">from {i.fromName}</span></div>
        <div className="dim small">{i.bundle?.routines?.length || 0} routines · {rel(i.created)}</div>
        {i.note && <div style={{ margin: '6px 0' }}>{i.note}</div>}
        <div className="row between" style={{ margin: '8px 0' }}><span>Also set my weekly schedule</span><Switch checked={withWeek} onChange={setWithWeek} /></div>
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" onClick={() => answer(i, 'accepted')}>Accept</Button>
          <Button onClick={() => answer(i, 'declined')}>Decline</Button>
        </div>
      </div>)}
    </Section>}

    {(S.programs || []).length > 0 && <Section title="Programs you took" footer="Undo removes the routines it added, and puts your previous week back if it replaced it.">
      {S.programs.map(p => <Row key={p.id} icon="calendar" title={p.name || 'Program'} subtitle={'from ' + (p.from || 'your trainer') + ' · ' + p.routineIds.length + ' routines'}>
        <Button size="sm" onClick={() => undo(p.id)}>Undo</Button>
      </Row>)}
    </Section>}

    {user?.role !== 'trainer' && <Section title="Train others" footer="Become a trainer to get an invite link, see your clients' training and send them programs.">
      <Row icon="plus" title="Become a trainer" onClick={async () => {
        try { await api('/api/trainer/enable', { method: 'POST', body: '{}' }); setUser({ ...user, role: 'trainer' }) } catch (e) { toast(e.message) }
      }} accessory="chevron" />
    </Section>}
  </>
}

function Clients() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const [list, setList] = useState(null)
  const [inv, setInv] = useState(null)
  useEffect(() => {
    api('/api/trainer/clients').then(r => setList(r.clients)).catch(e => toast(e.message))
    api('/api/trainer/invite').then(setInv).catch(() => {})
  }, [])
  const link = inv?.link || inv?.code
  const copy = () => { navigator.clipboard?.writeText(link).catch(() => {}); toast('Copied') }
  const share = () => {
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(inv.link) + '&text=' + encodeURIComponent('Train with me on openGym')
    if (IN_TELEGRAM && window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url)
    else window.open(url, '_blank')
  }
  const reset = async () => { try { setInv(await api('/api/trainer/invite/reset', { method: 'POST', body: '{}' })); toast('New link — the old one stopped working') } catch (e) { toast(e.message) } }
  return <>
    <Section title="Your clients">
      {list === null ? <div className="muted small" style={{ padding: 12 }}>Loading…</div>
        : !list.length ? <div className="tm-empty">No clients yet. Send them your invite link below.</div>
        : list.map(c => <button key={c.id} className="tm-client" onClick={() => nav('/team/c/' + c.id)}>
          <span className="tm-ava">{initial(c.name)}</span>
          <span style={{ minWidth: 0 }}>
            <div className="nm">{c.name}</div>
            <div className="sb">{c.workouts + ' workouts' + (c.lastWorkout ? ' · last ' + fmtDate(c.lastWorkout) : '')}</div>
          </span>
          {c.pending > 0 && <span className="tm-badge">{c.pending} sent</span>}
          <Icon name="chevronRight" className="lrow-c" />
        </button>)}
    </Section>
    <Section title="Invite a client" footer="Anyone who opens this link joins you. A new link stops the old one from working; people already with you stay.">
      {inv ? <div className="tm-invite">
        <div className="tm-link">{link}</div>
        {inv.link && <Button variant="primary" icon="plus" onClick={share}>Share in Telegram</Button>}
        <div className="tm-actions">
          <Button size="sm" onClick={copy}>Copy</Button>
          <Button size="sm" onClick={reset}>New link</Button>
        </div>
      </div> : <div className="tm-empty">Loading…</div>}
    </Section>
  </>
}

export function TeamClient() {
  const { id } = useParams()
  const S = useStore(s => s.S)
  const toast = useUI(s => s.toast)
  const [d, setD] = useState(null)
  const [pick, setPick] = useState({})
  const [withWeek, setWithWeek] = useState(true)
  const [note, setNote] = useState('')
  const [name, setName] = useState('')
  const load = useCallback(() => { api('/api/trainer/client?id=' + encodeURIComponent(id)).then(setD).catch(e => toast(e.message)) }, [id])
  useEffect(load, [load])
  // Build a routine for this client: it is made in the trainer's own plan (that is where the editor
  // works), the editor returns here, and it then shows in the list below, ready to tick and send.
  const update = useStore(s2 => s2.update)
  const nav = useNavigate()
  const create = () => {
    const r = { id: uid(), name: 'New routine', emoji: DEFAULT_GLYPH, ex: [] }
    update(s => { s.routines.push(r) })
    nav('/plan/r/' + r.id + '?for=' + encodeURIComponent(id))
  }
  if (!d) return <><Header title="Client" back="/team" /><div className="muted small">Loading…</div></>

  const chosen = (S.routines || []).filter(r => pick[r.id])
  const send = async () => {
    try {
      // The trainer's own routines, as their app would export them: just the chosen ones, and
      // only the weekdays that point at them.
      const sub = { ...S, routines: chosen, week: Object.fromEntries(Object.entries(S.week || {}).map(([k, v]) => [k, [].concat(v).filter(x => chosen.some(r => r.id === x))]).filter(([, v]) => v.length)) }
      if (!withWeek) sub.week = {}
      await api('/api/trainer/assign', { method: 'POST', body: JSON.stringify({ clientId: id, note, bundle: buildPlanBundle(sub, name) }) })
      toast('Sent to ' + d.client.name); telegramHaptic('success'); setPick({}); setNote(''); load()
    } catch (e) { toast(e.message) }
  }
  const lastBW = d.bodyweight[d.bodyweight.length - 1]
  return <>
    <Header title="Client" back="/team" />
    <div className="tm-who">
      <span className="tm-ava lg">{initial(d.client.name)}</span>
      <div><div style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 24, letterSpacing: '-.03em' }}>{d.client.name}</div>
        <div className="muted small">{d.lastSync ? 'active ' + rel(d.lastSync) : 'joined ' + (d.client.joined ? fmtDate(d.client.joined.slice(0, 10)) : '')}</div></div>
    </div>
    <div className="tm-stats">
      <div className="tm-stat"><b>{d.workouts.length}</b><span>Workouts</span></div>
      <div className="tm-stat"><b>{d.workouts[0] ? fmtDate(d.workouts[0].d) : '—'}</b><span>Last trained</span></div>
      <div className="tm-stat"><b>{lastBW ? lastBW.w : '—'}</b><span>{'Body ' + d.unit}</span></div>
    </div>
    <Section title="Send a program" footer={(S.routines || []).length ? 'Tick the routines to send, or build a new one for this client.' : 'No routines yet — build one for this client, then send it.'}>
      {(S.routines || []).map(r => <Row key={r.id} title={<>{r.emoji && <span className="tm-emoji">{r.emoji}</span>}{r.name}</>} subtitle={(r.ex || []).length + ' exercises'} onClick={() => setPick(p => ({ ...p, [r.id]: !p[r.id] }))}>
        <Check checked={!!pick[r.id]} onChange={() => setPick(p => ({ ...p, [r.id]: !p[r.id] }))} />
      </Row>)}
      <div style={{ padding: '8px 12px' }}><Button size="sm" variant="tinted" icon="plus" onClick={create}>New routine for {d.client.name}</Button></div>
      {chosen.length > 0 && <div style={{ padding: 12 }}>
        <TextField value={name} placeholder="Program name (optional)" onChange={e => setName(e.target.value)} />
        <div style={{ height: 8 }} />
        <TextArea value={note} placeholder="Note to your client" maxLength={500} onChange={e => setNote(e.target.value)} />
        <div className="row between" style={{ margin: '8px 0' }}><span>Include my weekly schedule</span><Switch checked={withWeek} onChange={setWithWeek} /></div>
        <Button variant="primary" onClick={send}>Send {chosen.length} {chosen.length === 1 ? 'routine' : 'routines'}</Button>
      </div>}
    </Section>
    {d.assignments.length > 0 && <Section title="Sent">
      {d.assignments.map(a => <Row key={a.id} icon="calendar" title={a.note || 'Program'} subtitle={a.routines + ' routines · ' + rel(a.created)} value={a.status} />)}
    </Section>}
    <Section title="Their routines">
      {d.routines.length ? d.routines.map(r => <Row key={r.id} title={r.name} value={r.count + ' ex'} />) : <div className="tm-empty">No routines yet.</div>}
    </Section>
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
    {user ? <>{user.role === 'trainer' && <Clients />}<MyTrainer /></> : <div className="muted">Sign in with an account to use trainers and programs.</div>}
  </>
}
