import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface TenantLine {
  tenant_name?: string
  tenant_location?: string
  principal?: string | number
}

interface Props {
  partner_name?: string
  amount?: string | number
  booked_count?: number
  booked_amount?: string | number
  days_left?: number
  release_date?: string
  tenants?: TenantLine[]
  activation_url?: string
  currency?: string
  company_name?: string
  logo_url?: string
  support_email?: string
  unsubscribe_url?: string
}

const BRAND = '#b45309'
const INK = '#0f172a'
const BODY_C = '#334155'
const SUB = '#475569'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'

const fmt = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function PromissoryNoteReleaseWarning({
  partner_name = 'Partner',
  amount = 0,
  booked_count = 0,
  booked_amount = 0,
  days_left = 4,
  release_date = '',
  tenants = [],
  activation_url = 'https://welileapp.com/activate',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: Props) {
  const year = new Date().getFullYear()
  const count = booked_count || tenants.length

  return (
    <Html>
      <Head />
      <Preview>{String(count)} tenant{count === 1 ? '' : 's'} still held for you — {String(days_left)} day{days_left === 1 ? '' : 's'} left</Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
          <tbody><tr><td align="center" style={{ padding: '36px 10px' }}>
            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" style={card}>
              <tbody>
                <tr><td height={6} style={{ backgroundColor: BRAND }}></td></tr>
                <tr><td style={{ padding: '28px 36px 8px' }}>
                  <Img src={logo_url} alt={company_name} width={130} style={{ display: 'block', maxWidth: '130px', height: 'auto' }} />
                </td></tr>
                <tr><td style={{ padding: '10px 36px 0' }}>
                  <Heading as="h1" style={h1}>
                    Your reserved tenants are released in {String(days_left)} day{days_left === 1 ? '' : 's'}
                  </Heading>
                  <Text style={sub}>
                    Hello {partner_name}, the tenants held under your pledge of <strong>{fmt(amount, currency)}</strong> are
                    still waiting for your funds. We hold each booking for 7 days only. If your capital does not arrive by{' '}
                    <strong>{release_date || 'the release date'}</strong>, these rent plans return to the general funding
                    queue and may be funded by someone else.
                  </Text>
                </td></tr>

                <tr><td style={{ padding: '22px 36px 0' }}>
                  <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={panel}>
                    <tbody>
                      <tr>
                        <td style={cell}>
                          <Text style={label}>Tenants held</Text>
                          <Text style={value}>{count}</Text>
                        </td>
                        <td style={cell}>
                          <Text style={label}>Capital needed</Text>
                          <Text style={value}>{fmt(booked_amount, currency)}</Text>
                        </td>
                      </tr>
                      <tr>
                        <td style={cell}>
                          <Text style={label}>Days remaining</Text>
                          <Text style={valueSub}>{days_left}</Text>
                        </td>
                        <td style={cell}>
                          <Text style={label}>Release date</Text>
                          <Text style={valueSub}>{release_date || '—'}</Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td></tr>

                {count > 0 && tenants.length > 0 && (
                  <tr><td style={{ padding: '26px 36px 0' }}>
                    <Heading as="h2" style={h2}>Still reserved for you</Heading>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={tenantCard}>
                      <tbody>
                        {tenants.map((t, i) => (
                          <tr key={i}>
                            <td style={{ padding: '14px 18px', borderBottom: i === tenants.length - 1 ? 'none' : `1px solid ${BORDER}` }}>
                              <Text style={tenantName}>{t.tenant_name || 'Tenant'}</Text>
                              <Text style={tenantLoc}>{t.tenant_location || 'Uganda'}</Text>
                            </td>
                            <td align="right" style={{ padding: '14px 18px', borderBottom: i === tenants.length - 1 ? 'none' : `1px solid ${BORDER}` }}>
                              <Text style={tenantAmt}>{fmt(t.principal, currency)}</Text>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td></tr>
                )}

                <tr><td align="center" style={{ padding: '28px 36px 4px' }}>
                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                    <tbody><tr><td style={{ borderRadius: '8px', backgroundColor: BRAND }}>
                      <Link href={activation_url} style={button}>Complete my funding</Link>
                    </td></tr></tbody>
                  </table>
                </td></tr>

                <tr><td style={{ padding: '20px 36px 0' }}>
                  <Text style={outro}>
                    Nothing has been charged to you — this is a reservation only. Need more time or help completing your
                    deposit? Reply to this email or write to{' '}
                    <Link href={`mailto:${support_email}`} style={inline}>{support_email}</Link>.
                  </Text>
                  <Text style={signature}>The {company_name} Partnerships Team</Text>
                </td></tr>

                <tr><td style={{ padding: '26px 36px 30px' }}>
                  <Text style={footer}>
                    {company_name} — rent funding built on trust. {year}. <Link href={unsubscribe_url} style={inline}>Unsubscribe</Link>
                  </Text>
                </td></tr>
              </tbody>
            </table>
          </td></tr></tbody>
        </table>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#f1f5f9', margin: 0, padding: 0, fontFamily: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" }
const card: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: '14px', overflow: 'hidden', border: `1px solid ${BORDER}` }
const h1: React.CSSProperties = { margin: '0 0 10px 0', color: INK, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px' }
const h2: React.CSSProperties = { margin: '0 0 10px 0', color: INK, fontSize: '18px', fontWeight: 800 }
const sub: React.CSSProperties = { margin: 0, color: SUB, fontSize: '15px', lineHeight: '24px' }
const panel: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', backgroundColor: '#fffbeb' }
const cell: React.CSSProperties = { padding: '16px 20px', width: '50%' }
const label: React.CSSProperties = { margin: '0 0 4px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const value: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 800 }
const valueSub: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '15px', fontWeight: 700 }
const tenantCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' }
const tenantName: React.CSSProperties = { margin: '0 0 2px 0', color: INK, fontSize: '15px', fontWeight: 700 }
const tenantLoc: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '13px' }
const tenantAmt: React.CSSProperties = { margin: 0, color: INK, fontSize: '15px', fontWeight: 700 }
const button: React.CSSProperties = { display: 'inline-block', padding: '14px 30px', color: '#ffffff', fontSize: '15px', fontWeight: 700, textDecoration: 'none', borderRadius: '8px' }
const outro: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '14px', lineHeight: '22px' }
const inline: React.CSSProperties = { color: BRAND, fontWeight: 600, textDecoration: 'none' }
const signature: React.CSSProperties = { margin: '22px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const footer: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }

export const template: TemplateEntry = {
  component: PromissoryNoteReleaseWarning,
  displayName: 'Promissory Note — Reserved Tenants Release Warning',
  subject: (data: Record<string, any>) => {
    const days = Number(data?.days_left ?? 4) || 4
    const count = Number(data?.booked_count ?? 0) || 0
    return `${days} day${days === 1 ? '' : 's'} left: ${count} reserved tenant${count === 1 ? '' : 's'} will be released`
  },
  previewData: {
    partner_name: 'SSENKAALI PIUS',
    amount: 10000000,
    booked_count: 2,
    booked_amount: 9000000,
    days_left: 4,
    release_date: '26 Aug 2026',
    tenants: [
      { tenant_name: 'Alice Babirye', tenant_location: 'Kabaale, Entebbe', principal: 5000000 },
      { tenant_name: 'Moses Okello', tenant_location: 'Bweyogerere, Wakiso', principal: 4000000 },
    ],
    currency: 'UGX',
  },
}
