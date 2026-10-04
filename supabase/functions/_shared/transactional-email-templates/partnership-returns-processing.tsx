import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PartnershipReturnsProcessingProps {
  partner_name?: string
  transaction_id?: string
  portfolio_code?: string
  amount?: string | number
  currency?: string
  date?: string
  payout_method?: string
  is_managed_by_agent?: boolean
  agent_name?: string
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

export function PartnershipReturnsProcessing({
  partner_name = 'Partner',
  transaction_id = 'TXN-XXXXXXXX',
  portfolio_code = '',
  amount = 0,
  currency = 'UGX',
  date = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }),
  payout_method = 'Wallet',
  is_managed_by_agent = false,
  agent_name = '',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  contact_url = 'https://welile.com/contact',
}: PartnershipReturnsProcessingProps) {
  const year = new Date().getFullYear()
  const formattedAmount = formatAmount(amount, currency)
  const referenceLabel = portfolio_code || transaction_id

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        Your monthly return has been approved and is now being prepared for payout.
      </Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bgTable}>
          <tbody><tr><td align="center" style={{ padding: '40px 10px' }}>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={contentCard}>
              <tbody>
                <tr><td height={6} style={accentBar}></td></tr>

                {/* Header */}
                <tr>
                  <td className="padding-mobile" style={headerCell}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="left" valign="middle">
                          <Img src={logo_url} alt={company_name} width="130" style={logoImg} />
                        </td>
                        <td align="right" valign="middle" className="hide-mobile" style={secureLabel}>
                          Processing Notice
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Hero */}
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <table border={0} cellPadding={0} cellSpacing={0} role="presentation" align="center" style={{ margin: '0 auto 24px auto' }}>
                      <tbody><tr>
                        <td align="center" valign="middle" width={64} height={64} style={iconBadgeCell}>
                          <Text style={badgeText}>⏳</Text>
                        </td>
                      </tr></tbody>
                    </table>
                    <Heading style={heroH1}>Monthly Partnership Return Processing</Heading>
                    <Text style={heroSub}>Dear {partner_name},</Text>
                  </td>
                </tr>

                {/* Intro */}
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={introText}>
                      Your monthly partnership return has been successfully <strong>approved</strong> and is now being processed.
                    </Text>
                    <Text style={{ ...introText, marginTop: '12px' }}>
                      {is_managed_by_agent
                        ? <>Our finance team has authorised your payout and your authorised proxy agent{agent_name ? <> <strong>{agent_name}</strong></> : null} will complete the payout process shortly.</>
                        : <>Our finance team has authorised your payout and it is currently awaiting final cash-out and delivery.</>}
                    </Text>
                  </td>
                </tr>

                {/* Ledger card */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ledgerCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={ledgerAmountHeader}>
                            <Text style={ledgerAmountLabel}>Amount Approved</Text>
                            <Text className="amount-text" style={ledgerAmountValue}>{formattedAmount}</Text>
                            <Text style={pendingBadge}>PROCESSING</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '10px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr><td style={ledgerRow}>
                                  <table width="100%" role="presentation"><tbody><tr>
                                    <td className="td-block" width="40%" style={ledgerKey}>Reference ID</td>
                                    <td className="td-block" width="60%" align="right" style={ledgerValMono}>{referenceLabel}</td>
                                  </tr></tbody></table>
                                </td></tr>
                                <tr><td style={ledgerRow}>
                                  <table width="100%" role="presentation"><tbody><tr>
                                    <td className="td-block" width="40%" style={ledgerKey}>Processing Date</td>
                                    <td className="td-block" width="60%" align="right" style={ledgerVal}>{date}</td>
                                  </tr></tbody></table>
                                </td></tr>
                                <tr><td style={is_managed_by_agent && agent_name ? ledgerRow : ledgerRowLast}>
                                  <table width="100%" role="presentation"><tbody><tr>
                                    <td className="td-block" width="40%" style={ledgerKey}>Payout Method</td>
                                    <td className="td-block" width="60%" align="right" style={ledgerVal}>{payout_method}</td>
                                  </tr></tbody></table>
                                </td></tr>
                                {is_managed_by_agent && agent_name ? (
                                  <tr><td style={ledgerRowLast}>
                                    <table width="100%" role="presentation"><tbody><tr>
                                      <td className="td-block" width="40%" style={ledgerKey}>Managed By</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerVal}>
                                        {agent_name}<br />
                                        <span style={ledgerValSub}>(Proxy Agent)</span>
                                      </td>
                                    </tr></tbody></table>
                                  </td></tr>
                                ) : null}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                {/* What happens next */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={nextCard}>
                      <tbody><tr><td style={{ padding: '20px 24px' }}>
                        <Text style={nextTitle}>What happens next?</Text>
                        <Text style={nextBody}>
                          Your payout will now move to the final disbursement stage.
                          {is_managed_by_agent
                            ? ' Once your authorised proxy agent has successfully completed the payout and the funds have been delivered, you will receive a final confirmation email.'
                            : ' Once the funds have been successfully delivered by our Merchant Agent / Cash-Out process, you will receive a final confirmation email.'}
                        </Text>
                        <Text style={{ ...nextBody, marginTop: '10px', fontStyle: 'italic', color: SUB }}>
                          This message confirms approval only — it is not a proof of payment.
                        </Text>
                      </td></tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Outro */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px', textAlign: 'center' }}>
                    <Text style={outroText}>Thank you for partnering with {company_name}.</Text>
                    <Text style={{ ...outroText, fontStyle: 'italic', marginTop: '8px' }}>
                      &ldquo;Welile is Turning Rent into an Asset.&rdquo;
                    </Text>
                    <table width="100%" role="presentation">
                      <tbody><tr>
                        <td align="center" style={supportCell}>
                          <Text style={supportText}>
                            Questions?{' '}
                            <Link href={contact_url} style={supportLink}>Contact Support</Link>
                          </Text>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Footer */}
            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={{ marginTop: '30px' }}>
              <tbody><tr>
                <td align="center" style={{ padding: '0 20px' }}>
                  <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                  <Text style={{ margin: '0 0 12px 0', fontSize: '12px', textAlign: 'center' as const }}>
                    <Link href="https://www.google.com/maps/search/?api=1&query=Palm+Lane+Kabaale+Entebbe" style={{ color: BRAND, textDecoration: 'none' }}>
                      Palm Lane Kabaale, Entebbe
                    </Link>
                  </Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you are a registered partner at {company_name}.<br />
                    This is an automated notification. Please do not reply directly to this email.
                  </Text>
                  <Text style={{ margin: '0 0 15px 0' }}>
                    <Link href="https://welileapp.com/privacy-policy" style={footerLink}>Privacy Policy</Link>
                    <Link href="https://welileapp.com/partners-terms" style={footerLink}>Terms of Service</Link>
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

