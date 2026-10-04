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

interface TenantSummary {
  tenant_name?: string
  tenant_initials?: string
  tenant_location?: string
  monthly_rent?: string | number
  amount_paid?: string | number
  payment_status?: 'paid' | 'partial' | 'unpaid' | string
}

interface PartnerSelfManagedCycleEndedProps {
  partner_name?: string
  portfolio_reference?: string
  portfolio_id?: string
  principal_amount?: string | number
  returns_earned?: string | number
  total_value?: string | number
  cycle_start_date?: string
  cycle_end_date?: string
  next_action_deadline?: string
  monthly_payout?: string | number
  currency?: string
  tenants?: TenantSummary[]
  company_name?: string
  logo_url?: string
  dashboard_url?: string
  renew_url?: string
  withdraw_url?: string
  support_email?: string
  unsubscribe_url?: string
  terms_url?: string
  privacy_url?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const statusColor = (status?: string) => {
  switch (String(status || '').toLowerCase()) {
    case 'paid':
      return { bg: '#dcfce7', text: '#166534' }
    case 'partial':
      return { bg: '#fef9c3', text: '#854d0e' }
    case 'unpaid':
    default:
      return { bg: '#fee2e2', text: '#991b1b' }
  }
}

export function PartnerSelfManagedCycleEnded({
  partner_name = 'Partner',
  portfolio_reference = '',
  portfolio_id = '',
  principal_amount = 0,
  returns_earned = 0,
  total_value = 0,
  cycle_start_date = '',
  cycle_end_date = '',
  next_action_deadline = '',
  monthly_payout = 0,
  currency = 'UGX',
  tenants = [],
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  dashboard_url = 'https://welileapp.com/dashboard/funder',
  renew_url = '',
  withdraw_url = '',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  terms_url = 'https://welile.com/company-profile',
  privacy_url = 'https://welile.com/company-profile',
}: PartnerSelfManagedCycleEndedProps) {
  const year = new Date().getFullYear()
  const fmtPrincipal = formatAmount(principal_amount, currency)
  const fmtReturns = formatAmount(returns_earned, currency)
  const fmtTotal = formatAmount(total_value, currency)
  const fmtMonthly = formatAmount(monthly_payout, currency)
  const displayRef = portfolio_reference || portfolio_id || '—'
  const portfolioPath = encodeURIComponent(portfolio_id || '')
  const renewHref = renew_url || `${dashboard_url}?action=renew&portfolio=${portfolioPath}`
  const withdrawHref = withdraw_url || `${dashboard_url}?action=withdraw&portfolio=${portfolioPath}`
  const paidCount = tenants.filter((t) => String(t.payment_status).toLowerCase() === 'paid').length

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>Your self-managed portfolio cycle has ended — {fmtTotal} available</Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bgTable}>
          <tbody><tr><td align="center" style={{ padding: '40px 10px' }}>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={contentCard}>
              <tbody>
                <tr><td height={6} style={accentBar}></td></tr>

