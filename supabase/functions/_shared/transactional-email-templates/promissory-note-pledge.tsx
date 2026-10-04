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

interface PromissoryNotePledgeProps {
  partner_name?: string
  amount?: string | number
  attached_count?: number
  attached_amount?: string | number
  monthly_return_amount?: string | number
  annual_return_amount?: string | number
  roi_percentage?: number
  term_months?: number
  tenants?: TenantLine[]
  activation_url?: string
  currency?: string
  company_name?: string
  logo_url?: string
  support_email?: string
  unsubscribe_url?: string
}

const BRAND = '#7c3aed'
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

export function PromissoryNotePledge({
  partner_name = 'Partner',
  amount = 0,
  attached_count = 0,
  attached_amount = 0,
  monthly_return_amount = 0,
  annual_return_amount = 0,
  roi_percentage = 15,
  term_months = 12,
  tenants = [],
  activation_url = 'https://welileapp.com/activate',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: PromissoryNotePledgeProps) {
  const year = new Date().getFullYear()
  const count = attached_count || tenants.length

  return (
    <Html>
      <Head />
      <Preview>Your pledge of {fmt(amount, currency)} earns {fmt(monthly_return_amount, currency)} every month</Preview>
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
                  <Heading as="h1" style={h1}>Your rent funding pledge is ready</Heading>
                  <Text style={sub}>
                    Hello {partner_name}, a pledge of <strong>{fmt(amount, currency)}</strong> has been recorded in your name.
                    Once you fund it, your capital starts supporting real tenants and earning you returns.
                  </Text>
                </td></tr>

                <tr><td style={{ padding: '22px 36px 0' }}>
                  <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={panel}>
                    <tbody>
                      <tr>
                        <td style={cell}>
                          <Text style={label}>Pledged amount</Text>
                          <Text style={value}>{fmt(amount, currency)}</Text>
                        </td>
                        <td style={cell}>
                          <Text style={label}>Monthly earnings</Text>
                          <Text style={value}>{fmt(monthly_return_amount, currency)}</Text>
                        </td>
                      </tr>
                      <tr>
                        <td style={cell}>
                          <Text style={label}>Return rate</Text>
                          <Text style={valueSub}>{roi_percentage}% monthly</Text>
                        </td>
                        <td style={cell}>
                          <Text style={label}>Over {term_months} months</Text>
                          <Text style={valueSub}>{fmt(annual_return_amount, currency)}</Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td></tr>

                {count > 0 && (
                  <tr><td style={{ padding: '26px 36px 0' }}>
                    <Heading as="h2" style={h2}>
                      {count} tenant{count === 1 ? '' : 's'} reserved for you
                    </Heading>
                    <Text style={sectionSub}>
                      These verified rent plans — totalling {fmt(attached_amount, currency)} — are held for your pledge and
                      cannot be funded by anyone else.
                    </Text>
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
                      <Link href={activation_url} style={button}>Fund my pledge</Link>
                    </td></tr></tbody>
                  </table>
                </td></tr>

                <tr><td style={{ padding: '20px 36px 0' }}>
                  <Text style={outro}>
                    Your capital is only deployed after our operations team confirms it. You will receive a
                    confirmation with your portfolio details the moment your tenants are funded.
                    Questions? Write to <Link href={`mailto:${support_email}`} style={inline}>{support_email}</Link>.
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
const h2: React.CSSProperties = { margin: '0 0 6px 0', color: INK, fontSize: '18px', fontWeight: 800 }
const sub: React.CSSProperties = { margin: 0, color: SUB, fontSize: '15px', lineHeight: '24px' }
const sectionSub: React.CSSProperties = { margin: '0 0 14px 0', color: MUTED, fontSize: '14px', lineHeight: '22px' }
const panel: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', backgroundColor: '#fafafa' }
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
  component: PromissoryNotePledge,
  displayName: 'Promissory Note Pledge — Tenants & Earnings',
  subject: (data: Record<string, any>) => {
    const currency = data?.currency || 'UGX'
    const amt = Number(String(data?.amount ?? 0).replace(/,/g, '')) || 0
    return `Your pledge of ${currency} ${amt.toLocaleString('en-US', { maximumFractionDigits: 0 })} — tenants reserved and earnings confirmed`
  },
  previewData: {
    partner_name: 'SSENKAALI PIUS',
    amount: 10000000,
    attached_count: 2,
    attached_amount: 9000000,
    monthly_return_amount: 1500000,
    annual_return_amount: 18000000,
    roi_percentage: 15,
    term_months: 12,
    tenants: [
      { tenant_name: 'Alice Babirye', tenant_location: 'Kabaale, Entebbe', principal: 5000000 },
      { tenant_name: 'Moses Okello', tenant_location: 'Bweyogerere, Wakiso', principal: 4000000 },
    ],
    currency: 'UGX',
  },
}
