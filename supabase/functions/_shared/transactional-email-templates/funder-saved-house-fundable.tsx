import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface HouseLine {
  title?: string
  district?: string
  monthly_rent?: string | number
  monthly_earning?: string | number
}

interface Props {
  partner_name?: string
  houses?: HouseLine[]
  total_needed?: string | number
  total_monthly_earning?: string | number
  return_rate?: number
  first_return_date?: string

  dashboard_url?: string
  currency?: string
  company_name?: string
  logo_url?: string
  support_email?: string
  unsubscribe_url?: string
}

const BRAND = '#b45309'
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

export function FunderSavedHouseFundable({
  partner_name = 'Partner',
  houses = [],
  total_needed = 0,
  total_monthly_earning = 0,
  return_rate = 15,
  first_return_date = '',
  dashboard_url = 'https://welileapp.com/dashboard/funder',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: Props) {
  const year = new Date().getFullYear()
  const count = houses.length
  const noun = count === 1 ? 'house' : 'houses'

  return (
    <Html>
      <Head />
      <Preview>{`Your saved ${noun} ${count === 1 ? 'is' : 'are'} ready to fund — earn ${fmt(total_monthly_earning, currency)} a month`}</Preview>
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
                        <Heading as="h1" style={h1}>Your saved {noun} {count === 1 ? 'is' : 'are'} ready to fund</Heading>
                        <Text style={paragraph}>
                          Hi {partner_name}, good news — your wallet balance now covers the {noun} you saved.
                          You can fund {count === 1 ? 'it' : 'them'} right away.
                        </Text>
                      </td>
                    </tr>

                    {Number(total_monthly_earning) > 0 && (
                      <tr>
                        <td style={{ padding: '4px 32px 0 32px' }}>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={heroBox}>
                            <tbody>
                              <tr>
                                <td style={{ padding: '16px 20px' }}>
                                  <Text style={heroAmount}>{fmt(total_monthly_earning, currency)}</Text>
                                  <Text style={heroLabel}>
                                    estimated Returns every month ({return_rate}% of your money), for as long as your money is working
                                  </Text>
                                  <Text style={heroSub}>
                                    Welile collects the rent and pays your Returns into your Welile wallet
                                    {first_return_date
                                      ? ` starting ${first_return_date}, then on the same date each month.`
                                      : ' on the same date each month.'}
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
                        <Text style={sectionTitle}>Your selected {noun}</Text>
                        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
                          <tbody>
                            {houses.map((h, i) => (
                              <tr key={i}>
                                <td style={{ padding: '10px 14px', borderBottom: i === houses.length - 1 ? 'none' : `1px solid ${BORDER}`, backgroundColor: i % 2 === 0 ? '#f8fafc' : '#ffffff' }}>
                                  <Text style={houseTitle}>{h.title || 'House'}{h.district ? ` — ${h.district}` : ''}</Text>
                                  <Text style={houseMeta}>
                                    Rent {fmt(h.monthly_rent, currency)}/month · you earn {fmt(h.monthly_earning, currency)}/month
                                  </Text>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: '14px 32px 0 32px' }}>
                        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
                          <tbody>
                            <tr>
                              <td style={panelCell}>
                                <Text style={panelLabel}>Amount to fund</Text>
                                <Text style={panelValue}>{fmt(total_needed, currency)}</Text>
                              </td>
                              <td style={panelCell}>
                                <Text style={panelLabel}>Your monthly Returns</Text>
                                <Text style={panelValue}>{fmt(total_monthly_earning, currency)}</Text>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: '20px 32px 0 32px' }}>
                        <Text style={paragraph}>
                          Open your Funder dashboard, review the highlighted {noun} under
                          &ldquo;Saved for later&rdquo;, and tap <strong>Fund now</strong> to put your money to work.
                        </Text>
                        <Button href={dashboard_url} style={cta}>Open my saved houses</Button>
                        <Text style={muted}>
                          The {noun} stay{count === 1 ? 's' : ''} highlighted in your dashboard until you fund or dismiss {count === 1 ? 'it' : 'them'}.
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
const heroBox: React.CSSProperties = { backgroundColor: '#f0fdf4', border: `1px solid #bbf7d0`, borderRadius: '10px' }
const heroAmount: React.CSSProperties = { color: SUCCESS, fontSize: '26px', fontWeight: 800, margin: '0 0 4px 0' }
const heroLabel: React.CSSProperties = { color: INK, fontSize: '13px', lineHeight: '19px', margin: '0 0 6px 0' }
const heroSub: React.CSSProperties = { color: BODY_C, fontSize: '12px', lineHeight: '18px', margin: 0 }
const sectionTitle: React.CSSProperties = { color: MUTED, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px 0' }
const houseTitle: React.CSSProperties = { color: INK, fontSize: '13px', fontWeight: 700, margin: '0 0 2px 0' }
const houseMeta: React.CSSProperties = { color: MUTED, fontSize: '12px', margin: 0 }
const panelCell: React.CSSProperties = { padding: '10px 14px', backgroundColor: '#f8fafc', border: `1px solid ${BORDER}` }
const panelLabel: React.CSSProperties = { color: MUTED, fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 3px 0' }
const panelValue: React.CSSProperties = { color: INK, fontSize: '15px', fontWeight: 800, margin: 0 }
const cta: React.CSSProperties = { backgroundColor: BRAND, color: '#ffffff', borderRadius: '8px', fontSize: '14px', fontWeight: 700, padding: '12px 22px', textDecoration: 'none', display: 'inline-block', margin: '4px 0 12px 0' }
const muted: React.CSSProperties = { color: MUTED, fontSize: '12px', lineHeight: '18px', margin: 0 }
const footer: React.CSSProperties = { color: MUTED, fontSize: '11px', lineHeight: '17px', margin: '0 0 4px 0' }
const footerMuted: React.CSSProperties = { color: MUTED, fontSize: '11px', lineHeight: '17px', margin: 0 }
const footerLink: React.CSSProperties = { color: BRAND, textDecoration: 'underline' }

export const template = {
  component: FunderSavedHouseFundable,
  subject: (d: Props) => {
    const count = d.houses?.length ?? 0
    const noun = count === 1 ? 'house' : 'houses'
    const earn = d.total_monthly_earning
      ? ` — earn UGX ${Number(String(d.total_monthly_earning).replace(/,/g, '')).toLocaleString('en-US', { maximumFractionDigits: 0 })} a month`
      : ''
    return `Your saved ${noun} ${count === 1 ? 'is' : 'are'} ready to fund${earn}`
  },
  displayName: 'Funder: saved house now fundable',
  previewData: {
    partner_name: 'Jane',
    houses: [
      { title: '2 bedroom house', district: 'Wakiso', monthly_rent: 600000, monthly_earning: 90000 },
      { title: '1 bedroom house', district: 'Kampala', monthly_rent: 400000, monthly_earning: 60000 },
    ],
    total_needed: 1000000,
    total_monthly_earning: 150000,
    return_rate: 15,
    first_return_date: '20 Oct 2026',
  } satisfies Props,
} satisfies TemplateEntry