const main: React.CSSProperties = { margin: 0, padding: 0, backgroundColor: PAGE_BG, fontFamily: FONT_STACK, WebkitFontSmoothing: 'antialiased' }
const bgTable: React.CSSProperties = { backgroundColor: PAGE_BG }
const contentCard: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 4px 15px rgba(0,0,0,0.05)' }
const accentBar: React.CSSProperties = { backgroundColor: '#f59e0b', backgroundImage: `linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%)` }
const headerCell: React.CSSProperties = { padding: '30px 40px', borderBottom: `1px solid ${HAIRLINE}` }
const logoImg: React.CSSProperties = { display: 'block', maxWidth: '130px', height: 'auto' }
const secureLabel: React.CSSProperties = { fontSize: '11px', color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const iconBadgeCell: React.CSSProperties = { width: '64px', height: '64px', backgroundColor: '#fef3c7', borderRadius: '50%', textAlign: 'center', verticalAlign: 'middle' }
const badgeText: React.CSSProperties = { margin: 0, fontSize: '30px', lineHeight: '64px', textAlign: 'center' }
const heroH1: React.CSSProperties = { margin: '0 0 15px 0', color: INK, fontSize: '26px', fontWeight: 800, letterSpacing: '-0.5px' }
const heroSub: React.CSSProperties = { margin: 0, color: SUB, fontSize: '16px', fontWeight: 500 }
const introText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '16px', lineHeight: '26px' }
const ledgerCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' }
const ledgerAmountHeader: React.CSSProperties = { backgroundColor: ACCENT_BG, padding: '35px 20px', borderBottom: `1px solid ${BORDER}` }
const ledgerAmountLabel: React.CSSProperties = { margin: '0 0 10px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const ledgerAmountValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '40px', fontWeight: 800, letterSpacing: '-1px' }
const pendingBadge: React.CSSProperties = { display: 'inline-block', marginTop: '14px', padding: '6px 14px', backgroundColor: '#fef3c7', color: '#92400e', fontSize: '11px', fontWeight: 800, letterSpacing: '1.5px', borderRadius: '999px' }
const ledgerRow: React.CSSProperties = { padding: '18px 0', borderBottom: `1px dashed ${BORDER}` }
const ledgerRowLast: React.CSSProperties = { padding: '18px 0' }
const ledgerKey: React.CSSProperties = { color: SUB, fontSize: '14px', fontWeight: 600, paddingBottom: '6px' }
const ledgerVal: React.CSSProperties = { color: INK, fontSize: '14px', fontWeight: 600 }
const ledgerValMono: React.CSSProperties = { color: INK, fontSize: '14px', fontWeight: 700, fontFamily: "'Courier New', Courier, monospace", letterSpacing: '0.5px' }
const ledgerValSub: React.CSSProperties = { color: SUB, fontSize: '12px', fontWeight: 500 }
const nextCard: React.CSSProperties = { backgroundColor: '#f8fafc', border: `1px solid ${BORDER}`, borderRadius: '10px' }
const nextTitle: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '15px', fontWeight: 800 }
const nextBody: React.CSSProperties = { margin: 0, color: BODY, fontSize: '14px', lineHeight: '22px' }
const outroText: React.CSSProperties = { margin: '0 0 15px 0', color: BODY, fontSize: '14px', lineHeight: '24px' }
const supportCell: React.CSSProperties = { paddingTop: '15px', borderTop: `1px solid ${HAIRLINE}` }
const supportText: React.CSSProperties = { margin: 0, color: SUB, fontSize: '14px' }
const supportLink: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 700 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700 }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px' }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px' }

export const template = {
  component: PartnershipReturnsProcessing,
  subject: (_data: Record<string, any>) => 'Your Monthly Partnership Return Is Being Processed',
  displayName: 'Partnership Returns — Processing',
  previewData: {
    partner_name: 'Sarah Nakato',
    transaction_id: 'ROI-A8F3D2B4-3',
    portfolio_code: 'WIP2604029404',
    amount: 1_250_000,
    currency: 'UGX',
    date: '20 April 2026',
    payout_method: 'Wallet',
    is_managed_by_agent: true,
    agent_name: 'James Okello',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    contact_url: 'https://welile.com/contact',
  },
} satisfies TemplateEntry