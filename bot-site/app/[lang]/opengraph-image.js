import { ImageResponse } from 'next/og'
import { T } from '@/lib/i18n'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export default async function Image({ params }) {
  const { lang } = await params
  const m = T[lang]?.meta || T.en.meta
  return new ImageResponse(
    (<div style={{ width: '100%', height: '100%', background: '#000', color: '#f5f5f7', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80 }}>
      <div style={{ color: '#32d74b', fontSize: 34, fontWeight: 700, letterSpacing: 3 }}>{m.ogTag}</div>
      <div style={{ fontSize: 76, fontWeight: 800, marginTop: 24, lineHeight: 1.1 }}>{m.ogHead}</div>
      <div style={{ fontSize: 34, color: '#9a9aa2', marginTop: 32 }}>{m.ogSub}</div>
    </div>), size)
}
