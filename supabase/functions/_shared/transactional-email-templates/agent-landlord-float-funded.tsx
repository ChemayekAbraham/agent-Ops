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

interface AgentLandlordFloatFundedProps {
  agent_name?: string
  landlord_name?: string
  landlord_phone?: string
  tenant_name?: string
  amount?: string | number
  currency?: string
  date?: string
  rent_request_ref?: string
  daily_repayment?: string | number
  duration_days?: string | number
  bonus_amount?: string | number
  withdraw_url?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
  contact_url?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function AgentLandlordFloatFunded({
  agent_name = 'Agent',
  landlord_name = 'the landlord',
  landlord_phone = '',
  tenant_name = '',
  amount = 0,
  currency = 'UGX',
  date = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }),
  rent_request_ref = '',
  daily_repayment,
  duration_days,
  bonus_amount,
  withdraw_url = 'https://welileapp.com/dashboard/agent',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  contact_url = 'https://welile.com/contact',
}: AgentLandlordFloatFundedProps) {
  const year = new Date().getFullYear()
  const formattedAmount = formatAmount(amount, currency)
  const formattedDaily =
    daily_repayment !== undefined && daily_repayment !== null && daily_repayment !== ''
      ? formatAmount(daily_repayment, currency)
      : ''
  const formattedBonus =
    bonus_amount !== undefined && bonus_amount !== null && bonus_amount !== ''
      ? formatAmount(bonus_amount, currency)
      : ''
  const telHref = landlord_phone ? `tel:${landlord_phone.replace(/\s+/g, '')}` : ''

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        {formattedAmount} delivered to your Landlord Float for {landlord_name} — pay & enter OTP
      </Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bgTable}>
          <tbody><tr><td align="center" style={{ padding: '40px 10px' }}>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={contentCard}>
              <tbody>
                <tr>
                  <td height={6} style={accentBar}></td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={headerCell}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="left" valign="middle">
                          <Img src={logo_url} alt={company_name} width="130" style={logoImg} />
                        </td>
                        <td align="right" valign="middle" className="hide-mobile" style={secureLabel}>
                          Landlord Float Notice
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <table border={0} cellPadding={0} cellSpacing={0} role="presentation" align="center" style={{ margin: '0 auto 24px auto' }}>
                      <tbody><tr>
                        <td align="center" valign="middle" width={64} height={64} style={iconBadgeCell}>
                          <Img
                            src="https://wirntoujqoyjobfhyelc.supabase.co/storage/v1/object/public/email-assets/check-mark.png"
                            alt="Funded"
                            width="32"
                            height="32"
                            style={{ display: 'block', margin: '0 auto', border: 0 }}
                          />
                        </td>
                      </tr></tbody>
                    </table>
                    <Heading style={heroH1}>Landlord Float Delivered</Heading>
                    <Text style={heroSub}>Hi {agent_name},</Text>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={introText}>
                      The CFO has just credited your <strong>Landlord Float wallet</strong> with the rent
                      for <strong>{landlord_name}</strong>. The money is sitting in your float and is reserved
                      for this specific landlord — please pay them today and confirm with the OTP from their phone.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ledgerCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={ledgerAmountHeader}>
                            <Text style={ledgerAmountLabel}>Credited to Landlord Float</Text>
                            <Text className="amount-text" style={ledgerAmountValue}>{formattedAmount}</Text>
                          </td>
                        </tr>

                        <tr>
                          <td style={{ padding: '10px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td style={ledgerRow}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                      <td className="td-block" width="40%" style={ledgerKey}>Landlord</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerVal}>{landlord_name}</td>
                                    </tr></tbody></table>
                                  </td>
                                </tr>
                                {landlord_phone ? (
                                  <tr>
                                    <td style={ledgerRow}>
                                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                        <td className="td-block" width="40%" style={ledgerKey}>Landlord Phone</td>
                                        <td className="td-block" width="60%" align="right" style={ledgerValMono}>
                                          {telHref ? <Link href={telHref} style={{ color: INK, textDecoration: 'none' }}>{landlord_phone}</Link> : landlord_phone}
                                        </td>
                                      </tr></tbody></table>
                                    </td>
                                  </tr>
                                ) : null}
                                {tenant_name ? (
                                  <tr>
                                    <td style={ledgerRow}>
                                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                        <td className="td-block" width="40%" style={ledgerKey}>Tenant</td>
                                        <td className="td-block" width="60%" align="right" style={ledgerVal}>{tenant_name}</td>
                                      </tr></tbody></table>
                                    </td>
                                  </tr>
                                ) : null}
                                <tr>
                                  <td style={ledgerRow}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                      <td className="td-block" width="40%" style={ledgerKey}>Destination Wallet</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerVal}>LANDLORD FLOAT</td>
                                    </tr></tbody></table>
                                  </td>
                                </tr>
                                <tr>
                                  <td style={rent_request_ref || formattedDaily ? ledgerRow : ledgerRowLast}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                      <td className="td-block" width="40%" style={ledgerKey}>Date</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerVal}>{date}</td>
                                    </tr></tbody></table>
                                  </td>
                                </tr>
                                {rent_request_ref ? (
                                  <tr>
                                    <td style={formattedDaily ? ledgerRow : ledgerRowLast}>
                                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                        <td className="td-block" width="40%" style={ledgerKey}>Reference</td>
                                        <td className="td-block" width="60%" align="right" style={ledgerValMono}>{rent_request_ref}</td>
                                      </tr></tbody></table>
                                    </td>
                                  </tr>
                                ) : null}
                                {formattedDaily ? (
                                  <tr>
                                    <td style={ledgerRowLast}>
                                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                        <td className="td-block" width="40%" style={ledgerKey}>Tenant Daily Repayment</td>
                                        <td className="td-block" width="60%" align="right" style={ledgerValMono}>
                                          {formattedDaily}{duration_days ? ` · ${duration_days} days` : ''}
                                        </td>
                                      </tr></tbody></table>
                                    </td>
                                  </tr>
                                ) : null}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 10px 40px' }}>
                    <Heading as="h2" style={stepsH2}>What you need to do now</Heading>
                  </td>
                </tr>
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={stepsCard}>
                      <tbody>
                        <tr>
                          <td style={stepRow}>
                            <Text style={stepText}>
                              <span style={stepBadge}>1</span> Go to <strong>{landlord_name}</strong> and pay
                              them <strong>{formattedAmount}</strong> by Mobile Money.
                            </Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={stepRow}>
                            <Text style={stepText}>
                              <span style={stepBadge}>2</span> In the Welile app, open this landlord's row in your
                              <strong> Landlord Float</strong> and tap <strong>Withdraw / Pay Landlord</strong>.
                              Only this landlord's float will be drawn — never any other balance.
                            </Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={stepRowLast}>
                            <Text style={stepText}>
                              <span style={stepBadge}>3</span> Ask the landlord to read the <strong>OTP</strong>
                              sent to <strong>their own phone</strong> ({landlord_phone || 'their registered number'})
                              and type it into the app to confirm the handover.
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table border={0} cellPadding={0} cellSpacing={0} role="presentation" align="center">
                      <tbody><tr>
                        <td align="center" style={ctaCell}>
                          <Link href={withdraw_url} style={ctaButton}>
                            Open Landlord Float &amp; Pay Now
                          </Link>
                        </td>
                      </tr></tbody>
                    </table>
                    <Text style={ctaHint}>
                      The OTP comes from the <strong>landlord's phone</strong>, not yours. This proves the
                      landlord actually received the cash.
                    </Text>
                  </td>
                </tr>

                {formattedBonus ? (
                  <tr>
                    <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bonusCard}>
                        <tbody><tr>
                          <td style={{ padding: '18px 22px' }}>
                            <Text style={bonusText}>
                              You also earned a <strong>{formattedBonus}</strong> rent-funded bonus, already
                              credited to your withdrawable wallet. You'll keep earning <strong>10% commission</strong>
                              on every repayment this tenant makes.
                            </Text>
                          </td>
                        </tr></tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px', textAlign: 'center' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="center" style={supportCell}>
                          <Text style={supportText}>
                            Stuck or the landlord isn't reachable?{' '}
                            <Link href={contact_url} style={supportLink}>Contact Support</Link>
                          </Text>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={{ marginTop: '30px' }}>
              <tbody><tr>
                <td align="center" style={{ padding: '0 20px' }}>
                  <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                  <Text style={{ margin: '0 0 12px 0', fontSize: '12px', textAlign: 'center' as const }}>
                    <Link
                      href="https://www.google.com/maps/search/?api=1&query=Palm+Lane+Kabaale+Entebbe"
                      style={{ color: BRAND, textDecoration: 'none' }}
                    >
                      Palm Lane Kabaale, Entebbe
                    </Link>
                  </Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you are a registered agent at {company_name}.<br />
                    This is an automated notification. Please do not reply directly to this email.
                  </Text>
                  <Text style={{ margin: '0 0 15px 0' }}>
                    <Link href="https://welileapp.com/privacy-policy" style={footerLink}>Privacy Policy</Link>
                    <Link href="https://welileapp.com/partners-terms" style={footerLink}>Terms of Service</Link>
                    <Link href={unsubscribe_url} style={footerLink}>Unsubscribe</Link>
                  </Text>
                  <Text style={footerCopyText}>
                    © {year} {company_name}. All rights reserved.
                  </Text>
                </td>
              </tr></tbody>
            </table>

          </td></tr></tbody>
        </table>
      </Body>
    </Html>
  )
}

