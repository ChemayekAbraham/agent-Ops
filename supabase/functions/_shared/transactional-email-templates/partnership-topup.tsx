import * as React from 'npm:react@18.3.1'
import {
  Body,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PartnershipTopupProps {
  partner_name?: string
  topup_amount?: string | number
  previous_portfolio_value?: string | number
  new_total_partnership_value?: string | number
  roi_percentage?: number | string
  monthly_return_amount?: string | number
  currency?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
  dashboard_url?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function PartnershipTopup({
  partner_name = 'Partner',
  topup_amount = 0,
  previous_portfolio_value = 0,
  new_total_partnership_value = 0,
  roi_percentage,
  monthly_return_amount,
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  dashboard_url = 'https://welileapp.com/auth',
}: PartnershipTopupProps) {
  const year = new Date().getFullYear()
  const formattedTopup = formatAmount(topup_amount, currency)
  const formattedPrevious = formatAmount(previous_portfolio_value, currency)
  const formattedNewTotal = formatAmount(new_total_partnership_value, currency)

  // Resolve real ROI % so top-up email shows the partner's true rate, not 15%.
  const explicitPct = roi_percentage === undefined || roi_percentage === null || roi_percentage === ''
    ? NaN
    : Number(roi_percentage)
  const showRoi = Number.isFinite(explicitPct) && explicitPct > 0
  const roiPctLabel = showRoi ? `${Math.round(explicitPct * 100) / 100}%` : ''
  const newTotalNum = Number(String(new_total_partnership_value).replace(/,/g, '')) || 0
  const monthlyNum = monthly_return_amount === undefined || monthly_return_amount === null || monthly_return_amount === ''
    ? (showRoi && newTotalNum > 0 ? Math.round(newTotalNum * (explicitPct / 100)) : 0)
    : Number(String(monthly_return_amount).replace(/,/g, '')) || 0
  const showMonthly = monthlyNum > 0
  const formattedMonthly = formatAmount(monthlyNum, currency)

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>Partnership Top-Up Received — {formattedTopup}</Preview>
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
                          Top-Up Confirmation
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Partnership Top-Up Received</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={introText}>We hope this email finds you well.</Text>
                    <Text style={{ ...introText, margin: 0 }}>
                      We confirm receipt of your top-up partnership of <strong>{formattedTopup}</strong> with {company_name} Technologies Limited. This contribution has been added to your existing portfolio of <strong>{formattedPrevious}</strong>.
                    </Text>
                    {showRoi ? (
                      <Text style={{ ...introText, margin: '15px 0 0 0' }}>
                        Your agreed monthly return rate of <strong>{roiPctLabel}</strong> now applies to the new total of <strong>{formattedNewTotal}</strong>{showMonthly ? <> — approximately <strong>{formattedMonthly}</strong> per month going forward</> : null}.
                      </Text>
                    ) : null}
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={highlightCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={highlightInner}>
                            <Text style={highlightEyebrow}>New Total Partnership Value</Text>
                            <Text style={highlightValue}>{formattedNewTotal}</Text>
                            <Text style={highlightSub}>Your portfolio has been adjusted accordingly.</Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={outroText}>
                      We appreciate your continued trust in {company_name} Technologies Limited and are committed to delivering consistent value on your partnership journey.
                    </Text>
                    <Text style={{ ...outroText, margin: '25px 0 0 0' }}>
                      Should you require any further clarification or a detailed update on your partnership performance, please do not hesitate to reach out to us at{' '}
                      <Link href="mailto:partnership@welile.com" style={inlineLink}>partnership@welile.com</Link>.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>{company_name} Technologies Limited</span>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ctaCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={ctaInner}>
                            <Text style={ctaEyebrow}>Your Partner Dashboard Awaits</Text>
                            <Heading as="h2" style={ctaHeadline}>Track every shilling, in real time.</Heading>
                            <Text style={ctaSubtext}>
                              Sign in to monitor your portfolio, watch monthly returns accrue, and download your statements — anytime, from anywhere.
                            </Text>
                            <table border={0} cellPadding={0} cellSpacing={0} role="presentation" align="center" style={{ margin: '8px auto 0 auto' }}>
                              <tbody><tr>
                                <td align="center" style={ctaButtonCell}>
                                  <Link
                                    href={dashboard_url}
                                    style={ctaButton}
                                    dangerouslySetInnerHTML={{ __html: 'Access Your Dashboard&nbsp;&rarr;' }}
                                  />
                                </td>
                              </tr></tbody>
                            </table>
                            <Text style={ctaFinePrint}>
                              Or paste this into your browser:{' '}
                              <Link href={dashboard_url} style={ctaFineLink}>{dashboard_url}</Link>
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}>
                      <em>"{company_name} is turning rent into an asset."</em>
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
                    This is an automated notification. Please do not reply directly to this email.
                  </Text>
                  <Text style={{ margin: '0 0 15px 0' }}>
                    <Link href="https://welile.com/company-profile" style={footerLink}>Privacy Policy</Link>
                    <Link href="https://welile.com/company-profile" style={footerLink}>Terms of Service</Link>
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
const ACCENT_BG = '#fcf9ff'
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

const highlightCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const highlightInner: React.CSSProperties = { backgroundColor: ACCENT_BG, padding: '30px 20px' }
const highlightEyebrow: React.CSSProperties = { margin: '0 0 10px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const highlightValue: React.CSSProperties = { margin: '0 0 5px 0', color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-1px' }
const highlightSub: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '13px', fontWeight: 500 }

const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '14px', lineHeight: '24px' }
const inlineLink: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 600 }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 400, color: BODY }

