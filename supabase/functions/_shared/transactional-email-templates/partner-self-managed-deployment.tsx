import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface TenantLine {
  tenant_name?: string
  tenant_location?: string
  tenant_photo_url?: string
  principal?: string | number
  monthly_rent?: string | number
}

interface PartnerSelfManagedDeploymentProps {
  partner_name?: string
  portfolio_reference?: string
  principal_amount?: string | number
  monthly_return_amount?: string | number
  roi_percentage?: number
  term_months?: number
  deployment_date?: string
  first_payout_date?: string
  tenants_count?: number
  tenants?: TenantLine[]
  currency?: string
  company_name?: string
  logo_url?: string
  dashboard_url?: string
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

export function PartnerSelfManagedDeployment({
  partner_name = 'Partner',
  portfolio_reference = '',
  principal_amount = 0,
  monthly_return_amount = 0,
  roi_percentage = 15,
  term_months = 1,
  deployment_date = '',
  first_payout_date = '',
  tenants_count = 0,
  tenants = [],
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  dashboard_url = 'https://welileapp.com/dashboard/funder',
  support_email = 'partnership@welile.com',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  terms_url = 'https://welile.com/company-profile',
  privacy_url = 'https://welile.com/company-profile',
}: PartnerSelfManagedDeploymentProps) {
  const year = new Date().getFullYear()
  const fmtPrincipal = formatAmount(principal_amount, currency)
  const fmtMonthly = formatAmount(monthly_return_amount, currency)
  const displayRef = portfolio_reference || '—'
  const count = tenants_count || tenants.length

  return (
    <Html>
      <Head><style>{clientOverrides}</style></Head>
      <Preview>Your self-managed capital of {fmtPrincipal} is now deployed</Preview>
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
                        <td align="left" style={{ verticalAlign: "middle" }}>
                          <Img src={logo_url} alt={`${company_name} Technologies Limited`} width="130" style={logoImg} />
                        </td>
                        <td align="right" className="hide-mobile" style={{ verticalAlign: "middle", ...secureLabel }}>
                          SELF-MANAGED DEPLOYMENT
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 24px 40px' }}>
                    <Heading style={heroH1}>Your Capital Is Deployed</Heading>
                    <Text style={heroSub}>
                      Partner Operations has approved your self-managed portfolio. Your capital is now working
                      {count > 0 ? ` across ${count} tenant${count === 1 ? '' : 's'} you selected yourself.` : '.'}
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 28px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      You chose to support tenants directly, so you decided exactly where your money went.
                      Portfolio <strong>{displayRef}</strong> is now live and your returns begin accruing daily
                      from the deployment date below.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 28px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailEyebrow}>Deployment Summary</Text>
                            <Text style={detailTitle}>{displayRef}</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '24px 28px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Capital Deployed</Text>
                                    <Text style={fieldValue}>{fmtPrincipal}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Monthly Return</Text>
                                    <Text style={{ ...fieldValue, color: '#059669' }}>+{fmtMonthly}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Agreed Rate</Text>
                                    <Text style={fieldValueSub}>{roi_percentage}% per month</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                    <Text style={fieldLabel}>Term</Text>
                                    <Text style={fieldValueSub}>{term_months} month{term_months === 1 ? '' : 's'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '6px' }} className="td-block" >
                                    <Text style={fieldLabel}>Deployment Date</Text>
                                    <Text style={fieldValueSub}>{deployment_date || '—'}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '6px' }} className="td-block" >
                                    <Text style={fieldLabel}>First Payout</Text>
                                    <Text style={{ ...fieldValueSub, color: '#7b19d4', fontWeight: 700 }}>{first_payout_date || '—'}</Text>
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

                {tenants.length > 0 && (
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 28px 40px' }}>
                    <Text style={sectionTitle}>Tenants you are supporting</Text>
                    <Text style={sectionSub}>These are the rent plans your capital was allocated to.</Text>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={tenantCard}>
                      <tbody>
                        {tenants.map((t, i) => {
                          const initials = (t.tenant_name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '—'
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
                                            {t.tenant_photo_url
                                              ? (
                                                <Img
                                                  src={t.tenant_photo_url}
                                                  alt={t.tenant_name || 'Tenant'}
                                                  width="40"
                                                  height="40"
                                                  style={avatarImg}
                                                />
                                              )
                                              : <span style={avatarText}>{initials}</span>}
                                          </td>
                                        </tr></tbody>
                                      </table>
                                    </td>
                                    <td style={{ verticalAlign: "middle", paddingBottom: '8px' }} className="td-block" >
                                      <Text style={tenantName}>{t.tenant_name || 'Tenant'}</Text>
                                      <Text style={tenantLocation}>{t.tenant_location || 'Location not provided'}</Text>
                                    </td>
                                    <td align="right" style={{ verticalAlign: "middle", paddingBottom: '8px' }} className="td-block" >
                                      <Text style={tenantAmount}>{formatAmount(t.principal, currency)}</Text>
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

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 32px 40px' }}>
                    <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td style={primaryButtonCell}>
                          <a href={dashboard_url} style={primaryButton}>Open My Portfolio</a>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 32px 40px' }}>
                    <Text style={outroText}>
                      Because this portfolio is self-managed, you keep full visibility of every tenant you funded.
                      Welile handles collection and record-keeping, and returns are credited to your wallet on the
                      payout date shown above.
                    </Text>
                    <Text style={{ ...outroText, margin: '20px 0 0 0' }}>
                      Questions? Reply to this email or contact{' '}
                      <Link href={`mailto:${support_email}`} style={inlineLink}>{support_email}</Link>.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>The {company_name} Partnerships Team</span>
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
                  <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you are a registered partner at {company_name}.<br />
                    You can reply directly to this email if you need assistance.
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
const sectionTitle: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '18px', fontWeight: 800, letterSpacing: '-0.3px' }
const sectionSub: React.CSSProperties = { margin: '0 0 16px 0', color: SUB, fontSize: '14px', lineHeight: '22px' }
const tenantCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#ffffff' }
const tenantRow: React.CSSProperties = { padding: '16px 20px', borderBottom: `1px solid ${HAIRLINE}` }
const avatarCell: React.CSSProperties = { width: '40px', height: '40px', backgroundColor: '#f3e8ff', borderRadius: '50%' }
const avatarText: React.CSSProperties = { color: BRAND, fontSize: '13px', fontWeight: 700, lineHeight: '40px', display: 'block', width: '40px', textAlign: 'center' as const }
const avatarImg: React.CSSProperties = { width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', display: 'block' }
const tenantName: React.CSSProperties = { margin: '0 0 2px 0', color: INK, fontSize: '15px', fontWeight: 700 }
const tenantLocation: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '13px' }
const tenantAmount: React.CSSProperties = { margin: '0 0 4px 0', color: INK, fontSize: '15px', fontWeight: 700 }
const primaryButtonCell: React.CSSProperties = { borderRadius: '8px', backgroundColor: BRAND }
const primaryButton: React.CSSProperties = { display: 'inline-block', padding: '14px 28px', color: '#ffffff', fontSize: '15px', fontWeight: 700, textDecoration: 'none', borderRadius: '8px' }
const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '14px', lineHeight: '22px' }
const inlineLink: React.CSSProperties = { color: BRAND, fontWeight: 600, textDecoration: 'none' }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 400, color: BODY }
const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center' as const, borderTop: `1px solid ${BORDER}` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template: TemplateEntry = {
  component: PartnerSelfManagedDeployment,
  displayName: 'Self-Managed Capital Deployment Confirmation',
  subject: (data: Record<string, any>) => {
    const currency = data?.currency || 'UGX'
    const amt = Number(String(data?.principal_amount ?? 0).replace(/,/g, '')) || 0
    return `Capital Deployed — ${currency} ${amt.toLocaleString('en-US', { maximumFractionDigits: 0 })} now supporting your tenants`
  },
  previewData: {
    partner_name: 'SSENKAALI PIUS',
    portfolio_reference: 'WSP-5668',
    principal_amount: 500000,
    monthly_return_amount: 75000,
    roi_percentage: 15,
    term_months: 1,
    deployment_date: '13 August 2026',
    first_payout_date: '12 September 2026',
    tenants_count: 1,
    tenants: [
      { tenant_name: 'Alice Babirye', tenant_location: 'Kabaale, Entebbe', principal: 500000 },
    ],
    currency: 'UGX',
  },
}
