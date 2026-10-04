import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface HouseLine {
  title?: string
  district?: string
  monthly_rent?: string | number
}

type Kind = 'booked' | 'funded' | 'reminder' | 'released' | 'given_up'

interface Props {
  kind?: Kind
  partner_name?: string
  house_count?: number
  total_rent?: string | number
  monthly_return?: string | number
  promised_funding_date?: string
  release_date?: string
  days_left?: number
  first_return_date?: string
  return_rate?: number
  houses?: HouseLine[]

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
const SUB = '#475569'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'

const fmt = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const COPY: Record<Kind, { heading: string; intro: (n: number) => string; outro: string }> = {
  booked: {
    heading: 'Your houses are held for you',
    intro: (n) => `We have held ${n} empty ${n === 1 ? 'house' : 'houses'} for you for 7 days. An agent will place a tenant in each house once your funding is in.`,
    outro: 'If the hold lapses before funding, the houses return to the open list for other Supporters.',
  },
  funded: {
    heading: 'Funding received — thank you',
    intro: (n) => `Your support for ${n} ${n === 1 ? 'house' : 'houses'} has been submitted for operational review. Once approved, the rent is released to the landlords and an agent starts placing tenants.`,
    outro: 'You will earn Returns of 15% per month on the capital you deployed.',
  },
  reminder: {
    heading: 'Your hold is about to lapse',
    intro: (n) => `${n} ${n === 1 ? 'house' : 'houses'} you booked are still waiting for funding. Please complete the funding to keep them.`,
    outro: 'After the date below, these houses go back to the open list for other Supporters.',
  },
  released: {
    heading: 'Your booking has lapsed',
    intro: (n) => `The 7-day hold on ${n} ${n === 1 ? 'house' : 'houses'} has ended, so ${n === 1 ? 'it has' : 'they have'} been returned to the open empty-house list.`,
    outro: 'You are welcome to book again at any time — availability changes daily.',
  },
  given_up: {
    heading: 'Booking cancelled',
    intro: (n) => `You released ${n} booked ${n === 1 ? 'house' : 'houses'}. ${n === 1 ? 'It is' : 'They are'} back on the open empty-house list.`,
    outro: 'You can browse and book other empty houses whenever you are ready.',
  },
}

export function FunderHouseBooking({
  kind = 'booked',
  partner_name = 'Partner',
  house_count = 0,
  total_rent = 0,
  monthly_return = 0,
  promised_funding_date = '',
  release_date = '',
  days_left = 7,
  first_return_date = '',
  return_rate = 15,
  houses = [],
  dashboard_url = 'https://welileapp.com/dashboard/supporter',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: Props) {
  const year = new Date().getFullYear()
  const count = house_count || houses.length
  const copy = COPY[kind] ?? COPY.booked
  const showEarnings = (kind === 'booked' || kind === 'funded') && Number(monthly_return) > 0


  return (
    <Html>
      <Head />
      <Preview>{`${copy.heading} — ${count} ${count === 1 ? 'house' : 'houses'}`}</Preview>
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
                        <Heading style={h1}>{copy.heading}</Heading>
                        <Text style={sub}>Dear {partner_name},</Text>
                        <Text style={sub}>{copy.intro(count)}</Text>
                      </td>
                    </tr>

                    {showEarnings && (
                      <tr>
                        <td style={{ padding: '20px 32px 0 32px' }}>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={hero}>
                            <tbody>
                              <tr>
                                <td style={{ padding: '22px 24px 6px 24px' }} align="center">
                                  <Text style={heroLabel}>You will earn</Text>
                                  <Text style={heroAmount}>{fmt(monthly_return, currency)}</Text>
                                  <Text style={heroPer}>every month, for as long as your money is working</Text>
                                </td>
                              </tr>
                              <tr>
                                <td style={{ padding: '4px 24px 22px 24px' }} align="center">
                                  <Text style={heroDate}>
                                    Welile collects your Returns for you and pays them into your
                                    Welile wallet on <strong>{first_return_date || 'the same date each month'}</strong>
                                    {first_return_date ? ', then on the same date every month after that.' : '.'}
                                  </Text>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}

                    {showEarnings && (
                      <tr>
                        <td style={{ padding: '18px 32px 0 32px' }}>
                          <Heading as="h2" style={h2}>How you earn, step by step</Heading>
                          <Text style={step}><strong>1.</strong> You put in {fmt(total_rent, currency)} — the rent these {count === 1 ? 'house needs' : 'houses need'} for the month.</Text>
                          <Text style={step}><strong>2.</strong> A Welile agent places a tenant in {count === 1 ? 'the house' : 'each house'} and collects the rent from them.</Text>
                          <Text style={step}><strong>3.</strong> Welile pays you {fmt(monthly_return, currency)} — that is {return_rate}% of your money — into your wallet{first_return_date ? ` on ${first_return_date}` : ''}, and again on the same date each month.</Text>
                          <Text style={step}><strong>4.</strong> You can take your Returns out of your wallet, or leave them in to grow.</Text>
                        </td>
                      </tr>
                    )}



                    <tr>
                      <td style={{ padding: '20px 32px 0 32px' }}>
                        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={panel}>
                          <tbody>
                            <tr>
                              <td style={cell}>
                                <Text style={label}>Houses</Text>
                                <Text style={value}>{count}</Text>
                              </td>
                              <td style={cell}>
                                <Text style={label}>Monthly rent needed</Text>
                                <Text style={value}>{fmt(total_rent, currency)}</Text>
                              </td>
                            </tr>
                            <tr>
                              <td style={cell}>
                                <Text style={label}>Your Returns / month</Text>
                                <Text style={valueSub}>{fmt(monthly_return, currency)}</Text>
                              </td>
                              <td style={cell}>
                                <Text style={label}>
                                  {kind === 'reminder' || kind === 'booked' ? 'Hold ends' : 'Date'}
                                </Text>
                                <Text style={valueSub}>
                                  {release_date || promised_funding_date || '—'}
                                  {kind === 'reminder' ? ` (${days_left} day${days_left === 1 ? '' : 's'} left)` : ''}
                                </Text>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>

                    {houses.length > 0 && (
                      <tr>
                        <td style={{ padding: '20px 32px 0 32px' }}>
                          <Heading as="h2" style={h2}>Houses</Heading>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={houseCard}>
                            <tbody>
                              {houses.slice(0, 12).map((h, i) => (
                                <tr key={i} style={{ borderTop: i === 0 ? 'none' : `1px solid ${BORDER}` }}>
                                  <td style={{ padding: '12px 16px' }}>
                                    <Text style={houseName}>{h.title || 'Empty house'}</Text>
                                    <Text style={houseLoc}>{h.district || ''}</Text>
                                  </td>
                                  <td style={{ padding: '12px 16px', textAlign: 'right' as const }}>
                                    <Text style={houseAmt}>{fmt(h.monthly_rent, currency)}</Text>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}

                    <tr>
                      <td align="center" style={{ padding: '24px 32px 0 32px' }}>
                        <Link href={dashboard_url} style={{ ...button, backgroundColor: BRAND }}>
                          Open my Supporter dashboard
                        </Link>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: '22px 32px 0 32px' }}>
                        <Text style={outro}>{copy.outro}</Text>
                        <Text style={outro}>
                          Questions? Write to{' '}
                          <Link href={`mailto:${support_email}`} style={inline}>{support_email}</Link>.
                        </Text>
                        <Text style={signature}>The {company_name} Partnerships Team</Text>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: '26px 32px 30px 32px' }}>
                        <Text style={footer}>
                          © {year} {company_name}. All rights reserved.
                          <br />
                          <Link href={unsubscribe_url} style={{ ...inline, color: MUTED }}>Unsubscribe</Link>
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

const body: React.CSSProperties = { margin: 0, padding: 0, backgroundColor: '#f8fafc', fontFamily: 'Helvetica, Arial, sans-serif' }
const card: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: '16px', border: `1px solid ${BORDER}` }
const h1: React.CSSProperties = { margin: '0 0 10px 0', color: INK, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px' }
const h2: React.CSSProperties = { margin: '0 0 10px 0', color: INK, fontSize: '18px', fontWeight: 800 }
const sub: React.CSSProperties = { margin: '0 0 10px 0', color: SUB, fontSize: '15px', lineHeight: '24px' }
const panel: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', backgroundColor: '#fffbeb' }
const hero: React.CSSProperties = { border: `1px solid #fcd34d`, borderRadius: '14px', backgroundColor: '#fffbeb' }
const heroLabel: React.CSSProperties = { margin: '0 0 6px 0', color: BRAND, fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }
const heroAmount: React.CSSProperties = { margin: '0 0 6px 0', color: INK, fontSize: '36px', lineHeight: '42px', fontWeight: 800, letterSpacing: '-1px' }
const heroPer: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '15px', fontWeight: 600 }
const heroDate: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '14px', lineHeight: '22px', textAlign: 'center' as const }
const step: React.CSSProperties = { margin: '0 0 8px 0', color: BODY_C, fontSize: '14px', lineHeight: '22px' }

const cell: React.CSSProperties = { padding: '16px 20px', width: '50%' }
const label: React.CSSProperties = { margin: '0 0 4px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const value: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 800 }
const valueSub: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '15px', fontWeight: 700 }
const houseCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' }
const houseName: React.CSSProperties = { margin: '0 0 2px 0', color: INK, fontSize: '15px', fontWeight: 700 }
const houseLoc: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '13px' }
const houseAmt: React.CSSProperties = { margin: 0, color: INK, fontSize: '15px', fontWeight: 700 }
const button: React.CSSProperties = { display: 'inline-block', padding: '14px 30px', color: '#ffffff', fontSize: '15px', fontWeight: 700, textDecoration: 'none', borderRadius: '8px' }
const outro: React.CSSProperties = { margin: '0 0 10px 0', color: BODY_C, fontSize: '14px', lineHeight: '22px' }
const inline: React.CSSProperties = { color: BRAND, fontWeight: 600, textDecoration: 'none' }
const signature: React.CSSProperties = { margin: '22px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const footer: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }

export const template: TemplateEntry = {
  component: FunderHouseBooking,
  displayName: 'Supporter — Empty House Booking',
  subject: (data: Record<string, any>) => {
    const count = Number(data?.house_count ?? 0) || 0
    const noun = `${count} ${count === 1 ? 'house' : 'houses'}`
    const currency = String(data?.currency ?? 'UGX')
    const earn = Number(String(data?.monthly_return ?? 0).replace(/,/g, '')) || 0
    const earnLabel = `${currency} ${earn.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    switch (String(data?.kind ?? 'booked')) {
      case 'funded':
        return earn > 0
          ? `Funding received for ${noun} — you earn ${earnLabel} a month`
          : `Funding received for ${noun}`
      case 'reminder': return `${Number(data?.days_left ?? 3) || 3} days left to fund ${noun}`
      case 'released': return `Your booking of ${noun} has lapsed`
      case 'given_up': return `You released ${noun}`
      default:
        return earn > 0
          ? `${noun} held for you — you earn ${earnLabel} a month`
          : `${noun} held for you for 7 days`
    }
  },
  previewData: {
    kind: 'booked',
    partner_name: 'SSENKAALI PIUS',
    house_count: 2,
    total_rent: 900000,
    monthly_return: 135000,
    release_date: '10 Sep 2026',
    promised_funding_date: '8 Sep 2026',
    first_return_date: '10 Oct 2026',
    return_rate: 15,
    houses: [

      { title: 'Two-bedroom in Kabaale', district: 'Wakiso', monthly_rent: 500000 },
      { title: 'Single room in Bweyogerere', district: 'Wakiso', monthly_rent: 400000 },
    ],
    currency: 'UGX',
  },
}
