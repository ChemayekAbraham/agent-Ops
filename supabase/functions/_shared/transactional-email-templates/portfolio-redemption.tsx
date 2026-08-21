import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PortfolioRedemptionProps {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  scope?: 'full' | 'partial' | string
  redeemed_amount?: string | number
  previous_principal?: string | number
  remaining_principal?: string | number
  return_rate?: string
  maturity_date?: string
  next_payout_date?: string
  processed_date?: string
  settlement_window_days?: string | number
  expected_payout_by?: string
  currency?: string
  company_name?: string
  logo_url?: string
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

export function PortfolioRedemption({
  partner_name = 'Partner',
  portfolio_name = 'Partnership Portfolio',
  portfolio_id = '',
  scope = 'partial',
  redeemed_amount = 0,
  previous_principal = 0,
  remaining_principal = 0,
  return_rate = '15%',
  maturity_date = '',
  next_payout_date = '',
  processed_date = '',
  settlement_window_days = 90,
  expected_payout_by = '',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  terms_url = 'https://welileapp.com/partners-terms',
  privacy_url = 'https://welileapp.com/privacy',
}: PortfolioRedemptionProps) {
  const year = new Date().getFullYear()
  const isFull = scope === 'full'
  const fmtRedeemed = formatAmount(redeemed_amount, currency)
  const fmtPrevious = formatAmount(previous_principal, currency)
  const fmtRemaining = formatAmount(remaining_principal, currency)
  const displayId = portfolio_id || ''
  const windowDays = Number(settlement_window_days) > 0 ? Number(settlement_window_days) : 90

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        {isFull
          ? `Capital Redemption Confirmation — ${fmtRedeemed} released in full`
          : `Partial Capital Redemption — ${fmtRedeemed} released, ${fmtRemaining} stays invested`}
      </Preview>
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
                          CAPITAL REDEMPTION
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>
                      {isFull ? 'Capital Redemption Confirmation' : 'Partial Capital Redemption Confirmation'}
                    </Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={{ ...introText, margin: 0 }}>
                      {isFull
                        ? `We confirm that your capital redemption request has been processed in full. The entire principal of ${fmtPrevious} has been released for payout and this portfolio has now been closed.`
                        : `We confirm that your capital redemption request has been processed. ${fmtRedeemed} has been released for payout from your portfolio principal of ${fmtPrevious}. The balance of ${fmtRemaining} remains invested and continues to earn returns under your existing partnership terms.`}
                    </Text>
                    <Text style={{ ...introText, margin: '15px 0 0 0' }}>
                      Please note: paying out your capital takes up to {windowDays} days (about 3 months) from
                      today. This is normal and it is part of your partnership terms.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={noticeCard}>
                      <tbody>
                        <tr>
                          <td style={{ padding: '18px 22px' }}>
                            <Text style={noticeTitle}>When will I get my money? Up to {windowDays} days</Text>
                            <Text style={noticeBody}>
                              Your money is working inside real rent plans with tenants, so it cannot be pulled out
                              on the same day. We need time to collect it back safely without hurting the tenants
                              or the other partners. That is why capital redemptions take up to {windowDays} days,
                              which is roughly 3 months.
                            </Text>
                            <Text style={{ ...noticeBody, margin: '10px 0 0 0' }}>
                              What this means for you in simple terms:
                            </Text>
                            <Text style={{ ...noticeBody, margin: '6px 0 0 0' }}>
                              • Your redemption of {fmtRedeemed} is now approved and locked in — the amount will not change.<br />
                              • The cash is released to your registered payout channel within {windowDays} days from {processed_date || 'today'}
                              {expected_payout_by ? `, and on or before ${expected_payout_by}` : ''}.<br />
                              • It can come sooner. If it does, we will send you the money and inform you.<br />
                              • You do not need to do anything or ask again while you wait. We will keep you updated.
                              {!isFull ? <><br />• The {fmtRemaining} still invested keeps earning your returns as normal during this period.</> : null}
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailEyebrow}>Portfolio Detail</Text>
                            <Text style={detailTitle}>
                              {portfolio_name} {displayId && <span style={{ color: '#a855f7', fontSize: '15px' }}>(#{displayId})</span>}
                            </Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Principal Before Redemption</Text>
                                    <Text style={fieldValue}>{fmtPrevious}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Amount Redeemed</Text>
                                    <Text style={{ ...fieldValue, color: '#b45309' }}>{fmtRedeemed}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Redemption Type</Text>
                                    <Text style={fieldValueSub}>{isFull ? 'Full redemption' : 'Partial redemption'}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={fieldLabel}>Processed On</Text>
                                    <Text style={fieldValueSub}>{processed_date || '—'}</Text>
                                  </td>
                                </tr>
                                {!isFull && (
                                  <tr>
                                    <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                      <Text style={fieldLabel}>Return Rate</Text>
                                      <Text style={fieldValueSub}>{return_rate || '—'}</Text>
                                    </td>
                                    <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                      <Text style={fieldLabel}>Next Returns Payout</Text>
                                      <Text style={fieldValueSub}>{next_payout_date || '—'}</Text>
                                    </td>
                                  </tr>
                                )}
                                <tr>
                                  <td colSpan={2} style={{ paddingTop: '5px', borderTop: '1px solid #e2e8f0' }}>
                                    <Text style={totalLabel}>
                                      {isFull ? 'Principal Remaining After Redemption' : 'Principal That Stays Invested'}
                                    </Text>
                                    <Text style={totalValue}>{fmtRemaining}</Text>
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
                            <Text style={insightTitle}>{isFull ? 'What happens next' : 'Your portfolio going forward'}</Text>
                            <Text style={insightBody}>
                              {isFull
                                ? `Your redeemed capital will be settled through your registered payout channel within the ${windowDays}-day window. Once the money has been sent, this portfolio will show as closed on your dashboard.`
                                : `From today, your portfolio principal is recorded as ${fmtRemaining}${maturity_date ? `, running to its maturity date of ${maturity_date}` : ''}. All future returns are calculated on this new principal.`}
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
                      If any figure above does not match your expectation, please contact the Partnership Team with your portfolio reference {displayId && <span>(#{displayId})</span>} before the settlement is completed.
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
                      <em>"Welile is turning rent into an asset."</em>
                    </Text>
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
const BODY_C = '#475569'
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
const introText: React.CSSProperties = { margin: '0 0 15px 0', color: BODY_C, fontSize: '15px', lineHeight: '24px' }

const detailCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const detailHeader: React.CSSProperties = { backgroundColor: '#f8fafc', padding: '25px 30px', borderBottom: `1px solid ${BORDER}` }
const detailEyebrow: React.CSSProperties = { margin: '0 0 5px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }
const detailTitle: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 700 }
const fieldLabel: React.CSSProperties = { margin: '0 0 5px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const fieldValue: React.CSSProperties = { margin: 0, color: INK, fontSize: '16px', fontWeight: 700 }
const fieldValueSub: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '15px', fontWeight: 600 }
const totalLabel: React.CSSProperties = { margin: '15px 0 5px 0', color: BRAND, fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }
const totalValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '22px', fontWeight: 800 }

const insightCard: React.CSSProperties = { backgroundColor: '#f0fdfa', borderRadius: '8px', borderLeft: '4px solid #14b8a6' }
const noticeCard: React.CSSProperties = { backgroundColor: '#fffbeb', borderRadius: '8px', borderLeft: '4px solid #f59e0b' }
const noticeTitle: React.CSSProperties = { margin: '0 0 8px 0', color: '#92400e', fontSize: '15px', fontWeight: 700 }
const noticeBody: React.CSSProperties = { margin: 0, color: '#78350f', fontSize: '14px', lineHeight: '21px' }
const insightTitle: React.CSSProperties = { margin: '0 0 5px 0', color: '#0f766e', fontSize: '14px', fontWeight: 600 }
const insightBody: React.CSSProperties = { margin: 0, color: '#0f766e', fontSize: '14px', lineHeight: '20px' }

const outroText: React.CSSProperties = { margin: 0, color: BODY_C, fontSize: '15px', lineHeight: '24px' }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 700, color: BODY_C }

const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: '1px solid #e5e7eb' }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }

const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700, textAlign: 'center' as const, textTransform: 'uppercase' as const }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px', textAlign: 'center' as const }

export const template = {
  component: PortfolioRedemption,
  subject: (data: Record<string, any>) => {
    const cur = data?.currency || 'UGX'
    const redeemed = formatAmount(data?.redeemed_amount, cur)
    const remaining = formatAmount(data?.remaining_principal, cur)
    return data?.scope === 'full'
      ? `Capital Redemption Confirmation — ${redeemed} released in full`
      : `Partial Capital Redemption — ${redeemed} released, ${remaining} stays invested`
  },
  displayName: 'Portfolio Capital Redemption',
  previewData: {
    partner_name: 'Sarah Nakato',
    portfolio_name: 'Welile Growth Partnership',
    portfolio_id: 'WPF-1234',
    scope: 'partial',
    redeemed_amount: 1_000_000,
    previous_principal: 2_000_000,
    remaining_principal: 1_000_000,
    return_rate: '15%',
    maturity_date: '28 April 2027',
    next_payout_date: '15 September 2026',
    processed_date: '19 August 2026',
    settlement_window_days: 90,
    expected_payout_by: '17 November 2026',
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    terms_url: 'https://welileapp.com/partners-terms',
    privacy_url: 'https://welileapp.com/privacy',
  },
} satisfies TemplateEntry
