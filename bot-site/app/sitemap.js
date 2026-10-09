import { SITE_URL } from '@/lib/site'
import { LANGS } from '@/lib/i18n'

export default function sitemap() {
  const now = new Date()
  return ['', '/builder'].flatMap(path => LANGS.map(lang => ({
    url: `${SITE_URL}/${lang}${path}`, lastModified: now, priority: path ? 0.9 : 1,
    alternates: { languages: { ...Object.fromEntries(LANGS.map(l => [l, `${SITE_URL}/${l}${path}`])), 'x-default': `${SITE_URL}/en${path}` } },
  })))
}
