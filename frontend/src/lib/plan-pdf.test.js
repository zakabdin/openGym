import { describe, expect, it } from 'vitest'
import { buildPdf, layoutPlan } from './plan-pdf.js'
import { planPrintData } from './plan-share.js'

// A canvas context that only records: layout is decided from measureText and what gets drawn.
const stubPages = () => {
  const pages = []
  const newPage = () => {
    const texts = []
    const ctx = {
      font: '', fillStyle: '', textAlign: '', direction: '', strokeStyle: '', lineWidth: 0,
      measureText: s => ({ width: String(s).length * 14 }),
      fillText: (s, x, y) => texts.push({ s: String(s), x, y }),
      fillRect() {}, strokeRect() {}, clearRect() {},
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, stroke() {},
      drawImage: (img, x, y, w, h) => texts.push({ s: '[img ' + img.id + ']', x, y, w, h })
    }
    pages.push(texts)
    return ctx
  }
  return { pages, newPage }
}
const S = n => ({
  unit: 'kg', week: { 1: ['a'] },
  routines: Array.from({ length: n }, (_, i) => ({
    id: i ? 'r' + i : 'a', name: 'Routine ' + i,
    ex: [{ id: '0025', sets: 3, reps: 10, weight: 40 }, { id: '0001', sets: 4, reps: 8, weight: 20, note: 'slow' }]
  }))
})
const all = pages => pages.flat().map(t => t.s)

describe('layoutPlan', () => {
  it('draws the title, the routine, its exercises and their numbers', () => {
    const { pages, newPage } = stubPages()
    const n = layoutPlan(planPrintData(S(1), 'Ana'), newPage)
    const text = all(pages).join('|')
    expect(n).toBe(1)
    expect(text).toContain('Weekly Training Plan')
    expect(text).toContain('Routine 0')
    expect(text).toMatch(/3 × 10/)
    expect(text).toContain('slow')
    expect(text).toContain('Made with openGym')
  })
  it('a single routine is that routine on its own, without the week', () => {
    const { pages, newPage } = stubPages()
    layoutPlan(planPrintData(S(2), '', { routineId: 'r1' }), newPage)
    const text = all(pages).join('|')
    expect(text).toContain('Routine 1')
    expect(text).not.toContain('Routine 0')
    expect(text).not.toMatch(/Week schedule/i)
  })
  it('flows onto more pages and keeps every row inside the margins', () => {
    const { pages, newPage } = stubPages()
    const n = layoutPlan(planPrintData({ ...S(14), week: {} }, 'Ana'), newPage)
    expect(n).toBeGreaterThan(1)
    expect(pages.length).toBe(n)
    for (const p of pages) for (const t of p) expect(t.y).toBeLessThanOrEqual(1754)
    for (let i = 0; i < 14; i++) expect(all(pages).filter(s => s === 'Routine ' + i)).toHaveLength(1)
  })
  it('says so when there is nothing to print', () => {
    const { pages, newPage } = stubPages()
    layoutPlan(planPrintData({ unit: 'kg', week: {}, routines: [] }, ''), newPage)
    expect(all(pages).join('|')).toContain('No routines yet.')
  })
})

describe('layoutPlan with pictures', () => {
  const img = id => ({ id })
  it('draws a picture for each exercise that has one and moves its text along', () => {
    const data = planPrintData({ ...S(1), week: {} }, '')
    const plain = stubPages(); layoutPlan(data, plain.newPage)
    const pics = stubPages(); layoutPlan(data, pics.newPage, new Map([['0025', img('A')]]))
    const drawn = pics.pages.flat().filter(t => t.s.startsWith('[img'))
    expect(drawn.map(t => t.s)).toEqual(['[img A]'])
    expect(drawn[0].w).toBe(112)
    const nameX = pages => pages.flat().find(t => t.s.startsWith('Barbell Bench')).x
    expect(nameX(pics.pages)).toBeGreaterThan(nameX(plain.pages) + 100)
    // the exercise without a picture keeps its own left edge
    const other = pages => pages.flat().find(t => t.s.startsWith('3/4 Sit-up')).x
    expect(other(pics.pages)).toBe(other(plain.pages))
  })
  it('makes a row at least as tall as its picture, and still paginates', () => {
    const data = planPrintData({ ...S(14), week: {} }, '')
    const a = stubPages(), b = stubPages()
    const plain = layoutPlan(data, a.newPage)
    const withPics = layoutPlan(data, b.newPage, new Map([['0025', img('A')], ['0001', img('B')]]))
    expect(withPics).toBeGreaterThanOrEqual(plain)
    for (const p of b.pages) for (const t of p) expect(t.y).toBeLessThanOrEqual(1754)
  })
  it('does not need any pictures', () => {
    const { newPage } = stubPages()
    expect(layoutPlan(planPrintData(S(1), ''), newPage, new Map())).toBe(1)
  })
})

describe('buildPdf', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
  const text = u8 => new TextDecoder('latin1').decode(u8)
  it('writes a PDF with one A4 page per image and a correct cross-reference table', () => {
    const pdf = buildPdf([{ jpeg, w: 1240, h: 1754 }, { jpeg, w: 1240, h: 1754 }])
    const s = text(pdf)
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(s).toContain('/Count 2')
    expect(s).toContain('/MediaBox [0 0 595.28 841.89]')
    // every xref offset points at "<n> 0 obj"
    const start = Number(/startxref\n(\d+)/.exec(s)[1])
    expect(s.slice(start, start + 4)).toBe('xref')
    const rows = s.slice(start).split('\n').slice(3).filter(l => /^\d{10} 00000 n/.test(l))
    expect(rows).toHaveLength(8)
    rows.forEach((r, i) => expect(s.slice(Number(r.slice(0, 10))).startsWith(`${i + 1} 0 obj`)).toBe(true))
  })
  it('embeds the JPEG bytes untouched and states their length', () => {
    const pdf = buildPdf([{ jpeg, w: 10, h: 20 }])
    const s = text(pdf)
    expect(s).toContain(`/Width 10 /Height 20`)
    expect(s).toContain(`/Length ${jpeg.length}`)
    const at = s.indexOf('stream\n\xff\xd8') + 7
    expect([...pdf.slice(at, at + jpeg.length)]).toEqual([...jpeg])
  })
})

describe('the footer', () => {
  it('names the bot when there is one, and never the project website', () => {
    const f = link => planPrintData(S(1), '', { link }).footer
    expect(f('t.me/lift_track_bot')).toBe('Made with openGym · t.me/lift_track_bot')
    expect(f(undefined)).toBe('Made with openGym')
    expect(f('t.me/x')).not.toContain('duarte')
  })
})
