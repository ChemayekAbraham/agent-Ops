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

interface PartnershipAgreementProps {
  partner_name?: string
  partnership_amount?: string | number
  contribution_date?: string
  monthly_return_amount?: string | number
  total_projected_return?: string | number
  first_payment_date?: string
  roi_payment_day?: number | string
  roi_percentage?: number | string
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

const ordinalSuffix = (day: number): string => {
  if (day >= 11 && day <= 13) return 'th'
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

export function PartnershipAgreement({
  partner_name = 'Partner',
  partnership_amount = 0,
  contribution_date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  monthly_return_amount = 0,
  total_projected_return = 0,
  first_payment_date = '',
  roi_payment_day = 1,
  roi_percentage,
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://wirntoujqoyjobfhyelc.supabase.co/storage/v1/object/public/email-assets/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  dashboard_url = 'https://welileapp.com/auth',
}: PartnershipAgreementProps) {
  const year = new Date().getFullYear()
  const formattedAmount = formatAmount(partnership_amount, currency)
  const formattedMonthly = formatAmount(monthly_return_amount, currency)
  const formattedTotal = formatAmount(total_projected_return, currency)
  const dayNum = typeof roi_payment_day === 'number' ? roi_payment_day : Number(roi_payment_day) || 1
  const daySuffix = ordinalSuffix(dayNum)

  // Resolve the actual agreed monthly ROI %. Prefer the explicitly passed
  // value (sourced from investor_portfolios.roi_percentage); otherwise derive
  // from the agreed monthly return / principal so the email NEVER
  // hardcodes 15% for partners on different rates.
  const principalNum = Number(String(partnership_amount).replace(/,/g, '')) || 0
  const monthlyNum = Number(String(monthly_return_amount).replace(/,/g, '')) || 0
  const explicitPct = roi_percentage === undefined || roi_percentage === null || roi_percentage === ''
    ? NaN
    : Number(roi_percentage)
  const derivedPct = principalNum > 0 ? (monthlyNum / principalNum) * 100 : 0
  const resolvedPct = Number.isFinite(explicitPct) && explicitPct > 0 ? explicitPct : derivedPct
  const roundedPct = Math.round(resolvedPct * 100) / 100
  const roiPctLabel = `${roundedPct}%`

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>Tenant Partnership Confirmation — {formattedAmount} contribution</Preview>
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
                          Agreement Terms
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Tenant Partnership Confirmation</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      This communication formalizes the partnership terms and agreement between you and Welile Technologies Limited. We deeply value your commitment to our mission.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ledgerCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={ledgerAmountHeader}>
                            <Text style={ledgerAmountLabel}>Partnership Amount</Text>
                            <Text style={ledgerAmountValue}>{formattedAmount}</Text>
                            <Text style={ledgerSubLabel}>Contributed on {contribution_date}</Text>
                          </td>
                        </tr>

                        <tr>
                          <td style={{ padding: '10px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td style={ledgerRow}>
                                    <Text style={sectionLabel}>Purpose of Partnership</Text>
                                    <Text style={sectionBody}>
                                      Supporting Welile Technologies Limited in helping tenants pay rent conveniently.
                                    </Text>
                                  </td>
                                </tr>

                                <tr>
                                  <td style={ledgerRow}>
                                    <Text style={{ ...sectionLabel, marginBottom: '10px' }}>Return on Partnership</Text>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                      <tbody>
                                        <tr>
                                          <td width="50%" style={kvKey}>Agreed Monthly Return</td>
                                          <td width="50%" align="right" style={kvVal}>{roiPctLabel}</td>
                                        </tr>
                                        <tr>
                                          <td width="50%" style={kvKey}>Monthly Return Amount</td>
                                          <td width="50%" align="right" style={kvVal}>{formattedMonthly}</td>
                                        </tr>
                                        <tr>
                                          <td width="50%" style={kvKey}>Duration</td>
                                          <td width="50%" align="right" style={kvVal}>12 Months</td>
                                        </tr>
                                        <tr>
                                          <td width="50%" style={kvKeyLast}>Total Projected Return</td>
                                          <td width="50%" align="right" style={kvValAccent}>{formattedTotal}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>

                                <tr>
                                  <td style={ledgerRow}>
                                    <Text style={{ ...sectionLabel, marginBottom: '10px' }}>Payment Schedule</Text>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                      <tbody>
                                        <tr>
                                          <td width="50%" style={kvKey}>First Payment Date</td>
                                          <td width="50%" align="right" style={kvVal}>{first_payment_date}</td>
                                        </tr>
                                        <tr>
                                          <td width="50%" style={kvKeyLast}>Subsequent Payments</td>
                                          <td width="50%" align="right" style={kvValLast}>
                                            {dayNum}<sup>{daySuffix}</sup> of each month
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>

                                <tr>
                                  <td style={ledgerRowLast}>
                                    <Text style={sectionLabel}>Withdrawal Terms</Text>
                                    <Text style={withdrawalText}>
                                      Should you wish to exit the partnership before the completion of the 12-month term, a 90-day written notice must be submitted to{' '}
                                      <Link href="mailto:partnership@welile.com" style={inlineLink}>partnership@welile.com</Link>
                                      . Early withdrawal terms and conditions will be communicated upon request.
                                    </Text>
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
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={governingBox}>
                      <tbody><tr><td style={{ padding: '15px 20px' }}>
                        <Text style={governingText}>
                          <strong>Governing Terms:</strong> By proceeding or confirming, you acknowledge and accept the terms outlined in this agreement.
                        </Text>
                      </td></tr></tbody>
                    </table>

                    <Text style={contactText}>
                      For any questions or further clarification, please contact us directly at{' '}
                      <Link href="mailto:partnership@welile.com" style={inlineLink}>partnership@welile.com</Link>.
                    </Text>

                    <Text style={signatureText}>
                      Best regards,<br />
                      <span style={signatureSub}>Partnership Department</span><br />
                      <span style={signatureSub}>Welile Technologies Limited</span>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}>
                      <em>"Welile is turning rent into an asset."</em>
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
const introText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }

const ledgerCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const ledgerAmountHeader: React.CSSProperties = { backgroundColor: ACCENT_BG, padding: '30px 20px', borderBottom: `1px solid ${BORDER}` }
const ledgerAmountLabel: React.CSSProperties = { margin: '0 0 10px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const ledgerAmountValue: React.CSSProperties = { margin: '0 0 5px 0', color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-1px' }
const ledgerSubLabel: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '13px', fontWeight: 500 }

const ledgerRow: React.CSSProperties = { padding: '15px 0', borderBottom: `1px dashed ${BORDER}` }
const ledgerRowLast: React.CSSProperties = { padding: '15px 0' }

const sectionLabel: React.CSSProperties = { margin: '0 0 5px 0', color: SUB, fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }
const sectionBody: React.CSSProperties = { margin: 0, color: INK, fontSize: '14px', fontWeight: 500, lineHeight: '20px' }

const kvKey: React.CSSProperties = { paddingBottom: '8px', color: BODY, fontSize: '14px' }
const kvVal: React.CSSProperties = { paddingBottom: '8px', color: INK, fontSize: '14px', fontWeight: 600 }
const kvKeyLast: React.CSSProperties = { color: BODY, fontSize: '14px' }
const kvValLast: React.CSSProperties = { color: INK, fontSize: '14px', fontWeight: 600 }
const kvValAccent: React.CSSProperties = { color: BRAND, fontSize: '14px', fontWeight: 700 }

const withdrawalText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '13px', lineHeight: '20px' }
const inlineLink: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 600 }

const governingBox: React.CSSProperties = { backgroundColor: HAIRLINE, borderLeft: `4px solid ${BRAND}`, borderRadius: '4px' }
const governingText: React.CSSProperties = { margin: 0, color: '#334155', fontSize: '13px', lineHeight: '20px', fontWeight: 500 }
const contactText: React.CSSProperties = { margin: '25px 0 0 0', color: BODY, fontSize: '14px', lineHeight: '24px' }
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
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700 }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px' }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px' }

export const template = {
  component: PartnershipAgreement,
  subject: 'Tenant Partnership Confirmation — Welile Technologies',
  displayName: 'Tenant Partnership Confirmation',
  previewData: {
    partner_name: 'Sarah Nakato',
    partnership_amount: 1000000,
    contribution_date: '21 April 2026',
    monthly_return_amount: 150000,
    total_projected_return: 1800000,
    first_payment_date: '21 May 2026',
    roi_payment_day: 21,
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    dashboard_url: 'https://welileapp.com/auth',
  },
} satisfies TemplateEntry
