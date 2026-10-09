// A real PDF of a plan, made in the app with no library. Each A4 page is drawn on a canvas (so every
// language and script the app has renders, which a PDF's built-in fonts cannot do), saved as a
// JPEG and wrapped in a minimal PDF file. The plan's words come from plan-share's planPrintData, so
// this says exactly what the print view says. `sharePlanPdf` then hands the file to the system
// share sheet, or downloads it where sharing files isn't available.
import { planPrintData } from './plan-share.js'
import { EXIDX, imgSrc } from './exercises.js'

const PX_W = 1240, PX_H = 1754            // A4 at 150 dpi
const PT_W = 595.28, PT_H = 841.89        // A4 in PDF points
const M = 96                               // page margin, px
const PIC = 112, PIC_GAP = 22              // an exercise's picture, and the space after it, px
const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const C = { ink: '#16181d', dim: '#6b7180', faint: '#a2a8b6', line: '#e4e6ec', soft: '#eef0f4', accent: '#6a7a3a', bar: '#cfe08a' }

/**
 * Draw `data` (planPrintData) onto pages. `newPage()` must return a fresh 2D context sized
 * PX_W × PX_H, white, and is called once per page; returns how many pages were drawn. `images` maps
 * an exercise id to a loaded image: those rows get a picture beside the name, the rest stay text.
 */
