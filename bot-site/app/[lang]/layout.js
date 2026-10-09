import '../globals.css'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SITE_URL, APP_URL, BOT_URL, BOT, REPO_URL } from '@/lib/site'
import { LANGS, T, isLang } from '@/lib/i18n'
import { alternates, og } from '@/lib/seo'

export const dynamicParams = false
export const generateStaticParams = () => LANGS.map(lang => ({ lang }))
export const viewport = { themeColor: '#000000' }

export async function generateMetadata({ params }) {
  const { lang } = await params
  if (!isLang(lang)) return {}
  const m = T[lang].meta
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: m.title, template: '%s | openGym Bot' },
    description: m.description, keywords: m.keywords,
    alternates: alternates(lang),
    openGraph: og(lang, '', m.title, m.ogDescription),
    twitter: { card: 'summary_large_image', title: m.title, description: m.ogDescription },
    robots: { index: true, follow: true },
    icons: { icon: '/icon.svg' },
  }
}

export default async function Layout({ children, params }) {
  const { lang } = await params
  if (!isLang(lang)) notFound()
  const t = T[lang]
  const other = lang === 'en' ? 'ru' : 'en'
  return (
    <html lang={t.htmlLang}>
      <body>
        {/* Old chat buttons and bookmarks open opengym.one/#/…, which is now the app's subdomain. */}
        <script dangerouslySetInnerHTML={{ __html: `if(location.hash.indexOf('#/')===0)location.replace(${JSON.stringify(APP_URL + '/')}+location.hash)` }} />
        <header className="nav">
          <Link href={`/${lang}`} className="logo"><span className="dot" />openGym</Link>
          <nav>
            <Link href={`/${lang}#features`}>{t.nav.features}</Link>
            <Link href={`/${lang}/builder`}>{t.nav.builder}</Link>
            <Link href={`/${lang}#faq`}>{t.nav.faq}</Link>
            <a href={`/${other}`} hrefLang={other} lang={other}>{t.nav.lang}</a>
            <a className="btn sm" href={BOT_URL} rel="noopener">{t.nav.open}</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <div>{t.foot}</div>
          <div><a href={BOT_URL} rel="noopener">@{BOT}</a> · <Link href={`/${lang}/builder`}>{t.nav.builder}</Link> · <a href={REPO_URL} rel="noopener">GitHub</a></div>
        </footer>
      </body>
    </html>
  )
}
