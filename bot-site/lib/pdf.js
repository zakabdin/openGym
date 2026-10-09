// Dependency-free PDF: each A4 page is drawn on a canvas (so Cyrillic and every other script renders),
// saved as a JPEG and wrapped in a minimal PDF with a clickable link to the bot. Browser only.
import { BOT, BOT_URL } from './site'

const PW = 1240, PH = 1754, M = 90, PT_W = 595.28, PT_H = 841.89
const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const C = { ink: '#16181d', dim: '#6b7180', faint: '#a2a8b6', line: '#e4e6ec', acc: '#32d74b', dark: '#0a1a0d' }

const loadImg = url => new Promise(res => {
  const im = new Image(); im.crossOrigin = 'anonymous'
  const done = v => { clearTimeout(timer); res(v) }
  const timer = setTimeout(() => done(null), 8000)
  im.onload = () => done(im); im.onerror = () => done(null); im.src = url
})

export async function drawPlan({ title, goalLabel, perWeek, note, days, labels }) {
  const urls = [...new Set(days.flatMap(d => d.exercises.map(e => e.img)).filter(Boolean))]
  const pics = new Map(await Promise.all(urls.map(async u => [u, await loadImg(u)])))
  const pages = []
  let cv, g, y
  const font = (s, w = 400) => { g.font = `${w} ${s}px ${FONT}` }
  const put = (t, x, yy, s = 28, w = 400, color = C.ink, align = 'left') => { font(s, w); g.fillStyle = color; g.textAlign = align; g.fillText(t, x, yy) }
  const fit = (t, max, s, w) => { font(s, w); if (g.measureText(t).width <= max) return t; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…' }
  const page = () => {
    cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
    g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH); g.textBaseline = 'alphabetic'
    g.fillStyle = C.acc; g.fillRect(0, 0, PW, 14)
    put(`${labels.made} · t.me/${BOT}`, PW / 2, PH - 50, 22, 400, C.faint, 'center')
    pages.push(cv); y = M + 30
  }
  const wrap = (t, max, s) => { const out = []; let l = ''; for (const w of t.split(' ')) { const n = l ? l + ' ' + w : w; font(s); if (l && g.measureText(n).width > max) { out.push(l); l = w } else l = n } if (l) out.push(l); return out }

  page()
  put('OPENGYM', M, y, 22, 700, '#1f9d37'); y += 70
  for (const l of wrap(title, PW - 2 * M, 54)) { put(l, M, y, 54, 800); y += 64 }
  put(`${goalLabel} · ${perWeek}`, M, y, 26, 400, C.dim); y += 40
  for (const l of wrap(note, PW - 2 * M, 24)) { put(l, M, y, 24, 400, C.dim); y += 34 }
  y += 30

  const colSets = 660, colRest = 850, colLog = 940
  for (const d of days) {
    if (y + 360 > PH - M - 40) page()
    g.fillStyle = C.dark; g.fillRect(M, y, PW - 2 * M, 56); put(d.name, M + 22, y + 38, 28, 700, '#fff'); y += 56
    put(labels.exercise, M + 8, y + 36, 17, 700, C.faint); put(labels.sets, colSets, y + 36, 17, 700, C.faint); put(labels.rest, colRest, y + 36, 17, 700, C.faint); put(labels.log, colLog, y + 36, 17, 700, C.faint)
    y += 50
    for (const ex of d.exercises) {
      if (y + 104 > PH - M - 40) page()
      const pic = pics.get(ex.img), tx = pic ? M + 112 : M + 8
      if (pic) { g.fillStyle = '#fff'; g.fillRect(M + 8, y + 4, 88, 88); g.drawImage(pic, M + 8, y + 4, 88, 88); g.strokeStyle = C.line; g.lineWidth = 2; g.strokeRect(M + 8, y + 4, 88, 88) }
      put(fit(ex.name, colSets - tx - 20, 27, 700), tx, y + 42, 27, 700)
      put(fit(ex.sub, colSets - tx - 20, 19), tx, y + 72, 19, 400, C.dim)
      put(`${ex.sets} × ${ex.reps}`, colSets, y + 48, 27, 600)
      put(ex.rest, colRest, y + 48, 24, 400, C.dim)
      g.strokeStyle = '#b3b8c4'; g.lineWidth = 2
      for (let i = 0; i < Math.min(ex.sets, 5); i++) g.strokeRect(colLog + i * 44, y + 26, 30, 30)
      y += 104; g.fillStyle = C.line; g.fillRect(M, y - 8, PW - 2 * M, 2)
    }
    y += 40
  }
  return pages
}

export function pagesToPdf(canvases) {
  const enc = new TextEncoder(), parts = [], offsets = []
  let len = 0
  const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length }
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n') }
  const n = canvases.length, jpgs = canvases.map(c => { const b = atob(c.toDataURL('image/jpeg', 0.88).split(',')[1]); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u })
  push('%PDF-1.4\n')
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'))
  obj(2, () => push(`<< /Type /Pages /Kids [${canvases.map((_, i) => `${3 + i * 4} 0 R`).join(' ')}] /Count ${n} >>`))
  canvases.forEach((c, i) => {
    const p = 3 + i * 4
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R /Annots [${p + 3} 0 R] >>`))
    obj(p + 1, () => { push(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpgs[i].length} >>\nstream\n`); push(jpgs[i]); push('\nendstream') })
    const cs = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im Do Q`
    obj(p + 2, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`))
    obj(p + 3, () => push(`<< /Type /Annot /Subtype /Link /Rect [${PT_W / 2 - 110} 14 ${PT_W / 2 + 110} 32] /Border [0 0 0] /A << /S /URI /URI (${BOT_URL}) >> >>`))
  })
  const total = 3 + n * 4, xref = len
  push(`xref\n0 ${total}\n0000000000 65535 f \n` + Array.from({ length: total - 1 }, (_, i) => String(offsets[i + 1]).padStart(10, '0') + ' 00000 n \n').join(''))
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  const out = new Uint8Array(len); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function downloadPdf(bytes, name = 'opengym-workout-plan.pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