export function layoutPlan(data, newPage, images = new Map()) {
  let ctx = null, y = 0, pages = 0
  const left = M, right = PX_W - M, bottom = PX_H - M - 40
  const rtl = !!data.rtl
  const font = (size, weight = 400) => { ctx.font = `${weight} ${size}px ${FONT}` }
  // x for text that belongs to the start/end of a row, whichever way the language reads.
  const startX = rtl ? right : left, endX = rtl ? left : right
  const align = atStart => (atStart !== rtl ? 'left' : 'right')
  const put = (text, x, yy, { size = 28, weight = 400, color = C.ink, atStart = true } = {}) => {
    font(size, weight); ctx.fillStyle = color; ctx.textAlign = align(atStart); ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, x, yy)
  }
  const width = (text, size, weight) => { font(size, weight); return ctx.measureText(text).width }
  const rule = (yy, color = C.soft, w = 2) => { ctx.fillStyle = color; ctx.fillRect(left, yy, right - left, w) }
  // Greedy word wrap into lines no wider than `max`.
  const wrap = (text, max, size, weight) => {
    const out = []
    let line = ''
    for (const word of String(text).split(/\s+/)) {
      const next = line ? line + ' ' + word : word
      if (line && width(next, size, weight) > max) { out.push(line); line = word } else line = next
    }
    if (line) out.push(line)
    return out.length ? out : ['']
  }

  // The footer is centred: draw it with an explicit centre alignment instead of put's start/end.
  const footer = () => { font(20); ctx.fillStyle = C.faint; ctx.textAlign = 'center'; ctx.fillText(data.footer, PX_W / 2, PX_H - M + 8) }
  const startPage = () => { ctx = newPage(); pages++; y = M; ctx.direction = rtl ? 'rtl' : 'ltr'; footer() }
  // Make room for a block `h` tall, moving to a new page when it would cross the bottom margin.
  const room = h => { if (y + h > bottom) startPage() }

  startPage()
  // Header
  put('OPENGYM', startX, y + 18, { size: 22, weight: 700, color: C.accent })
  y += 30 + 52
  for (const l of wrap(data.title, right - left, 54, 800)) { put(l, startX, y, { size: 54, weight: 800 }); y += 62 }
  if (data.sub) { y -= 6; put(data.sub, startX, y + 8, { size: 26, color: C.dim }); y += 30 }
  y += 14; rule(y, C.ink, 4); y += 40

  if (data.week) {
    put(data.blocks.week.toUpperCase(), startX, y + 16, { size: 22, weight: 700, color: C.faint }); y += 40
    const rowH = 54
    room(rowH * data.week.length + 20)
    const top = y
    data.week.forEach((w, i) => {
      if (i) { ctx.fillStyle = C.soft; ctx.fillRect(left + 2, y, right - left - 4, 2) }
      put(w.day, startX + (rtl ? -24 : 24), y + 36, { size: 28, weight: 600 })
      put(w.value || w.rest, startX + (rtl ? -260 : 260), y + 36, { size: 28, color: w.value ? C.ink : C.faint })
      y += rowH
    })
    ctx.strokeStyle = C.line; ctx.lineWidth = 2
    ctx.strokeRect(left, top, right - left, y - top)
    y += 44
    put(data.blocks.routines.toUpperCase(), startX, y + 16, { size: 22, weight: 700, color: C.faint }); y += 40
  }

  if (!data.routines.length) put(data.none, startX, y + 28, { size: 28, color: C.faint })

  const indent = 28
  data.routines.forEach(r => {
    // The routine's heading never sits alone at the foot of a page: it moves with its first row.
    const rowsOf = r.units.length ? r.units : [{ empty: true }]
    const firstH = rowHeight(rowsOf[0])
    room((r.bare ? 0 : 74) + firstH)
    if (!r.bare) {
      put(r.name, startX, y + 40, { size: 38, weight: 700 })
      put(r.count, endX, y + 38, { size: 24, color: C.dim, atStart: false })
      y += 56; rule(y); y += 14
    }
    rowsOf.forEach(u => {
      const h = rowHeight(u)
      room(h)
      drawRow(u, r)
    })
    y += 34
  })

  // One exercise: where its text goes and how tall it is. A picture takes the start of the row and
  // pushes the text along; a row is never shorter than its picture.
  function itemMetrics(it, inset) {
    const inner = right - left - 2 * indent
    const pic = images.get(it.exId) || null
    const shift = pic ? PIC + PIC_GAP : 0
    const schemeW = width(it.scheme, 28, 400)
    const nameMax = Math.max(200, inner - inset - shift - schemeW - 40)
    const nameLines = wrap(it.name + (it.part ? '  ' + it.part : ''), nameMax, 30, 500)
    const noteLines = it.note ? wrap(it.note, inner - inset - shift, 22, 400) : []
    const text = nameLines.length * 40 + 8 + noteLines.length * 30
    return { pic, shift, nameLines, noteLines, height: Math.max(text, pic ? PIC : 0) + 12 }
  }
  // How tall a row will be, measured the same way it is drawn, so a page break is decided first.
  function rowHeight(u) {
    if (u.empty) return 56
    const inset = u.superset ? 30 : 0
    return (u.superset ? 30 : 0) + u.items.reduce((h, it) => h + itemMetrics(it, inset).height, 0)
  }

  function drawPicture(img, x, yy) {
    const bx = rtl ? x - PIC : x
    ctx.save?.()
    ctx.beginPath?.(); ctx.roundRect ? ctx.roundRect(bx, yy, PIC, PIC, 14) : ctx.rect?.(bx, yy, PIC, PIC)
    ctx.clip?.()
    ctx.fillStyle = '#fff'; ctx.fillRect(bx, yy, PIC, PIC)
    ctx.drawImage(img, bx, yy, PIC, PIC)
    ctx.restore?.()
    ctx.strokeStyle = C.line; ctx.lineWidth = 2
    ctx.beginPath?.(); ctx.roundRect ? ctx.roundRect(bx, yy, PIC, PIC, 14) : ctx.rect?.(bx, yy, PIC, PIC); ctx.stroke?.()
  }

  function drawRow(u, r) {
    if (u.empty) { put(r.empty, startX + (rtl ? -indent : indent), y + 38, { size: 28, color: C.faint }); y += 56; return }
    const inset = u.superset ? 30 : 0
    const top = y
    if (u.superset) { put(data.blocks.superset.toUpperCase(), startX + (rtl ? -(indent + inset) : indent + inset), y + 28, { size: 18, weight: 700, color: C.accent }); y += 30 }
    u.items.forEach(it => {
      const m = itemMetrics(it, inset)
      const edge = startX + (rtl ? -(indent + inset) : indent + inset)   // where the row starts
      const x0 = edge + (rtl ? -m.shift : m.shift)                          // where its text starts
      const x1 = endX + (rtl ? indent : -indent)
      const rowTop = y
      if (m.pic) drawPicture(m.pic, edge, y + 2)
      m.nameLines.forEach((l, i) => {
        // The body part is printed smaller and dimmer after the name, on the last line.
        const partAt = it.part && l.endsWith(it.part) ? l.length - it.part.length : -1
        const nm = partAt >= 0 ? l.slice(0, partAt).trimEnd() : l
        put(nm, x0, y + 40, { size: 30, weight: 500 })
        if (partAt >= 0) put(it.part, x0 + (rtl ? -1 : 1) * (width(nm, 30, 500) + 14), y + 40, { size: 22, color: C.faint })
        if (i === 0) put(it.scheme, x1, y + 40, { size: 28, color: '#3d424e', atStart: false })
        y += 40
      })
      y += 8
      for (const nl of m.noteLines) { put(nl, x0, y + 24, { size: 22, color: C.dim }); y += 30 }
      y = rowTop + m.height
    })
    if (u.superset) { ctx.fillStyle = C.bar; ctx.fillRect(rtl ? right - indent + 6 : left + indent - 18, top + 6, 6, y - top - 12) }
  }
  return pages
}

