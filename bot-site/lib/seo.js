import { SITE_URL } from './site'
import { LANGS, OG_LOCALE } from './i18n'

// hreflang alternates for a path ('' for home, '/builder' for the builder).
export function alternates(lang, path = '') {
  return {
    canonical: `${SITE_URL}/${lang}${path}`,
    languages: { ...Object.fromEntries(LANGS.map(l => [l, `${SITE_URL}/${l}${path}`])), 'x-default': `${SITE_URL}/en${path}` },
  }
}
export const og = (lang, path, title, description) => ({
  type: 'website', siteName: 'openGym', title, description, url: `${SITE_URL}/${lang}${path}`,
  locale: OG_LOCALE[lang], alternateLocale: LANGS.filter(l => l !== lang).map(l => OG_LOCALE[l]),
})
