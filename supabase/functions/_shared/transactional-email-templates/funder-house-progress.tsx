import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  kind?: 'agent_assigned' | 'tenant_placed' | 'earning_started'
  partner_name?: string
  house_title?: string
  district?: string
  house_count?: number
  monthly_rent?: string | number
  principal?: string | number
  monthly_return?: string | number
  agent_name?: string
  placed_date?: string
  first_return_date?: string
  return_rate?: number

  dashboard_url?: string
  currency?: string
  company_name?: string
  logo_url?: string
  support_email?: string
  unsubscribe_url?: string
}

const INK = '#0f172a'
const BODY_C = '#334155'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'
const SUCCESS = '#15803d'

const fmt = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const headline = (kind: string) => {
  if (kind === 'agent_assigned') return 'A Welile agent is now on your house'
  if (kind === 'tenant_placed') return 'A tenant has moved into your house'
  return 'Your Returns have started'
}

export function FunderHouseProgress({
  kind = 'agent_assigned',
  partner_name = 'Partner',
  house_title = 'your funded house',
  district = '',
  house_count = 1,
  monthly_rent = 0,
  principal = 0,
  monthly_return = 0,
  agent_name = '',
  placed_date = '',
  first_return_date = '',
  return_rate = 15,
  dashboard_url = 'https://welileapp.com/dashboard/funder',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: Props) {
  const year = new Date().getFullYear()
  const houseLabel = house_title + (district ? ` — ${district}` : '')

  const intro = kind === 'agent_assigned'
    ? `${agent_name || 'A Welile agent'} has been assigned to ${houseLabel} and is already looking for a tenant. Tenants are placed within 7 days of funding.`
    : kind === 'tenant_placed'
      ? `A tenant has moved into ${houseLabel}${placed_date ? ` on ${placed_date}` : ''}. Welile now collects the rent on your behalf.`
      : `Your money is working. ${house_count > 1 ? `Your ${house_count} funded houses are` : `${houseLabel} is`} earning, and your Returns are paid into your Welile wallet.`

  return (
    <Html>
      <Head />
      <Preview>{headline(kind)}</Preview>
      <Body style={body}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ backgroundColor: '#f8fafc' }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: '28px 16px' }}>
                <table role="presentation" width="600" cellPadding={0} cellSpacing={0} style={card}>
                  <tbody>
                    <tr>
                      <td style={{ padding: '26px 32px 0 32px' }}>
                        <Img src={logo_url} width="118" alt={company_name} style={{ display: 'block' }} />
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: '20px 32px 0 32px' }}>
                        <Heading as="h1" style={h1}>{headline(kind)}</Heading>
                        <Text style={paragraph}>Hi {partner_name}, {intro}</Text>
                      </td>
                    </tr>

                    {Number(monthly_return) > 0 && (
                      <tr>
                        <td style={{ padding: '4px 32px 0 32px' }}>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={heroBox}>
                            <tbody>
                              <tr>
                                <td style={{ padding: '16px 20px' }}>
                                  <Text style={heroAmount}>{fmt(monthly_return, currency)}</Text>
                                  <Text style={heroLabel}>
                                    your estimated Returns every month ({return_rate}% of the {fmt(principal, currency)} you contributed)
                                  </Text>
                                  <Text style={heroSub}>
                                    {first_return_date
                                      ? `Paid into your Welile wallet from ${first_return_date}, then on the same date each month.`
                                      : 'Paid into your Welile wallet on the same date each month.'}
                                  </Text>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}

                    <tr>
                      <td style={{ padding: '18px 32px 0 32px' }}>
                        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
                          <tbody>
                            <tr>
                              <td style={panelCell}>
                                <Text style={panelLabel}>House</Text>
                                <Text style={panelValue}>{houseLabel}</Text>
                              </td>
                              <td style={panelCell}>
                                <Text style={panelLabel}>Rent per month</Text>
                                <Text style={panelValue}>{fmt(monthly_rent, currency)}</Text>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: '20px 32px 0 32px' }}>
                        <Button href={dashboard_url} style={cta}>Open my Funder dashboard</Button>
                        <Text style={muted}>
                          You can follow every step — agent assigned, tenant sourced, tenant placed — on your dashboard.
                        </Text>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: '24px 32px 28px 32px' }}>
                        <Text style={footer}>
                          Questions? Write to <Link href={`mailto:${support_email}`} style={footerLink}>{support_email}</Link>.
                        </Text>
                        <Text style={footer}>© {year} {company_name}. All rights reserved.</Text>
                        <Text style={footerMuted}>
                          <Link href={unsubscribe_url} style={footerLink}>Unsubscribe</Link> from these emails.
                        </Text>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = { backgroundColor: '#f8fafc', margin: 0, fontFamily: 'Arial, Helvetica, sans-serif' }
const card: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: '12px', border: `1px solid ${BORDER}` }
const h1: React.CSSProperties = { color: INK, fontSize: '22px', lineHeight: '28px', margin: '0 0 10px 0' }
const paragraph: React.CSSProperties = { color: BODY_C, fontSize: '14px', lineHeight: '21px', margin: '0 0 10px 0' }
const heroBox: React.CSSProperties = { backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px' }
const heroAmount: React.CSSProperties = { color: SUCCESS, fontSize: '26px', fontWeight: 800, margin: '0 0 4px 0' }
const heroLabel: React.CSSProperties = { color: INK, fontSize: '13px', lineHeight: '19px', margin: '0 0 6px 0' }
const heroSub: React.CSSProperties = { color: BODY_C, fontSize: '12px', lineHeight: '18px', margin: 0 }
const panelCell: React.CSSProperties = { padding: '10px 14px', backgroundColor: '#f8fafc', border: `1px solid ${BORDER}` }
const panelLabel: React.CSSProperties = { color: MUTED, fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 3px 0' }
const panelValue: React.CSSProperties = { color: INK, fontSize: '15px', fontWeight: 800, margin: 0 }
const cta: React.CSSProperties = { backgroundColor: '#b45309', borderRadius: '8px', color: '#ffffff', display: 'inline-block', fontSize: '14px', fontWeight: 700, padding: '12px 22px', textDecoration: 'none' }
const muted: React.CSSProperties = { color: MUTED, fontSize: '12px', lineHeight: '18px', margin: '12px 0 0 0' }
const footer: React.CSSProperties = { color: MUTED, fontSize: '11px', lineHeight: '17px', margin: '0 0 4px 0' }
const footerMuted: React.CSSProperties = { color: '#94a3b8', fontSize: '11px', margin: '6px 0 0 0' }
const footerLink: React.CSSProperties = { color: '#b45309', textDecoration: 'underline' }

export const template = {
  component: FunderHouseProgress,
  subject: (d: Record<string, any>) => {
    if (d.kind === 'tenant_placed') return 'A tenant has moved into your funded house'
    if (d.kind === 'earning_started') return 'Your Welile Returns have started'
    return 'A Welile agent is now on your funded house'
  },
  displayName: 'Funder: house progress (agent, tenant, earnings)',
  previewData: {
    kind: 'tenant_placed',
    partner_name: 'Jane',
    house_title: '2 bedroom house',
    district: 'Wakiso',
    house_count: 1,
    monthly_rent: 600000,
    principal: 600000,
    monthly_return: 90000,
    agent_name: 'Peter Okello',
    placed_date: '24 Sep 2026',
    first_return_date: '20 Oct 2026',
    return_rate: 15,
  } satisfies Props,
} satisfies TemplateEntry
