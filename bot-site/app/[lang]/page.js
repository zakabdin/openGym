import Link from 'next/link'
import { notFound } from 'next/navigation'
import { BOT, BOT_URL, SITE_URL, REPO_URL } from '@/lib/site'
import { T, isLang } from '@/lib/i18n'

export default async function Home({ params }) {
  const { lang } = await params
  if (!isLang(lang)) notFound()
  const t = T[lang], h = t.home
  const ld = [
    { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'openGym Bot', inLanguage: lang, applicationCategory: 'HealthApplication', operatingSystem: 'Telegram', url: `${SITE_URL}/${lang}`, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, description: h.appDesc, sameAs: [BOT_URL, REPO_URL] },
    { '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang, mainEntity: t.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ]
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <div className="wrap">
        <div className="hero">
          <div className="eyebrow">{h.eyebrow}</div>
          <h1>{h.h1}</h1>
          <p>{h.sub}</p>
          <div className="cta">
            <a className="btn" href={BOT_URL} rel="noopener">{h.cta1(BOT)}</a>
            <Link className="btn ghost" href={`/${lang}/builder`}>{h.cta2}</Link>
          </div>
        </div>
        <section id="how">
          <h2>{h.howH}</h2><p className="lead">{h.howSub}</p>
          <div className="steps">{h.steps.map(([a, b]) => <div className="card" key={a}><h3>{a}</h3><p>{b}</p></div>)}</div>
        </section>
        <section id="features">
          <h2>{h.featH}</h2><p className="lead">{h.featSub}</p>
          <div className="grid">{h.features.map(([a, b]) => <div className="card" key={a}><h3>{a}</h3><p>{b}</p></div>)}</div>
        </section>
        <section>
          <h2>{h.cmdH}</h2><p className="lead">{h.cmdSub}</p>
          <div className="grid">{h.cmds.map(([c, d]) => <div className="card" key={c}><h3><code>{c}</code></h3><p>{d}</p></div>)}</div>
        </section>
        <section>
          <div className="band"><h2>{h.bandH}</h2><p>{h.bandP}</p><Link className="btn" href={`/${lang}/builder`}>{h.bandBtn}</Link></div>
        </section>
        <section id="faq">
          <h2>{h.faqH}</h2>
          <div style={{ marginTop: 24 }}>{t.faq.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
        </section>
        <section>
          <div className="band"><h2>{h.endH}</h2><p>{h.endP}</p><a className="btn" href={BOT_URL} rel="noopener">{h.endBtn(BOT)}</a></div>
        </section>
      </div>
    </>
  )
}
