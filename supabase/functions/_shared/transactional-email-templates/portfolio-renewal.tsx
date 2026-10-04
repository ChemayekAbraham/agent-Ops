import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PortfolioRenewalProps {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  amount?: string | number
  old_principal?: string | number
  new_principal?: string | number
  return_rate?: string | number
  renewal_date?: string
  maturity_date?: string
  duration?: string
  currency?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
  terms_url?: string
  privacy_url?: string
  scheduled?: boolean
  days_remaining?: number | string
  days_remaining_label?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const formatRate = (r: string | number | undefined) => {
  if (r === undefined || r === null || r === '') return '—'
  const s = String(r).trim()
  return s.endsWith('%') ? s : `${s}%`
}

export function PortfolioRenewal({
  partner_name = 'Partner',
  portfolio_name = 'Partnership Portfolio',
  portfolio_id = '',
  amount = 0,
  new_principal,
  return_rate = '',
  renewal_date = '',
  maturity_date = '',
  duration = '',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  terms_url = 'https://welileapp.com/partners-terms',
  privacy_url = 'https://welileapp.com/privacy',
  scheduled = false,
  days_remaining,
  days_remaining_label,
}: PortfolioRenewalProps) {
  const year = new Date().getFullYear()
  const resolvedNew = new_principal ?? amount
  const formattedAmount = formatAmount(resolvedNew, currency)
  const formattedRate = formatRate(return_rate)
  const displayId = portfolio_id || ''
  const daysNum = days_remaining === undefined || days_remaining === null || days_remaining === ''
    ? undefined
    : Number(days_remaining)
  const resolvedLabel = days_remaining_label
    || (daysNum === undefined || Number.isNaN(daysNum)
      ? undefined
      : daysNum <= 0 ? 'Applied today' : `Auto-applies in ${daysNum} day${daysNum === 1 ? '' : 's'}`)
  const isScheduled = scheduled === true || scheduled === 'true' as any || (daysNum !== undefined && !Number.isNaN(daysNum) && daysNum > 0)
  const headline = isScheduled ? 'Portfolio Renewal Scheduled' : 'Portfolio Successfully Renewed'
  const intro = isScheduled
    ? `This is to confirm that your partnership portfolio renewal has been scheduled${resolvedLabel ? ` and will ${resolvedLabel.toLowerCase().startsWith('applied') ? 'be applied today' : resolvedLabel.toLowerCase().replace('auto-applies', 'auto-apply')}` : ''}. Below are the details of the upcoming renewal cycle.`
    : 'This is to confirm that your partnership portfolio has been successfully renewed. Your portfolio has rolled over into a new return cycle. Below are the key renewal details.'

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>{isScheduled ? 'Portfolio Renewal Scheduled' : 'Portfolio Renewal Confirmation'} — {formattedAmount}{resolvedLabel ? ` • ${resolvedLabel}` : ''}</Preview>
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
                          {isScheduled ? 'Renewal Scheduled' : 'Portfolio Renewed'}
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>{headline}</Heading>
                    {resolvedLabel && (
                      <Text style={countdownPill}>{resolvedLabel}</Text>
                    )}
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={{ ...introText, margin: 0 }}>{intro}</Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailEyebrow}>Portfolio Name</Text>
                            <Text style={detailTitle}>
                              {portfolio_name} {displayId && <span style={{ color: '#a855f7', fontSize: '15px' }}>(#{displayId})</span>}
                            </Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={principalRowCell}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="100%" valign="top">
                                    <Text style={principalLabel}>Principal</Text>
                                    <Text style={principalValue}>{formattedAmount}</Text>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Renewal Date</Text>
                                    <Text style={fieldValueSub}>{renewal_date || '—'}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Maturity Date</Text>
                                    <Text style={fieldValueSub}>{maturity_date || '—'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Return Rate</Text>
                                    <Text style={{ ...fieldValue, color: '#059669' }}>{formattedRate}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Cycle / Duration</Text>
                                    <Text style={fieldValueSub}>{duration || '—'}</Text>
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
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={insightCard}>
                      <tbody>
                        <tr>
                          <td style={{ padding: '15px 20px' }}>
                            <Text style={insightTitle}>Insight</Text>
                            <Text style={insightBody}>
                              Your renewed portfolio is active. Returns will continue to accrue on your principal value of <strong>{formattedAmount}</strong>. You can monitor the progress and daily tenant updates directly from your dashboard.
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={outroText}>
                      If you have any questions or require further clarification regarding this renewal, please reply directly to this email or reach out to our team at <Link href="mailto:partnership@welile.com">partnership@welile.com</Link> with your portfolio ID {displayId && <span>(#{displayId})</span>}.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>Partnership Team</span>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}>
                      <em>"Automated Notification System • Welile is turning rent into an asset."</em>
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={{ marginTop: '30px' }}>
              <tbody><tr>
                <td align="center" style={{ padding: '0 20px' }}>
                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ marginBottom: '25px' }}>
                    <tbody><tr>
                      <td style={{ padding: '0 12px' }}>
                        <a href="https://x.com/Welile2025"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/twitter.png" alt="Twitter" width="22" style={socialIcon} /></a>
                      </td>
                      <td style={{ padding: '0 12px' }}>
                        <a href="https://ug.linkedin.com/company/welile"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/linkedin.png" alt="LinkedIn" width="22" style={socialIcon} /></a>
                      </td>
                      <td style={{ padding: '0 12px' }}>
                        <a href="https://www.facebook.com/profile.php?id=61578974799814"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/facebook-new.png" alt="Facebook" width="22" style={socialIcon} /></a>
                      </td>
                      <td style={{ padding: '0 12px' }}>
                        <a href="https://www.instagram.com/welile_technologies/"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/instagram-new.png" alt="Instagram" width="22" style={socialIcon} /></a>
                      </td>
                    </tr></tbody>
                  </table>

                  <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                  <Text style={{ margin: '0 0 20px 0', fontSize: '13px', textAlign: 'center' as const }}>
                    <Link href="https://maps.app.goo.gl/zfmsP2m2cCXEJXPe9" style={{ color: '#a855f7', textDecoration: 'none' }}>
                      Palm Lane Kabaale, Entebbe
                    </Link>
                  </Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you are a registered partner at {company_name}.<br />
                    This is an automated notification, but you can reply directly to this email if you need assistance.
                  </Text>
                  <Text style={{ margin: '0 0 15px 0', textAlign: 'center' as const }}>
                    <Link href={privacy_url} style={footerLink}>Privacy Policy</Link>
                    <Link href={terms_url} style={footerLink}>Terms of Service</Link>
                    <Link href={unsubscribe_url} style={footerLink}>Unsubscribe</Link>
                  </Text>
                  <Text style={footerCopyText}>© {year} {company_name}. All rights reserved.</Text>
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
const detailHeader: React.CSSProperties = { backgroundColor: '#f8fafc', padding: '25px 30px', borderBottom: `1px solid ${BORDER}` }
const detailEyebrow: React.CSSProperties = { margin: '0 0 5px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }
const detailTitle: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 700 }
const principalRowCell: React.CSSProperties = { padding: '25px 30px 10px 30px', borderBottom: `1px solid ${BORDER}` }
const principalLabel: React.CSSProperties = { margin: '0 0 5px 0', color: BRAND, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }
const principalValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '22px', fontWeight: 800 }
const fieldLabel: React.CSSProperties = { margin: '0 0 5px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const fieldValue: React.CSSProperties = { margin: 0, color: INK, fontSize: '16px', fontWeight: 700 }
const fieldValueSub: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', fontWeight: 600 }

const insightCard: React.CSSProperties = { backgroundColor: '#f0fdfa', borderRadius: '8px', borderLeft: '4px solid #14b8a6' }
const insightTitle: React.CSSProperties = { margin: '0 0 5px 0', color: '#0f766e', fontSize: '14px', fontWeight: 600 }
const insightBody: React.CSSProperties = { margin: 0, color: '#0f766e', fontSize: '14px', lineHeight: '20px' }

const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 700, color: BODY }

const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: `1px solid #e5e7eb` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }

const countdownPill: React.CSSProperties = { display: 'inline-block', margin: '10px 0 0 0', padding: '6px 14px', backgroundColor: '#f3e8ff', color: BRAND_DEEP, fontSize: '13px', fontWeight: 700, borderRadius: '999px', letterSpacing: '0.2px' }

const socialIcon: React.CSSProperties = { display: 'block', opacity: 0.8 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template = {
  component: PortfolioRenewal,
  subject: (data: Record<string, any>) => {
    const formatted = formatAmount(data?.amount, data?.currency || 'UGX')
    return `Portfolio Renewal Confirmation — ${formatted}`
  },
  displayName: 'Portfolio Renewal Confirmation',
  previewData: {
    partner_name: 'Sarah Nakato',
    portfolio_name: 'Welile Growth Partnership',
    portfolio_id: 'a1b2c3d4-1111-2222-3333-444455556666',
    amount: 1_800_000,
    old_principal: 1_500_000,
    new_principal: 1_800_000,
    return_rate: '20%',
    renewal_date: '28 April 2026',
    maturity_date: '28 April 2027',
    duration: '12 months',
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    terms_url: 'https://welileapp.com/partners-terms',
    privacy_url: 'https://welileapp.com/privacy',
  },
} satisfies TemplateEntry
