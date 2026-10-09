import { notFound } from 'next/navigation'
import Builder from '@/components/Builder'
import { T, isLang } from '@/lib/i18n'
import { SITE_URL } from '@/lib/site'
import { alternates, og } from '@/lib/seo'

export async function generateMetadata({ params }) {
  const { lang } = await params
  if (!isLang(lang)) return {}
  const m = T[lang].meta
  return { title: m.builderTitle, description: m.builderDescription, keywords: m.builderKeywords, alternates: alternates(lang, '/builder'), openGraph: og(lang, '/builder', m.builderTitle, m.builderDescription) }
}

export default async function Page({ params }) {
  const { lang } = await params
  if (!isLang(lang)) notFound()
  const b = T[lang].b
  const ld = { '@context': 'https://schema.org', '@type': 'WebApplication', name: T[lang].meta.builderTitle, inLanguage: lang, url: `${SITE_URL}/${lang}/builder`, applicationCategory: 'HealthApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, description: T[lang].meta.builderDescription }
  return (
    <div className="wrap builder">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <div className="eyebrow">{b.eyebrow}</div>
      <h1>{b.h1}</h1>
      <p className="lead">{b.lead}</p>
      <Builder lang={lang} />
    </div>
  )
}
