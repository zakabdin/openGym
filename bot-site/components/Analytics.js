'use client'
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { track } from '@/lib/track'

const clip = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// Delegated listeners: every click, FAQ toggle, scroll depth, engaged time, copy, input and
// error on the site becomes a dataLayer event, so new buttons are tracked without extra code.
export default function Analytics({ lang, botUrl }) {
  const path = usePathname()
  const first = useRef(true)

  // page_view on every client-side route change (the first one is the real load).
  useEffect(() => {
    track('page_view_virtual', { page_path: path, page_title: document.title, page_location: location.href, lang, first_load: first.current })
    first.current = false
  }, [path, lang])

  // Scroll depth, per page.
  useEffect(() => {
    const done = new Set()
    const onScroll = () => {
      const h = document.documentElement
      const pct = Math.round(((window.scrollY + window.innerHeight) / h.scrollHeight) * 100)
      for (const m of [25, 50, 75, 90, 100]) if (pct >= m && !done.has(m)) { done.add(m); track('scroll_depth', { percent: m, page_path: path }) }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [path])

  // Engaged time (tab visible), per page.
  useEffect(() => {
    let sec = 0
    const marks = new Set([10, 30, 60, 120, 300])
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      sec++
      if (marks.has(sec)) track('engaged_time', { seconds: sec, page_path: path })
    }, 1000)
    return () => clearInterval(id)
  }, [path])

  useEffect(() => {
    const onClick = e => {
      const el = e.target.closest && e.target.closest('a,button,summary,[role=button]')
      if (!el) return
      const text = clip(el.getAttribute('aria-label') || el.textContent)
      const base = { text, page_path: location.pathname, lang }
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || ''
        let url
        try { url = new URL(href, location.href) } catch { return }
        if (botUrl && url.href.startsWith(botUrl)) return track('bot_click', { ...base, link_url: url.href, placement: el.closest('header') ? 'header' : el.closest('footer') ? 'footer' : el.closest('section,main') ? 'content' : 'other' })
        if (el.hasAttribute('hreflang') && url.origin === location.origin) return track('language_switch', { ...base, to: el.getAttribute('hreflang') })
        if (url.hostname === 'github.com') return track('github_click', { ...base, link_url: url.href })
        if (url.origin !== location.origin) return track('outbound_click', { ...base, link_url: url.href, link_domain: url.hostname })
        if (url.hash && url.pathname === location.pathname) return track('anchor_click', { ...base, anchor: url.hash })
        return track('internal_link_click', { ...base, link_url: url.pathname + url.hash })
      }
      if (el.tagName === 'SUMMARY') return // handled by toggle
      track('button_click', { ...base, pressed: el.getAttribute('aria-pressed') ?? undefined, button_class: clip(el.className, 40) })
    }
    // toggle doesn't bubble, so listen in the capture phase.
    const onToggle = e => {
      if (e.target.tagName === 'DETAILS') track('faq_toggle', { question: clip(e.target.querySelector('summary')?.textContent, 120), open: e.target.open, lang })
    }
    const onCopy = () => track('text_copy', { chars: String(getSelection()).length, page_path: location.pathname })
    let t
    const onInput = e => {
      const el = e.target
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      clearTimeout(t)
      t = setTimeout(() => track('field_edit', { field: clip(el.getAttribute('aria-label') || el.placeholder || el.name || el.type, 40), kind: el.type || el.tagName.toLowerCase(), length: (el.value || '').length, page_path: location.pathname }), 800)
    }
    const onError = e => track('js_error', { message: clip(e.message, 120), source: clip(e.filename, 100), line: e.lineno })
    const onReject = e => track('js_error', { message: clip(e.reason && (e.reason.message || e.reason), 120), source: 'promise' })
    const onHide = () => { if (document.visibilityState === 'hidden') track('page_hidden', { page_path: location.pathname }) }

    document.addEventListener('click', onClick)
    document.addEventListener('toggle', onToggle, true)
    document.addEventListener('copy', onCopy)
    document.addEventListener('input', onInput)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onReject)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('toggle', onToggle, true)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('input', onInput)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onReject)
    }
  }, [lang, botUrl])

  return null
}
