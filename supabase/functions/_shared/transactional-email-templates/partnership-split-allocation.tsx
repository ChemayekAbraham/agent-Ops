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

/**
 * Partnership Split Allocation Confirmation
 *
 * Sent when COO / Partner Operations splits a maturing (or near-maturity)
 * portfolio payout into a withdrawal portion (cash to wallet / agent wallet /
 * cash) and a compounded portion (reinvested into principal OR kept as
 * earned returns).
 *
 * Template name MUST start with `partnership-` so send-transactional-email's
 * resolveFromAddress() routes this through `partnership@welile.com`.
 */

interface PartnershipSplitAllocationProps {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  total_matured_value?: string | number
  withdrawal_amount?: string | number
  compounded_amount?: string | number
  processing_date?: string
  new_maturity_date?: string
  new_cycle_duration?: string
  currency?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function PartnershipSplitAllocation({
  partner_name = 'Partner',
  portfolio_name = 'Portfolio',
  portfolio_id = '',
  total_matured_value = 0,
  withdrawal_amount = 0,
  compounded_amount = 0,
  processing_date = '',
  new_maturity_date = '',
  new_cycle_duration = '12 months',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: PartnershipSplitAllocationProps) {
  const year = new Date().getFullYear()
  const matured = formatAmount(total_matured_value, currency)
  const withdraw = formatAmount(withdrawal_amount, currency)
  const compounded = formatAmount(compounded_amount, currency)

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>Portfolio Split Allocation Confirmation — {matured}</Preview>
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
                          <Img src={logo_url} alt={company_name} width="130" style={logoImg} />
                        </td>
                        <td align="right" valign="middle" className="hide-mobile" style={secureLabel}>
                          Split Allocation
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Portfolio Split Allocation Confirmation</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={{ ...introText, margin: 0 }}>
                      This is to confirm that your matured portfolio has been processed according to your selected split allocation preference.
                    </Text>
                  </td>
                </tr>

                {/* Portfolio Details Card */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailEyebrow}>Portfolio Detail</Text>
                            <Text style={detailTitle}>
                              {portfolio_name}{' '}
                              {portfolio_id ? <span style={detailRef}>(#{portfolio_id})</span> : null}
                            </Text>
                          </td>
                        </tr>

                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>

                                {/* Row 1: Total Matured & Status */}
                                <tr>
                                  <td width="50%" valign="top" className="td-block mobile-padding-bottom" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Total Matured Value</Text>
                                    <Text style={fieldValue}>{matured}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Status</Text>
                                    <Text style={statusValue}>Split Allocation Processed</Text>
                                  </td>
                                </tr>

                                {/* Row 2: Split amount cards */}
                                <tr>
                                  <td colSpan={2} width="100%" valign="top" style={{ paddingBottom: '20px' }}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                      <tbody>
                                        <tr>
                                          <td width="48%" valign="top" className="td-block mobile-padding-bottom">
                                            <div style={withdrawCard}>
                                              <Text style={withdrawLabel}>Withdrawal Portion</Text>
                                              <Text style={withdrawValue}>{withdraw}</Text>
                                            </div>
                                          </td>
                                          <td width="4%" className="hide-mobile"></td>
                                          <td width="48%" valign="top" className="td-block">
                                            <div style={compoundCard}>
                                              <Text style={compoundLabel}>Compounded Portion</Text>
                                              <Text style={compoundValue}>{compounded}</Text>
                                            </div>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>

                                {/* Row 3: Dates */}
                                <tr>
                                  <td width="50%" valign="top" className="td-block mobile-padding-bottom" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Processing Date</Text>
                                    <Text style={dateValue}>{processing_date}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>New Maturity Date</Text>
                                    <Text style={dateValue}>{new_maturity_date}</Text>
                                  </td>
                                </tr>

                                {/* Row 4 */}
                                <tr>
                                  <td colSpan={2} width="100%" valign="top">
                                    <Text style={fieldLabel}>New Portfolio Cycle</Text>
                                    <Text style={dateValue}>{new_cycle_duration}</Text>
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

                {/* Supporting Message */}
                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 20px 40px' }}>
                    <Text style={{ ...introText, margin: 0 }}>
                      The withdrawal portion has been successfully processed and is now available in your wallet. The compounded portion has been added back into your portfolio for the next investment cycle.
                    </Text>
                  </td>
                </tr>

                {/* Info Notice */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={noticeCard}>
                      <tbody>
                        <tr>
                          <td style={{ padding: '15px 20px' }}>
                            <Text style={noticeTitle}>Notice</Text>
                            <Text style={noticeBody}>
                              You can log in to your dashboard at any time to withdraw the available funds from your wallet to your preferred payment method.
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                {/* Outro */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={{ ...introText, margin: 0 }}>
                      If you require further clarification, please contact support with your portfolio reference{portfolio_id ? <> (#{portfolio_id})</> : null}.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>Partnership Team</span>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}><em>"{company_name} is turning rent into an asset."</em></Text>
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
                    Support Email:{' '}
                    <Link href="mailto:partnership@welile.com" style={{ color: '#a855f7', textDecoration: 'none' }}>partnership@welile.com</Link>
                    <br /><br />
                    You are receiving this email because you are a registered partner at {company_name}.<br />
                    This is an automated notification. Please do not reply directly to this email.
                  </Text>
                  <Text style={{ margin: '0 0 15px 0', textAlign: 'center' as const }}>
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
    .mobile-padding-bottom { padding-bottom: 15px !important; }
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
const detailRef: React.CSSProperties = { color: '#a855f7', fontSize: '15px' }

const fieldLabel: React.CSSProperties = { margin: '0 0 5px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const fieldValue: React.CSSProperties = { margin: 0, color: INK, fontSize: '16px', fontWeight: 700 }
const statusValue: React.CSSProperties = { margin: 0, color: '#0ea5e9', fontSize: '14px', fontWeight: 700 }
const dateValue: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', fontWeight: 600 }

const withdrawCard: React.CSSProperties = { backgroundColor: '#fdf4ff', borderLeft: '3px solid #d946ef', padding: '15px', borderRadius: '6px' }
const withdrawLabel: React.CSSProperties = { margin: '0 0 5px 0', color: '#a21caf', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const withdrawValue: React.CSSProperties = { margin: 0, color: '#701a75', fontSize: '16px', fontWeight: 800 }

const compoundCard: React.CSSProperties = { backgroundColor: '#ecfdf5', borderLeft: '3px solid #10b981', padding: '15px', borderRadius: '6px' }
const compoundLabel: React.CSSProperties = { margin: '0 0 5px 0', color: '#047857', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const compoundValue: React.CSSProperties = { margin: 0, color: '#064e3b', fontSize: '16px', fontWeight: 800 }

const noticeCard: React.CSSProperties = { backgroundColor: '#eff6ff', borderRadius: '8px', borderLeft: '4px solid #3b82f6' }
const noticeTitle: React.CSSProperties = { margin: '0 0 5px 0', color: '#1d4ed8', fontSize: '14px', fontWeight: 600 }
const noticeBody: React.CSSProperties = { margin: 0, color: '#1e3a8a', fontSize: '14px', lineHeight: '20px' }

const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 400, color: BODY }

const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: `1px solid #e5e7eb` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }

const socialIcon: React.CSSProperties = { display: 'block', opacity: 0.8 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template = {
  component: PartnershipSplitAllocation,
  subject: (data: Record<string, any>) => {
    const matured = formatAmount(data?.total_matured_value, data?.currency || 'UGX')
    return `Welile Portfolio Split Allocation Confirmation — ${matured}`
  },
  displayName: 'Partnership Split Allocation Confirmation',
  previewData: {
    partner_name: 'Sarah Nakato',
    portfolio_name: 'WPF-2026-001',
    portfolio_id: 'A1B2C3D4',
    total_matured_value: 1_150_000,
    withdrawal_amount: 75_000,
    compounded_amount: 75_000,
    processing_date: '04 May 2026',
    new_maturity_date: '04 June 2026',
    new_cycle_duration: '12 months',
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
  },
} satisfies TemplateEntry