const enc = s => new TextEncoder().encode(s)

/**
 * Wrap JPEG pages ([{ jpeg: Uint8Array, w, h }]) in a PDF 1.4 file, one A4 page each. Pure: the same
 * input always gives the same bytes. → Uint8Array
 */
export function buildPdf(pages) {
  const chunks = []
  let len = 0
  const offsets = []
  const push = b => { chunks.push(b); len += b.length }
  const obj = (n, head, stream) => {
    offsets[n] = len
    push(enc(`${n} 0 obj\n${head}\n`))
    if (stream) { push(enc('stream\n')); push(stream); push(enc('\nendstream\n')) }
    push(enc('endobj\n'))
  }
  push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'))
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  pages.forEach((p, i) => {
    const page = 3 + i * 3, content = page + 1, image = page + 2
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`)
    const draw = enc(`q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q`)
    obj(content, `<< /Length ${draw.length} >>`, draw)
    obj(image, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg)
  })
  const count = 3 + pages.length * 3
  const xref = len
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let n = 1; n < count; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n'
  push(enc(x + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  const out = new Uint8Array(len)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

const canvasBlob = (c, type, q) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('canvas'))), type, q))

// Load each built-in exercise's still once. A picture that is slow or missing is just left out:
// the PDF is more useful without it than not made at all.
function loadImages(data, timeoutMs = 8000) {
  const ids = new Set(data.routines.flatMap(r => r.units.flatMap(u => u.items.map(i => i.exId))))
  const images = new Map()
  const one = id => new Promise(resolve => {
    const ex = EXIDX[id]
    if (!ex || ex.custom || !ex.img) return resolve()
    const img = new Image()
    const done = ok => { clearTimeout(tm); if (ok) images.set(id, img); resolve() }
    const tm = setTimeout(() => done(false), timeoutMs)
    img.onload = () => done(true)
    img.onerror = () => done(false)
    img.src = new URL(imgSrc(ex), document.baseURI).href
  })
  return Promise.all([...ids].map(one)).then(() => images)
}

/** Render the plan to a PDF Blob. Needs a browser canvas. `opts.pictures` puts each exercise's picture in. */
export async function renderPlanPdf(S, owner, opts = {}) {
  const { pictures, ...printOpts } = opts
  // "t.me/<bot>" from the server's config; an instance without a bot just says who made it.
  let link
  try { const { useStore } = await import('../store/useStore.js'); const bot = (await useStore.getState().loadConfig())?.telegram_bot; if (bot) link = 't.me/' + bot } catch { /* no server */ }
  const data = planPrintData(S, owner, { link, ...printOpts })
  const images = pictures ? await loadImages(data) : new Map()
  const canvases = []
  layoutPlan(data, () => {
    const c = document.createElement('canvas')
    c.width = PX_W; c.height = PX_H
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PX_W, PX_H)
    canvases.push(c)
    return ctx
  }, images)
  const pages = []
  for (const c of canvases) {
    const jpeg = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.92)).arrayBuffer())
    pages.push({ jpeg, w: PX_W, h: PX_H })
  }
  return { blob: new Blob([buildPdf(pages)], { type: 'application/pdf' }), title: data.title }
}

const fileName = title => (String(title).replace(/[^\p{L}\p{N}]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan') + '.pdf'

/**
 * Make the PDF and give it to the person: the system share sheet when it takes files (phones, most
 * browsers), otherwise a download. → 'shared' | 'downloaded' | 'cancelled'
 */
export async function sharePlanPdf(S, owner, opts) {
  const { blob, title } = await renderPlanPdf(S, owner, opts)
  const name = fileName(title)
  const file = new File([blob], name, { type: 'application/pdf' })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared' } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled'
      // Anything else (a webview that advertises sharing but refuses): fall through to a download.
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.rel = 'noopener'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  return 'downloaded'
}

// Whether the PDF carries the exercise pictures: on unless the person turned it off, and remembered.
const PICS_KEY = 'og_pdf_pictures'
export const getPdfPictures = () => { try { return localStorage.getItem(PICS_KEY) !== '0' } catch { return true } }
export const setPdfPictures = on => { try { localStorage.setItem(PICS_KEY, on ? '1' : '0') } catch { /* private mode */ } }
