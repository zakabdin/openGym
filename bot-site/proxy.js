import { NextResponse } from 'next/server'

// "/" has no page of its own: send visitors to the language they browse in (Russian or English).
export function proxy(req) {
  const accept = (req.headers.get('accept-language') || '').toLowerCase()
  const first = accept.split(',')[0] || ''
  const lang = first.startsWith('ru') || first.startsWith('uk') || first.startsWith('be') ? 'ru' : 'en'
  const url = req.nextUrl.clone(); url.pathname = `/${lang}`
  const res = NextResponse.redirect(url, 307)
  res.headers.set('Vary', 'Accept-Language')
  return res
}
export const config = { matcher: '/' }
