import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PartnerPortfolioInviteProps {
  partner_name?: string
  portfolio_code?: string
  amount?: string | number
  duration_months?: number
  roi_percentage?: number
  roi_mode?: string
  completion_url?: string
  currency?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
  terms_url?: string
  privacy_url?: string
}

const fmtAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const roiModeLabel = (m?: string) =>
  m === 'monthly_compounding' ? 'Monthly compounding' : 'Monthly payout'

export function PartnerPortfolioInvite({
  partner_name = 'Partner',
  portfolio_code = '',
  amount = 0,
  duration_months = 12,
  roi_percentage = 0,
  roi_mode = 'monthly_payout',
  completion_url = 'https://welileapp.com',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  terms_url = 'https://welileapp.com/partners-terms',
  privacy_url = 'https://welileapp.com/privacy',
}: PartnerPortfolioInviteProps) {
  const year = new Date().getFullYear()
  const fmtValue = fmtAmount(amount, currency)

  return (
    <Html>
      <Head><style>{clientOverrides}</style></Head>
      <Preview>Complete your new Welile portfolio {portfolio_code}</Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bgTable}>
          <tbody><tr><td align="center" style={{ padding: '40px 10px' }}>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={contentCard}>
              <tbody>
                <tr><td height={6} style={accentBar}></td></tr>

                <tr>
                  <td className="padding-mobile" style={headerCell}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="left" valign="middle">
                          <Img src={logo_url} alt={`${company_name} Technologies Limited`} width="130" style={logoImg} />
                        </td>
                        <td align="right" valign="middle" className="hide-mobile" style={secureLabel}>
                          ACTION REQUIRED
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 10px 40px' }}>
                    <Heading style={heroH1}>Complete your new portfolio</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={{ ...introText, margin: 0 }}>
                      Welile Partner Operations has drafted a new partnership portfolio in your name. To
                      activate it, please review the terms, confirm your identity details, and sign the
                      addendum using the secure link below.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailEyebrow}>Portfolio Reference</Text>
                            <Text style={detailTitle}>
                              {portfolio_code && <span style={{ color: '#a855f7' }}>#{portfolio_code}</span>}
                            </Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Portfolio Value</Text>
                                    <Text style={fieldValue}>{fmtValue}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Duration</Text>
                                    <Text style={fieldValueSub}>{duration_months} months</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Returns</Text>
                                    <Text style={{ ...fieldValueSub, color: '#7b19d4', fontWeight: 700 }}>{roi_percentage}% p.m.</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Payout Mode</Text>
                                    <Text style={fieldValueSub}>{roiModeLabel(roi_mode)}</Text>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '5px 40px 15px 40px' }}>
                    <Button href={completion_url} style={ctaButton}>
                      Review &amp; sign portfolio
                    </Button>
                    <Text style={ctaHint}>
                      Or open this link in your browser:<br />
                      <Link href={completion_url} style={ctaLink}>{completion_url}</Link>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <Text style={noteText}>
                      This secure link is valid for <strong>7 days</strong> and can only be used once.
                      No funds move until you confirm and our team approves your submission.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>Welile Partnership Team</span>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}><em>"Welile is turning rent into an asset."</em></Text>
                  </td>
                </tr>
              </tbody>
            </table>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={{ marginTop: '30px' }}>
              <tbody><tr>
                <td align="center" style={{ padding: '0 20px' }}>
                  <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because Welile Partner Operations invited you to
                    complete a new partnership portfolio. If you didn't expect this email, simply
                    reply and let us know.
                  </Text>
                  <Text style={{ margin: '0 0 15px 0', textAlign: 'center' as const }}>
                    <Link href={privacy_url} style={footerLink}>Privacy Policy</Link>
                    <Link href={terms_url} style={footerLink}>Terms of Service</Link>
                    <Link href={unsubscribe_url} style={footerLink}>Unsubscribe</Link>
                  </Text>
                  <Text style={footerCopyText}>© {year} WELILE TECHNOLOGIES LTD. All rights reserved.</Text>
                </td>
              </tr></tbody>
            </table>

          </td></tr></tbody>
        </table>
      </Body>
    </Html>
  )
}

const BRAND = '#7b19d4'
const BRAND_DEEP = '#5a129e'
const INK = '#0f172a'
const BODY = '#475569'
const SUB = '#64748b'
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
  a { color: ${BRAND}; text-decoration: none; font-weight: 600; }
  a:hover { color: ${BRAND_DEEP}; text-decoration: underline; }
  @media screen and (max-width: 600px) {
    .responsive-table { width: 100% !important; max-width: 100% !important; }
    .padding-mobile { padding: 25px 20px !important; }
    .td-block { display: block !important; width: 100% !important; text-align: left !important; }
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
const heroH1: React.CSSProperties = { margin: '0 0 15px 0', color: INK, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px' }
const greetingText: React.CSSProperties = { margin: '0 0 15px 0', color: INK, fontSize: '16px', fontWeight: 600 }
const introText: React.CSSProperties = { margin: '0 0 15px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const detailCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const detailHeader: React.CSSProperties = { backgroundColor: '#f8fafc', padding: '20px 30px', borderBottom: `1px solid ${BORDER}` }
const detailEyebrow: React.CSSProperties = { margin: '0 0 5px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }
const detailTitle: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 700 }
const fieldLabel: React.CSSProperties = { margin: '0 0 5px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const fieldValue: React.CSSProperties = { margin: 0, color: INK, fontSize: '16px', fontWeight: 700 }
const fieldValueSub: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', fontWeight: 600 }
const ctaButton: React.CSSProperties = { backgroundColor: BRAND, backgroundImage: `linear-gradient(90deg, ${BRAND} 0%, #a855f7 100%)`, color: '#ffffff', fontSize: '15px', fontWeight: 700, textDecoration: 'none', padding: '16px 28px', borderRadius: '10px', display: 'inline-block', letterSpacing: '0.2px' }
const ctaHint: React.CSSProperties = { margin: '18px 0 0 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const ctaLink: React.CSSProperties = { color: BRAND, fontSize: '12px', wordBreak: 'break-all', fontWeight: 500 }
const noteText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '14px', lineHeight: '22px' }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 700, color: BODY }
const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: `1px solid #e5e7eb` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const, textTransform: 'uppercase' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template = {
  component: PartnerPortfolioInvite,
  // Amount is included so a partner who receives two invites in the same
  // session sees two clearly different subjects instead of one repeated line
  // that mail clients collapse into a single thread.
  subject: (data: Record<string, any>) => {
    const amount = Number(data?.amount || 0)
    const amountPart = amount > 0 ? ` — UGX ${amount.toLocaleString('en-US')}` : ''
    const codePart = data?.portfolio_code ? ` ${data.portfolio_code}` : ''
    return `Complete your new Welile portfolio${codePart}${amountPart}`
  },
  displayName: 'Partner Portfolio Invite',
  previewData: {
    partner_name: 'Sarah Nakato',
    portfolio_code: 'WPF-1234',
    amount: 1_500_000,
    duration_months: 12,
    roi_percentage: 5,
    roi_mode: 'monthly_payout',
    completion_url: 'https://welileapp.com/partners/00000000-0000-0000-0000-000000000000/portfolios/00000000-0000-0000-0000-000000000000/complete?token=preview',
    currency: 'UGX',
    company_name: 'Welile',
  },
} satisfies TemplateEntry