                {/* HEADER */}
                <tr>
                  <td className="padding-mobile" style={headerCell}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="left" style={{ verticalAlign: "middle" }}>
                          <Img src={logo_url} alt={`${company_name} Technologies Limited`} width="130" style={logoImg} />
                        </td>
                        <td align="right" className="hide-mobile" style={{ verticalAlign: "middle", ...secureLabel }}>
                          SELF-MANAGED CYCLE END
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* HERO */}
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 24px 40px' }}>
                    <Heading style={heroH1}>Your Portfolio Cycle Has Ended</Heading>
                    <Text style={heroSub}>Great work managing your portfolio. Here is how the cycle closed.</Text>
                  </td>
                </tr>

                {/* GREETING */}
                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 28px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      Your self-managed portfolio <strong>{displayRef}</strong> has completed its current cycle. 
                      The returns have been calculated and the full value is now available for your next decision.
                    </Text>
                  </td>
                </tr>

                {/* FINANCIAL SUMMARY */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 28px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailEyebrow}>Cycle Summary</Text>
                            <Text style={detailTitle}>{displayRef}</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '24px 28px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Principal Deployed</Text>
                                    <Text style={fieldValue}>{fmtPrincipal}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Returns Earned</Text>
                                    <Text style={{ ...fieldValue, color: '#059669' }}>+{fmtReturns}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Cycle Start</Text>
                                    <Text style={fieldValueSub}>{cycle_start_date || '—'}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Cycle End</Text>
                                    <Text style={fieldValueSub}>{cycle_end_date || '—'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '6px' }} className="td-block" >
                                    <Text style={fieldLabel}>Monthly Payout Equivalent</Text>
                                    <Text style={fieldValueSub}>{fmtMonthly}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '6px' }} className="td-block" >
                                    <Text style={fieldLabel}>Action Deadline</Text>
                                    <Text style={{ ...fieldValueSub, color: '#7b19d4', fontWeight: 700 }}>{next_action_deadline || '—'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="100%" style={{ verticalAlign: "top", paddingTop: '16px', borderTop: '1px solid #e2e8f0' }} colSpan={2} >
                                    <Text style={totalLabel}>Total Available Value</Text>
                                    <Text style={totalValue}>{fmtTotal}</Text>
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

                {/* TENANT SUMMARY */}
                {tenants.length > 0 && (
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 28px 40px' }}>
                    <Text style={sectionTitle}>Tenant Payment Summary</Text>
                    <Text style={sectionSub}>{paidCount} of {tenants.length} tenants paid in full this cycle.</Text>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={tenantCard}>
                      <tbody>
                        {tenants.map((tenant, i) => {
                          const initials = tenant.tenant_initials || (tenant.tenant_name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '—'
                          const colors = statusColor(tenant.payment_status)
                          const isLast = i === tenants.length - 1
                          return (
                            <tr key={i}>
                              <td style={{ ...tenantRow, ...(isLast ? { borderBottom: 'none' } : {}) }}>
                                <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr style={{ verticalAlign: "middle" }}>
                                    <td width="44" style={{ verticalAlign: "middle", paddingRight: '14px' }} >
                                      <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                        <tbody><tr>
                                          <td align="center" style={{ verticalAlign: "middle", ...avatarCell }}>
                                            <span style={avatarText}>{initials}</span>
                                          </td>
                                        </tr></tbody>
                                      </table>
                                    </td>
                                    <td style={{ verticalAlign: "middle", paddingBottom: '8px' }} className="td-block" >
                                      <Text style={tenantName}>{tenant.tenant_name || '—'}</Text>
                                      <Text style={tenantLocation}>{tenant.tenant_location || 'Location not provided'}</Text>
                                    </td>
                                    <td align="right" style={{ verticalAlign: "middle", paddingBottom: '8px' }} className="td-block" >
                                      <Text style={tenantAmount}>{formatAmount(tenant.amount_paid, currency)}</Text>
                                      <span style={{ ...statusBadge, backgroundColor: colors.bg, color: colors.text }}>
                                        {(tenant.payment_status || 'unpaid').toUpperCase()}
                                      </span>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </td>
                </tr>
                )}

                {/* ACTION CARDS */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 12px 40px' }}>
                    <Text style={sectionTitle}>What would you like to do next?</Text>
                  </td>
                </tr>

                {/* OPTION 1: REINVEST */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 14px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={optionCard}>
                      <tbody><tr>
                        <td style={{ padding: '22px 24px' }}>
                          <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                            <tbody><tr style={{ verticalAlign: "top" }}>
                              <td width="44" style={{ verticalAlign: "top", paddingRight: '16px' }} >
                                <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr>
                                    <td align="center" style={{ verticalAlign: "middle", ...optionIcon, backgroundColor: '#7b19d4' }} >
                                      <span style={optionIconText}>1</span>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                              <td style={{ verticalAlign: "top" }}>
                                <Text style={optionTitle}>Reinvest for another cycle</Text>
                                <Text style={optionBody}>
                                  Keep your capital working. Reinvest the principal and returns into a new self-managed cycle.
                                </Text>
                                <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr>
                                    <td style={primaryButtonCell}>
                                      <a href={renewHref} style={primaryButton}>Reinvest Now</a>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                            </tr></tbody>
                          </table>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* OPTION 2: WITHDRAW */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 14px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ ...optionCard, backgroundColor: '#f0fdf4' }}>
                      <tbody><tr>
                        <td style={{ padding: '22px 24px' }}>
                          <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                            <tbody><tr style={{ verticalAlign: "top" }}>
                              <td width="44" style={{ verticalAlign: "top", paddingRight: '16px' }} >
                                <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr>
                                    <td align="center" style={{ verticalAlign: "middle", ...optionIcon, backgroundColor: '#16a34a' }} >
                                      <span style={optionIconText}>2</span>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                              <td style={{ verticalAlign: "top" }}>
                                <Text style={optionTitle}>Withdraw to your wallet</Text>
                                <Text style={optionBody}>
                                  Move the full matured value to your Welile wallet. From there you can cash out or redeploy anytime.
                                </Text>
                                <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr>
                                    <td style={secondaryButtonCell}>
                                      <a href={withdrawHref} style={secondaryButton}>Withdraw {fmtTotal}</a>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                            </tr></tbody>
                          </table>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* OPTION 3: REVIEW */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 32px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ ...optionCard, backgroundColor: '#f8fafc' }}>
                      <tbody><tr>
                        <td style={{ padding: '22px 24px' }}>
                          <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                            <tbody><tr style={{ verticalAlign: "top" }}>
                              <td width="44" style={{ verticalAlign: "top", paddingRight: '16px' }} >
                                <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr>
                                    <td align="center" style={{ verticalAlign: "middle", ...optionIcon, backgroundColor: '#64748b' }} >
                                      <span style={optionIconText}>3</span>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                              <td style={{ verticalAlign: "top" }}>
                                <Text style={optionTitle}>Review in your dashboard</Text>
                                <Text style={optionBody}>
                                  Not ready to decide? Open your dashboard to review the full cycle report, tenant history, and projected returns before choosing.
                                </Text>
                                <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                  <tbody><tr>
                                    <td>
                                      <a href={dashboard_url} style={textLink}>Open Dashboard →</a>
                                    </td>
                                  </tr></tbody>
                                </table>
                              </td>
                            </tr></tbody>
                          </table>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* FOOTER MESSAGE */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 32px 40px' }}>
                    <Text style={outroText}>
                      If you do not select an option before <strong>{next_action_deadline || 'the deadline shown above'}</strong>, 
                      your portfolio may be automatically renewed based on your existing preference. 
                      You can change this preference at any time from your dashboard.
                    </Text>
                    <Text style={{ ...outroText, margin: '20px 0 0 0' }}>
                      Need help? Reply to this email or contact{' '}
                      <Link href={`mailto:${support_email}`} style={inlineLink}>{support_email}</Link>.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>The {company_name} Partnerships Team</span>
                    </Text>
                  </td>
                </tr>

                {/* TAGLINE */}
                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}>
                      <em>"{company_name} is turning rent into an asset."</em>
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* FOOTER */}
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
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you are a registered partner at {company_name}.<br />
                    This is an automated notification, but you can reply directly to this email if you need assistance.
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
const heroH1: React.CSSProperties = { margin: '0 0 12px 0', color: INK, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px' }
const heroSub: React.CSSProperties = { margin: 0, color: SUB, fontSize: '15px', lineHeight: '24px' }
const greetingText: React.CSSProperties = { margin: '0 0 12px 0', color: INK, fontSize: '16px', fontWeight: 600 }
const introText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }

const detailCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const detailHeader: React.CSSProperties = { backgroundColor: '#f8fafc', padding: '22px 28px', borderBottom: `1px solid ${BORDER}` }
const detailEyebrow: React.CSSProperties = { margin: '0 0 5px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }
const detailTitle: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 700 }
const fieldLabel: React.CSSProperties = { margin: '0 0 5px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const fieldValue: React.CSSProperties = { margin: 0, color: INK, fontSize: '16px', fontWeight: 700 }
const fieldValueSub: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', fontWeight: 600 }
const totalLabel: React.CSSProperties = { margin: '0 0 5px 0', color: BRAND, fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }
const totalValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '22px', fontWeight: 800 }

const sectionTitle: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '18px', fontWeight: 800, letterSpacing: '-0.3px' }
const sectionSub: React.CSSProperties = { margin: '0 0 16px 0', color: SUB, fontSize: '14px', lineHeight: '22px' }

const tenantCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#ffffff' }
const tenantRow: React.CSSProperties = { padding: '16px 20px', borderBottom: `1px solid ${HAIRLINE}` }
const avatarCell: React.CSSProperties = { width: '40px', height: '40px', backgroundColor: '#f3e8ff', borderRadius: '50%' }
const avatarText: React.CSSProperties = { color: BRAND, fontSize: '13px', fontWeight: 700, lineHeight: '40px', display: 'block', width: '40px', textAlign: 'center' }
const tenantName: React.CSSProperties = { margin: '0 0 3px 0', color: INK, fontSize: '15px', fontWeight: 700 }
const tenantLocation: React.CSSProperties = { margin: 0, color: SUB, fontSize: '13px', lineHeight: '18px' }
const tenantAmount: React.CSSProperties = { margin: '0 0 4px 0', color: INK, fontSize: '15px', fontWeight: 700, textAlign: 'right' as const }
const statusBadge: React.CSSProperties = { display: 'inline-block', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 10px', borderRadius: '100px' }

const optionCard: React.CSSProperties = { backgroundColor: '#faf5ff', borderRadius: '12px', overflow: 'hidden', border: `1px solid #e9d5ff` }
const optionIcon: React.CSSProperties = { width: '36px', height: '36px', borderRadius: '50%' }
const optionIconText: React.CSSProperties = { color: '#ffffff', fontSize: '15px', fontWeight: 800, lineHeight: '36px', display: 'block', width: '36px', textAlign: 'center' }
const optionTitle: React.CSSProperties = { margin: '0 0 6px 0', color: INK, fontSize: '16px', fontWeight: 800 }
const optionBody: React.CSSProperties = { margin: '0 0 18px 0', color: BODY, fontSize: '14px', lineHeight: '22px' }

const primaryButtonCell: React.CSSProperties = { backgroundColor: BRAND, backgroundImage: `linear-gradient(135deg, ${BRAND} 0%, #9333ea 100%)`, borderRadius: '8px' }
const primaryButton: React.CSSProperties = { display: 'inline-block', padding: '11px 24px', color: '#ffffff', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.4px' }
const secondaryButtonCell: React.CSSProperties = { backgroundColor: '#16a34a', backgroundImage: 'linear-gradient(135deg, #16a34a 0%, #21C45D 100%)', borderRadius: '8px', display: 'inline-block' }
const secondaryButton: React.CSSProperties = { display: 'inline-block', padding: '11px 24px', color: '#ffffff', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.4px' }
const textLink: React.CSSProperties = { color: BRAND, fontSize: '14px', fontWeight: 700, textDecoration: 'none' }
const inlineLink: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 600 }

const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 700, color: BODY }

const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: `1px solid #e5e7eb` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }

const socialIcon: React.CSSProperties = { display: 'block', opacity: 0.8 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const, textTransform: 'uppercase' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template = {
  component: PartnerSelfManagedCycleEnded,
  subject: (data: Record<string, any>) => {
    const currency = data?.currency || 'UGX'
    const total = formatAmount(data?.total_value, currency)
    return `Your self-managed portfolio cycle ended — ${total} available`
  },
  displayName: 'Partner Self-Managed Cycle Ended',
  previewData: {
    partner_name: 'David',
    portfolio_reference: 'WEL-PORT-2026-89421',
    portfolio_id: 'PF-89421',
    principal_amount: 5_000_000,
    returns_earned: 375_000,
    total_value: 5_375_000,
    cycle_start_date: '05 July 2026',
    cycle_end_date: '05 August 2026',
    next_action_deadline: '12 August 2026',
    monthly_payout: 75_000,
    currency: 'UGX',
    tenants: [
      {
        tenant_name: 'Mukasa Gerald',
        tenant_initials: 'MG',
        tenant_location: 'Kampala, Nakawa',
        monthly_rent: 600_000,
        amount_paid: 600_000,
        payment_status: 'paid',
      },
      {
        tenant_name: 'Nakato Sarah',
        tenant_initials: 'NS',
        tenant_location: 'Entebbe, Kitoro',
        monthly_rent: 450_000,
        amount_paid: 450_000,
        payment_status: 'paid',
      },
      {
        tenant_name: 'Okello Peter',
        tenant_initials: 'OP',
        tenant_location: 'Mukono, Seeta',
        monthly_rent: 350_000,
        amount_paid: 0,
        payment_status: 'unpaid',
      },
    ],
    dashboard_url: 'https://welileapp.com/dashboard/funder',
    renew_url: 'https://welileapp.com/dashboard/funder?action=renew&portfolio=PF-89421',
    withdraw_url: 'https://welileapp.com/dashboard/funder?action=withdraw&portfolio=PF-89421',
    support_email: 'partnership@welile.com',
  },
} as TemplateEntry
