// Compacts the app's exercise library into lib/exercises.json (name, body part, equipment, target muscle).
import { readFileSync, writeFileSync } from 'node:fs'
const src = readFileSync(new URL('../../frontend/src/lib/exercises-data.js', import.meta.url), 'utf8')
const EXDB = new Function(src.replace('export const EXDB=', 'return ').replace(/;\s*$/, ''))()
const ru = (await import('../../frontend/src/exercise-names/ru.js')).default
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const out = EXDB.map(e => ({ i: e.id, n: cap(e.n), r: ru[e.id] ? cap(ru[e.id]) : undefined, b: e.bp, m: e.img, e: e.eq, t: e.tg }))
writeFileSync(new URL('../lib/exercises.json', import.meta.url), JSON.stringify(out))
console.log(out.length, 'exercises')
