import DB from './exercises.json'

const BY_ID = new Map(DB.map(x => [x.i, x]))
export const exById = id => BY_ID.get(id)
export const BODYPARTS = [...new Set(DB.map(x => x.b))].sort()
export const ALL = DB
export const nameOf = (id, lang) => { const x = BY_ID.get(id); return x ? (lang === 'ru' && x.r) || x.n : id }

export const GOALS = {
  strength: { sets: 5, reps: '3–5', rest: 180, accessorySets: 3, accessoryReps: '6–8' },
  muscle: { sets: 4, reps: '6–10', rest: 120, accessorySets: 3, accessoryReps: '10–12' },
  endurance: { sets: 3, reps: '12–15', rest: 60, accessorySets: 3, accessoryReps: '15–20' },
}

export const EQUIPMENT = ['body weight', 'dumbbell', 'barbell', 'cable', 'machine', 'kettlebell', 'band']
const EQ_MAP = {
  'body weight': ['body weight'],
  dumbbell: ['dumbbell'],
  barbell: ['barbell', 'ez barbell', 'olympic barbell', 'trap bar'],
  cable: ['cable'],
  machine: ['leverage machine', 'smith machine', 'sled machine'],
  kettlebell: ['kettlebell'],
  band: ['band', 'resistance band'],
}
export const PRESETS = {
  gym: ['body weight', 'dumbbell', 'barbell', 'cable', 'machine'],
  home: ['body weight', 'dumbbell'],
  none: ['body weight'],
}

// A slot is a muscle group to hit; `big` slots lead the session and use the heavy rep range.
const S = {
  chest: { t: ['pectorals'], kw: ['bench press', 'chest press', 'push-up', 'fly', 'dip'], big: true },
  back: { t: ['lats', 'upper back'], kw: ['row', 'pull-up', 'pulldown', 'chin-up', 'pullover'], big: true },
  shoulders: { t: ['delts'], kw: ['overhead press', 'shoulder press', 'lateral raise', 'arnold', 'rear delt', 'face pull'], big: true },
  quads: { t: ['quads'], kw: ['squat', 'leg press', 'lunge', 'split squat', 'leg extension', 'step-up'], big: true },
  hams: { t: ['hamstrings', 'glutes'], kw: ['deadlift', 'romanian', 'hip thrust', 'leg curl', 'glute bridge', 'good morning', 'bridge'], big: true },
  biceps: { t: ['biceps'], kw: ['curl'] },
  triceps: { t: ['triceps'], kw: ['pushdown', 'extension', 'skull', 'dip', 'close-grip', 'kickback'] },
  calves: { t: ['calves'], kw: ['calf raise'] },
  abs: { t: ['abs'], kw: ['crunch', 'plank', 'leg raise', 'sit-up', 'russian', 'cable crunch'] },
}
const DAYS = {
  Full: [['quads', 1], ['chest', 1], ['back', 1], ['hams', 1], ['shoulders', 1], ['abs', 1]],
  Push: [['chest', 2], ['shoulders', 2], ['triceps', 2]],
  Pull: [['back', 3], ['biceps', 2], ['abs', 1]],
  Legs: [['quads', 2], ['hams', 2], ['calves', 1], ['abs', 1]],
  Upper: [['chest', 1], ['back', 2], ['shoulders', 1], ['biceps', 1], ['triceps', 1]],
  Lower: [['quads', 2], ['hams', 2], ['calves', 1], ['abs', 1]],
}
const SPLITS = {
  2: ['Full', 'Full'],
  3: ['Full', 'Full', 'Full'],
  4: ['Upper', 'Lower', 'Upper', 'Lower'],
  5: ['Push', 'Pull', 'Legs', 'Upper', 'Lower'],
  6: ['Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs'],
}

// Small seeded RNG so "Regenerate" gives variety but a plan is reproducible.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const shuffle = (arr, r) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

const BAD = /\b(assisted|wheel|stationary|elliptical|stepmill|skierg|ergometer|tire|hammer strength|weighted|rope jump|jump|plyo|isometric|wall|bosu|stability|medicine|sled|smith|reverse grip|one arm|single|behind|lying|suspended|kneeling|knees|stretch|clean|snatch|jerk|farmer|walk|balance|overhead squat)\b/i
function pool(slot, eq) {
  const allowed = new Set(eq.flatMap(k => EQ_MAP[k] || []))
  const s = S[slot]
  const list = DB.filter(x => s.t.includes(x.t) && allowed.has(x.e) && !(BAD.test(x.n) && !(eq.includes('machine') && /smith/i.test(x.n))))
  const score = x => { const n = x.n.toLowerCase(); const i = s.kw.findIndex(k => n.includes(k)); return i < 0 ? 0 : 10 - i }
  return list.map(x => ({ ...x, score: score(x) }))
}


// A freshly added exercise gets the goal's accessory prescription.
export function newExercise(id, goal) {
  const x = BY_ID.get(id), g = GOALS[goal]
  return { i: id, t: x.t, e: x.e, sets: g.accessorySets, reps: g.accessoryReps, rest: Math.round(g.rest * 0.6 / 15) * 15 }
}

export function generate({ goal, days, eq, minutes, seed }) {
  const g = GOALS[goal], r = rng(seed)
  const perSession = Math.max(4, Math.min(9, Math.round(minutes / 9)))
  const plan = SPLITS[days].map((kind, i) => {
    const used = new Set()
    let slots = DAYS[kind].map(([s, n]) => [s, n])
    // trim or grow the session toward the time budget
    let total = slots.reduce((a, [, n]) => a + n, 0)
    while (total > perSession) { const k = [...slots].reverse().find(([s, n]) => n > 1 || !S[s].big); if (!k) break; if (k[1] > 1) k[1]--; else slots = slots.filter(x => x !== k); total-- }
    const exercises = []
    for (const [slot, n] of slots) {
      const p = pool(slot, eq)
      const top = p.length ? Math.max(...p.map(x => x.score)) : 0
      // best-matching staples first, with random order inside each tier so every plan differs
      const ranked = [...shuffle(p.filter(x => x.score >= Math.max(top - 3, 1)), r), ...shuffle(p.filter(x => x.score < Math.max(top - 3, 1)), r)]
      let c = 0
      for (const x of ranked) {
        if (c >= n) break
        if (used.has(x.i)) continue
        used.add(x.i); c++
        const lead = S[slot].big && c === 1
        exercises.push({ slot, i: x.i, t: x.t, e: x.e, sets: lead ? g.sets : g.accessorySets, reps: lead ? g.reps : g.accessoryReps, rest: lead ? g.rest : Math.round(g.rest * 0.6 / 15) * 15 })
      }
    }
    exercises.sort((a, b) => (S[b.slot].big - S[a.slot].big))
    return { id: `${i}-${kind}`, kind, exercises }
  })
  return { goal, days: plan }
}
