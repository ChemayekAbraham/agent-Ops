import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PortfolioRequestTeamAlertProps {
  partner_name?: string
  partner_email?: string
  portfolio_name?: string
  portfolio_id?: string
  portfolio_value?: string | number
  maturity_date?: string
  request_type?: string
  request_reference?: string
  submitted_at?: string
  message?: string
  currency?: string
  company_name?: string
  logo_url?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const labelFor = (t?: string) =>
  t === 'REDEMPTION_REQUEST' ? 'Capital Redemption Request' : 'Partnership Renewal Request'

export function PortfolioRequestTeamAlert({
  partner_name = 'Partner',
  partner_email = '',
  portfolio_name = 'Partnership Portfolio',
  portfolio_id = '',
  portfolio_value = 0,
  maturity_date = '',
  request_type = 'RENEWAL_REQUEST',
  request_reference = '',
  submitted_at = '',
  message = '',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
}: PortfolioRequestTeamAlertProps) {
  const fmtValue = formatAmount(portfolio_value, currency)
  const reqLabel = labelFor(request_type)
  const isRedeem = request_type === 'REDEMPTION_REQUEST'

  return (
    <Html>
      <Head><style>{clientOverrides}</style></Head>
      <Preview>New {reqLabel} — {portfolio_id}</Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bgTable}>
          <tbody><tr><td align="center" style={{ padding: '40px 10px' }}>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={contentCard}>
              <tbody>
                <tr><td height={6} style={{ ...accentBar, backgroundImage: isRedeem ? 'linear-gradient(90deg, #16a34a 0%, #21C45D 100%)' : accentBar.backgroundImage }}></td></tr>

                <tr>
                  <td className="padding-mobile" style={headerCell}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="left" valign="middle">
                          <Img src={logo_url} alt={`${company_name} Technologies Limited`} width="130" style={logoImg} />
                        </td>
                        <td align="right" valign="middle" className="hide-mobile" style={secureLabel}>
                          INTERNAL ALERT
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '32px 40px 8px 40px' }}>
                    <Text style={eyebrow}>Partnership Team — Action Required</Text>
                    <Heading style={heroH1}>New {reqLabel}</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 20px 40px' }}>
                    <Text style={{ ...introText, margin: 0 }}>
                      A partner has submitted a {reqLabel.toLowerCase()} through the maturity workflow. Details below.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr><td style={{ padding: '22px 28px' }}>
                          <Row label="Partner" value={partner_name} />
                          <Row label="Partner Email" value={partner_email || '—'} />
                          <Row label="Portfolio" value={portfolio_name} />
                          <Row label="Portfolio ID" value={portfolio_id || '—'} />
                          <Row label="Portfolio Value" value={fmtValue} strong />
                          <Row label="Maturity Date" value={maturity_date || '—'} />
                          <Row label="Request Type" value={reqLabel} strong />
                          <Row label="Request Reference" value={request_reference || '—'} />
                          <Row label="Submitted" value={submitted_at || '—'} last />
                        </td></tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                {message && (
                  <tr>
                    <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={insightCard}>
                        <tbody><tr><td style={{ padding: '15px 20px' }}>
                          <Text style={insightTitle}>Partner Message</Text>
                          <Text style={insightBody}>{message}</Text>
                        </td></tr></tbody>
                      </table>
                    </td>
                  </tr>
                )}

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={outroText}>
                      Please review this request in the partnership operations dashboard and follow up with the partner.
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>

          </td></tr></tbody>
        </table>
      </Body>
    </Html>
  )
}

function Row({ label, value, strong, last }: { label: string; value: string; strong?: boolean; last?: boolean }) {
  return (
    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"
      style={{ borderBottom: last ? 'none' : '1px solid #eef2f7' }}>
      <tbody><tr>
        <td style={{ padding: '10px 0', width: '40%', color: '#94a3b8', fontSize: '13px', fontWeight: 600 }}>{label}</td>
        <td style={{ padding: '10px 0', color: strong ? '#7b19d4' : '#0f172a', fontSize: '14px', fontWeight: strong ? 700 : 600, textAlign: 'right' }}>{value}</td>
      </tr></tbody>
    </table>
  )
}

const BRAND = '#7b19d4'
const INK = '#0f172a'
const BODY = '#475569'
const MUTED = '#94a3b8'
const BORDER = '#e2e8f0'
const HAIRLINE = '#f1f5f9'
const PAGE_BG = '#f4f7f9'
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const clientOverrides = `
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  table { border-collapse: collapse !important; }
  body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
  @media screen and (max-width: 600px) {
    .responsive-table { width: 100% !important; max-width: 100% !important; }
    .padding-mobile { padding: 25px 20px !important; }
    .hide-mobile { display: none !important; }
  }
`

const main: React.CSSProperties = { margin: 0, padding: 0, backgroundColor: PAGE_BG, fontFamily: FONT_STACK, WebkitFontSmoothing: 'antialiased' }
const bgTable: React.CSSProperties = { backgroundColor: PAGE_BG }
const contentCard: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 4px 15px rgba(0,0,0,0.05)' }
const accentBar: React.CSSProperties = { backgroundColor: BRAND, backgroundImage: `linear-gradient(90deg, ${BRAND} 0%, #a855f7 100%)` }
const headerCell: React.CSSProperties = { padding: '30px 40px', borderBottom: `1px solid ${HAIRLINE}` }
const logoImg: React.CSSProperties = { display: 'block', maxWidth: '130px', height: 'auto' }
const secureLabel: React.CSSProperties = { fontSize: '11px', color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const eyebrow: React.CSSProperties = { margin: '0 0 6px 0', color: BRAND, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const heroH1: React.CSSProperties = { margin: 0, color: INK, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }
const introText: React.CSSProperties = { margin: '0 0 15px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const detailCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const insightCard: React.CSSProperties = { backgroundColor: '#faf5ff', borderRadius: '8px', borderLeft: '4px solid #7b19d4' }
const insightTitle: React.CSSProperties = { margin: '0 0 5px 0', color: '#6d28d9', fontSize: '14px', fontWeight: 700 }
const insightBody: React.CSSProperties = { margin: 0, color: '#5b21b6', fontSize: '14px', lineHeight: '21px', whiteSpace: 'pre-line' as const }
const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }

export const template = {
  component: PortfolioRequestTeamAlert,
  subject: (data: Record<string, any>) => `New ${labelFor(data?.request_type)} — ${data?.portfolio_id || ''}`.trim(),
  displayName: 'Portfolio Request Team Alert',
  previewData: {
    partner_name: 'Sarah Nakato',
    partner_email: 'sarah@example.com',
    portfolio_name: 'Welile Growth Partnership',
    portfolio_id: 'PF-A1B2C3D4',
    portfolio_value: 1_800_000,
    maturity_date: '28 April 2026',
    request_type: 'RENEWAL_REQUEST',
    request_reference: 'REQ-2026-0001',
    submitted_at: '22 June 2026',
    message: 'Greetings, I would like to renew my partnership for a new cycle.',
    currency: 'UGX',
    company_name: 'Welile',
  },
} satisfies TemplateEntry