// Thin wrapper over the Google Tag Manager dataLayer. Safe to call anywhere (no-op on the server
// or when GTM is blocked). In GTM, create a "Custom Event" trigger per event name below.
export function track(event, params = {}) {
  if (typeof window === 'undefined') return
  try { (window.dataLayer = window.dataLayer || []).push({ event, ...params }) } catch {}
}