/* === Styles === */
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
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol'"

const clientOverrides = `
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  table { border-collapse: collapse !important; }
  body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
  a { color: ${BRAND}; }
  a:hover { color: ${BRAND_DEEP}; }
  @media screen and (max-width: 600px) {
    .responsive-table { width: 100% !important; max-width: 100% !important; }
    .padding-mobile { padding: 25px 20px !important; }
    .td-block { display: block !important; width: 100% !important; text-align: left !important; }
    .hide-mobile { display: none !important; }
    .amount-text { font-size: 32px !important; }
  }
`

const main: React.CSSProperties = {
  margin: 0,
  padding: 0,
  backgroundColor: PAGE_BG,
  fontFamily: FONT_STACK,
  WebkitFontSmoothing: 'antialiased',
}
const bgTable: React.CSSProperties = { backgroundColor: PAGE_BG }
const contentCard: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  overflow: 'hidden',
  boxShadow: '0 4px 15px rgba(0,0,0,0.05)',
}
const accentBar: React.CSSProperties = {
  backgroundColor: BRAND,
  backgroundImage: `linear-gradient(90deg, ${BRAND} 0%, #a855f7 100%)`,
}
const headerCell: React.CSSProperties = {
  padding: '30px 40px',
  borderBottom: `1px solid ${HAIRLINE}`,
}
const logoImg: React.CSSProperties = { display: 'block', maxWidth: '130px', height: 'auto' }
const secureLabel: React.CSSProperties = {
  fontSize: '11px',
  color: MUTED,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '1.5px',
}
const iconBadgeCell: React.CSSProperties = {
  width: '64px',
  height: '64px',
  backgroundColor: '#f3e8fc',
  borderRadius: '50%',
  textAlign: 'center',
  verticalAlign: 'middle',
}
const heroH1: React.CSSProperties = {
  margin: '0 0 15px 0',
  color: INK,
  fontSize: '26px',
  fontWeight: 800,
  letterSpacing: '-0.5px',
}
const heroSub: React.CSSProperties = { margin: 0, color: SUB, fontSize: '16px', fontWeight: 500 }
const introText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '16px', lineHeight: '26px' }
const ledgerCard: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: '12px',
  overflow: 'hidden',
}
const ledgerAmountHeader: React.CSSProperties = {
  backgroundColor: ACCENT_BG,
  padding: '35px 20px',
  borderBottom: `1px solid ${BORDER}`,
}
const ledgerAmountLabel: React.CSSProperties = {
  margin: '0 0 10px 0',
  color: SUB,
  fontSize: '12px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '1.5px',
}
const ledgerAmountValue: React.CSSProperties = {
  margin: 0,
  color: BRAND,
  fontSize: '40px',
  fontWeight: 800,
  letterSpacing: '-1px',
}
const ledgerRow: React.CSSProperties = { padding: '18px 0', borderBottom: `1px dashed ${BORDER}` }
const ledgerRowLast: React.CSSProperties = { padding: '18px 0' }
const ledgerKey: React.CSSProperties = { color: SUB, fontSize: '14px', fontWeight: 600, paddingBottom: '6px' }
const ledgerVal: React.CSSProperties = { color: INK, fontSize: '14px', fontWeight: 600 }
const ledgerValMono: React.CSSProperties = {
  color: INK,
  fontSize: '14px',
  fontWeight: 700,
  fontFamily: "'Courier New', Courier, monospace",
  letterSpacing: '0.5px',
}
const stepsH2: React.CSSProperties = {
  margin: '0 0 4px 0',
  color: INK,
  fontSize: '17px',
  fontWeight: 800,
  letterSpacing: '-0.3px',
}
const stepsCard: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: '12px',
  backgroundColor: '#ffffff',
  overflow: 'hidden',
}
const stepRow: React.CSSProperties = { padding: '16px 20px', borderBottom: `1px solid ${HAIRLINE}` }
const stepRowLast: React.CSSProperties = { padding: '16px 20px' }
const stepText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '14px', lineHeight: '22px' }
const stepBadge: React.CSSProperties = {
  display: 'inline-block',
  minWidth: '22px',
  height: '22px',
  lineHeight: '22px',
  textAlign: 'center',
  borderRadius: '50%',
  backgroundColor: BRAND,
  color: '#ffffff',
  fontWeight: 800,
  fontSize: '12px',
  marginRight: '8px',
  padding: '0 6px',
}
const ctaCell: React.CSSProperties = { borderRadius: '10px' }
const ctaButton: React.CSSProperties = {
  display: 'inline-block',
  backgroundColor: BRAND,
  backgroundImage: `linear-gradient(90deg, ${BRAND} 0%, #a855f7 100%)`,
  color: '#ffffff',
  fontWeight: 800,
  fontSize: '15px',
  padding: '14px 28px',
  borderRadius: '10px',
  textDecoration: 'none',
  letterSpacing: '0.3px',
}
const ctaHint: React.CSSProperties = {
  margin: '14px 0 0 0',
  color: SUB,
  fontSize: '12px',
  lineHeight: '18px',
}
const bonusCard: React.CSSProperties = {
  backgroundColor: '#fef9c3',
  border: '1px solid #fde68a',
  borderRadius: '10px',
}
const bonusText: React.CSSProperties = {
  margin: 0,
  color: '#713f12',
  fontSize: '13px',
  lineHeight: '20px',
}
const supportCell: React.CSSProperties = { paddingTop: '15px', borderTop: `1px solid ${HAIRLINE}` }
const supportText: React.CSSProperties = { margin: 0, color: SUB, fontSize: '14px' }
const supportLink: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 700 }
const footerCompanyName: React.CSSProperties = {
  margin: '0 0 12px 0',
  color: MUTED,
  fontSize: '14px',
  fontWeight: 700,
}
const footerDisclaimer: React.CSSProperties = {
  margin: '0 0 20px 0',
  color: MUTED,
  fontSize: '12px',
  lineHeight: '18px',
}
const footerLink: React.CSSProperties = {
  color: MUTED,
  fontSize: '12px',
  textDecoration: 'underline',
  margin: '0 10px',
}
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px' }

export const template = {
  component: AgentLandlordFloatFunded,
  subject: (data: Record<string, any>) => {
    const amt = formatAmount(data?.amount, data?.currency || 'UGX')
    const ll = data?.landlord_name || 'landlord'
    return `${amt} in your Landlord Float — pay ${ll} now`
  },
  displayName: 'Agent · Landlord Float Funded',
  previewData: {
    agent_name: 'James Okello',
    landlord_name: 'Mr. Mukasa',
    landlord_phone: '+256 772 123 456',
    tenant_name: 'Sarah Nakato',
    amount: 850000,
    currency: 'UGX',
    date: '27 May 2026',
    rent_request_ref: 'RR-9C7E2A41',
    daily_repayment: 12000,
    duration_days: 90,
    bonus_amount: 5000,
    withdraw_url: 'https://welileapp.com/dashboard/agent',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    contact_url: 'https://welile.com/contact',
  },
} satisfies TemplateEntry