const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: `1px solid #e5e7eb` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }

const ctaCard: React.CSSProperties = {
  borderRadius: '14px',
  overflow: 'hidden',
  backgroundColor: BRAND,
  backgroundImage: `linear-gradient(135deg, #2a0b4d 0%, ${BRAND} 55%, #a855f7 100%)`,
  boxShadow: '0 8px 24px rgba(123, 25, 212, 0.25)',
}
const ctaInner: React.CSSProperties = { padding: '36px 28px' }
const ctaEyebrow: React.CSSProperties = {
  margin: '0 0 8px 0',
  color: '#e9d5ff',
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '2px',
}
const ctaHeadline: React.CSSProperties = {
  margin: '0 0 12px 0',
  color: '#ffffff',
  fontSize: '22px',
  fontWeight: 800,
  lineHeight: '28px',
  letterSpacing: '-0.4px',
}
const ctaSubtext: React.CSSProperties = {
  margin: '0 0 22px 0',
  color: '#f3e8ff',
  fontSize: '14px',
  lineHeight: '22px',
  fontWeight: 400,
}
const ctaButtonCell: React.CSSProperties = {
  borderRadius: '999px',
  backgroundColor: '#ffffff',
}
const ctaButton: React.CSSProperties = {
  display: 'inline-block',
  padding: '14px 32px',
  color: BRAND_DEEP,
  fontSize: '15px',
  fontWeight: 700,
  textDecoration: 'none',
  letterSpacing: '0.2px',
  borderRadius: '999px',
}
const ctaFinePrint: React.CSSProperties = {
  margin: '20px 0 0 0',
  color: '#e9d5ff',
  fontSize: '12px',
  lineHeight: '18px',
}
const ctaFineLink: React.CSSProperties = {
  color: '#ffffff',
  textDecoration: 'underline',
  fontWeight: 600,
  wordBreak: 'break-all',
}

const socialIcon: React.CSSProperties = { display: 'block', opacity: 0.8 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template = {
  component: PartnershipTopup,
  subject: (data: Record<string, any>) => {
    const formatted = formatAmount(data?.topup_amount, data?.currency || 'UGX')
    return `Welile Partnership Top-Up Confirmation — ${formatted}`
  },
  displayName: 'Partnership Top-Up Confirmation',
  previewData: {
    partner_name: 'Sarah Nakato',
    topup_amount: 500_000,
    previous_portfolio_value: 1_000_000,
    new_total_partnership_value: 1_500_000,
    roi_percentage: 12,
    monthly_return_amount: 180_000,
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    dashboard_url: 'https://welileapp.com/auth',
  },
} satisfies TemplateEntry