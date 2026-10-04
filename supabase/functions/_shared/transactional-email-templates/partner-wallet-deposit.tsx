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

interface PartnerWalletDepositProps {
  partner_name?: string
  transaction_id?: string
  amount?: string | number
  currency?: string
  date?: string
  wallet_id_last4?: string
  source?: string
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

export function PartnerWalletDeposit({
  partner_name = 'Partner',
  transaction_id = 'TXN-XXXXXXXX',
  amount = 0,
  currency = 'UGX',
  date = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }),
  wallet_id_last4 = '',
  source = 'Platform',
  company_name = 'Welile',
  logo_url = 'https://wirntoujqoyjobfhyelc.supabase.co/storage/v1/object/public/email-assets/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  contact_url = 'https://welile.com/contact',
}: PartnerWalletDepositProps) {
  const year = new Date().getFullYear()
  const formattedAmount = formatAmount(amount, currency)
  const walletMask = wallet_id_last4 ? `•••• ${wallet_id_last4}` : ''

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        Wallet deposit of {formattedAmount} received — Reference {transaction_id}
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
                          Secure Notification
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
                            alt="Success"
                            width="32"
                            height="32"
                            style={{ display: 'block', margin: '0 auto', border: 0 }}
                          />
                        </td>
                      </tr></tbody>
                    </table>
                    <Heading style={heroH1}>Wallet Deposit Successful</Heading>
                    <Text style={heroSub}>Dear {partner_name},</Text>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 35px 40px' }}>
                    <Text style={introText}>
                      Great news! The funds have successfully credited to your wallet and are now available for use.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ledgerCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={ledgerAmountHeader}>
                            <Text style={ledgerAmountLabel}>Amount Received</Text>
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
                                      <td className="td-block" width="40%" style={ledgerKey}>Reference ID</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerValMono}>{transaction_id}</td>
                                    </tr></tbody></table>
                                  </td>
                                </tr>
                                <tr>
                                  <td style={ledgerRow}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                      <td className="td-block" width="40%" style={ledgerKey}>Processing Date</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerVal}>{date}</td>
                                    </tr></tbody></table>
                                  </td>
                                </tr>
                                <tr>
                                  <td style={source ? ledgerRow : ledgerRowLast}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                      <td className="td-block" width="40%" style={ledgerKey}>Destination</td>
                                      <td className="td-block" width="60%" align="right" style={ledgerVal}>
                                        WALLET
                                        {walletMask ? (
                                          <>
                                            <br />
                                            <span style={ledgerValSub}>{walletMask}</span>
                                          </>
                                        ) : null}
                                      </td>
                                    </tr></tbody></table>
                                  </td>
                                </tr>
                                {source ? (
                                  <tr>
                                    <td style={ledgerRowLast}>
                                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                        <td className="td-block" width="40%" style={ledgerKey}>Source</td>
                                        <td className="td-block" width="60%" align="right" style={ledgerVal}>{source}</td>
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
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px', textAlign: 'center' }}>
                    <Text style={outroText}>
                      You can now log in to your account to view your updated wallet balance and transaction history.
                    </Text>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="center" style={{ padding: '8px 0 20px 0' }}>
                          <a href="https://welileapp.com/ZQhyGb" style={dashboardBtn}>
                            Access your dashboard
                          </a>
                        </td>
                      </tr></tbody>
                    </table>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="center" style={supportCell}>
                          <Text style={supportText}>
                            Have questions?{' '}
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
                  <Text style={{ margin: '0 0 12px 0', fontSize: '12px', textAlign: 'center' as const }}>
                    <Link
                      href="https://www.google.com/maps/search/?api=1&query=Palm+Lane+Kabaale+Entebbe"
                      style={{ color: BRAND, textDecoration: 'none' }}
                    >
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

const logoImg: React.CSSProperties = {
  display: 'block',
  maxWidth: '130px',
  height: 'auto',
}

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

const heroSub: React.CSSProperties = {
  margin: 0,
  color: SUB,
  fontSize: '16px',
  fontWeight: 500,
}

const introText: React.CSSProperties = {
  margin: 0,
  color: BODY,
  fontSize: '16px',
  lineHeight: '26px',
}

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

const ledgerRow: React.CSSProperties = {
  padding: '18px 0',
  borderBottom: `1px dashed ${BORDER}`,
}

const ledgerRowLast: React.CSSProperties = {
  padding: '18px 0',
}

const ledgerKey: React.CSSProperties = {
  color: SUB,
  fontSize: '14px',
  fontWeight: 600,
  paddingBottom: '6px',
}

const ledgerVal: React.CSSProperties = {
  color: INK,
  fontSize: '14px',
  fontWeight: 600,
}

const ledgerValMono: React.CSSProperties = {
  color: INK,
  fontSize: '14px',
  fontWeight: 700,
  fontFamily: "'Courier New', Courier, monospace",
  letterSpacing: '0.5px',
}

const ledgerValSub: React.CSSProperties = {
  color: SUB,
  fontSize: '12px',
  fontWeight: 500,
}

const outroText: React.CSSProperties = {
  margin: '0 0 15px 0',
  color: BODY,
  fontSize: '14px',
  lineHeight: '24px',
}

const dashboardBtn: React.CSSProperties = {
  backgroundColor: BRAND,
  color: '#ffffff',
  padding: '14px 28px',
  borderRadius: '10px',
  fontSize: '15px',
  fontWeight: 700,
  textDecoration: 'none',
  display: 'inline-block',
}

const supportCell: React.CSSProperties = {
  paddingTop: '15px',
  borderTop: `1px solid ${HAIRLINE}`,
}

const supportText: React.CSSProperties = {
  margin: 0,
  color: SUB,
  fontSize: '14px',
}

const supportLink: React.CSSProperties = {
  color: BRAND,
  textDecoration: 'none',
  fontWeight: 700,
}

const socialIcon: React.CSSProperties = {
  display: 'block',
  opacity: 0.8,
}

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

const footerCopyText: React.CSSProperties = {
  margin: 0,
  color: '#cbd5e1',
  fontSize: '12px',
}

export const template = {
  component: PartnerWalletDeposit,
  subject: (data: Record<string, any>) => {
    const formatted = formatAmount(data?.amount, data?.currency || 'UGX')
    return `Wallet deposit of ${formatted} received`
  },
  displayName: 'Partner Wallet Deposit',
  previewData: {
    partner_name: 'Sarah Nakato',
    transaction_id: 'PAY-MO8DYAFP-COT6',
    amount: 251857,
    currency: 'UGX',
    date: '21 Apr 2026, 11:52',
    wallet_id_last4: '4521',
    source: 'Platform',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    contact_url: 'https://welile.com/contact',
  },
} satisfies TemplateEntry