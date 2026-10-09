'use client'
import { useEffect, useMemo, useState } from 'react'
import { ALL, BODYPARTS } from '@/lib/generator'
import { T } from '@/lib/i18n'
import { IMG_BASE } from '@/lib/site'

const PAGE = 30

// Exercise library like the one in the Telegram app: search, body-part chips, equipment chips, pictures.
export default function Picker({ lang, onPick, onClose }) {
  const t = T[lang], b = t.b
  const [q, setQ] = useState('')
  const [bp, setBp] = useState('')
  const [eq, setEq] = useState('')
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    const k = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = '' }
  }, [onClose])

  const inBp = useMemo(() => ALL.filter(x => !bp || x.b === bp), [bp])
  const eqOpts = useMemo(() => { const c = {}; inBp.forEach(x => (c[x.e] = (c[x.e] || 0) + 1)); return Object.keys(c).sort((a, z) => c[z] - c[a]).slice(0, 10) }, [inBp])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return inBp.filter(x => (!eq || x.e === eq) && (!s || x.n.toLowerCase().includes(s) || (x.r || '').toLowerCase().includes(s)))
  }, [inBp, eq, q])
  const pickBp = v => { setBp(v); setEq(''); setShown(PAGE) }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={b.pick} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head">
          <h2>{b.pick}</h2>
          <button className="chip" onClick={onClose}>{b.close}</button>
        </div>
        <input className="search" autoFocus placeholder={b.search} value={q} onChange={e => { setQ(e.target.value); setShown(PAGE) }} />
        <div className="chips strip">
          <button className="chip" aria-pressed={!bp} onClick={() => pickBp('')}>{b.all}</button>
          {BODYPARTS.map(k => <button key={k} className="chip" aria-pressed={bp === k} onClick={() => pickBp(k)}>{t.bodyparts[k] || k}</button>)}
        </div>
        <div className="chips strip">
          <button className="chip sm" aria-pressed={!eq} onClick={() => { setEq(''); setShown(PAGE) }}>{b.all}</button>
          {eqOpts.map(k => <button key={k} className="chip sm" aria-pressed={eq === k} onClick={() => { setEq(k); setShown(PAGE) }}>{t.equipNames[k] || k}</button>)}
        </div>
        <div className="plist">
          {list.slice(0, shown).map(x => (
            <button key={x.i} className="prow" onClick={() => onPick(x.i)}>
              <img src={IMG_BASE + x.m} alt="" width="56" height="56" loading="lazy" />
              <span className="nm"><b>{(lang === 'ru' && x.r) || x.n}</b><span>{t.muscles[x.t] || x.t} · {t.equipNames[x.e] || x.e}</span></span>
            </button>
          ))}
          {!list.length && <p className="note">{b.noMatch}</p>}
          {list.length > shown && <button className="btn ghost" onClick={() => setShown(s => s + PAGE)}>{b.more} ({list.length - shown})</button>}
        </div>
      </div>
    </div>
  )
}
