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

interface AngelPoolSharePurchaseProps {
  partner_name?: string
  pool_name?: string
  share_reference?: string
  shares_purchased?: number | string
  currency?: string
  investment_amount?: number | string
  ownership_percentage?: number | string
  price_per_share?: number | string
  pool_valuation?: number | string
  purchase_date?: string
  total_pool_shares?: number | string
  available_shares?: number | string
  pool_percentage?: number | string
  pool_round?: string
  company_name?: string
  funded_by?: string
  logo_url?: string
  unsubscribe_url?: string
  agreement_url?: string
  dashboard_url?: string
  holding_total_shares?: number | string
  holding_total_invested?: number | string
  holding_pool_percentage?: number | string
  holding_company_percentage?: number | string
  holding_purchase_count?: number | string
  holding_purchases?: { reference?: string; date?: string; shares?: number | string; amount?: number | string }[]
}

const fmtNum = (v: number | string | undefined) => {
  if (v === undefined || v === null || v === '') return '0'
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
  if (Number.isNaN(n)) return String(v)
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export function AngelPoolSharePurchase({
  partner_name = 'Partner',
  pool_name = 'Welile Angel Pool',
  share_reference = 'ANG-XXXXXXXX',
  shares_purchased = 0,
  currency = 'UGX',
  investment_amount = 0,
  ownership_percentage = '0.0000',
  price_per_share = 20000,
  pool_valuation = 500000000,
  purchase_date = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  }),
  total_pool_shares = 25000,
  available_shares = 0,
  pool_percentage = 8,
  pool_round = 'Seed Round',
  company_name = 'Welile',
  funded_by = 'investor',
  logo_url = 'https://wirntoujqoyjobfhyelc.supabase.co/storage/v1/object/public/email-assets/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  agreement_url = 'https://welileapp.com/legal/EARLY_ANGEL_POOL_SHAREHOLDERS_AGREEMENT.pdf',
  dashboard_url = 'https://welileapp.com/auth',
  holding_total_shares,
  holding_total_invested,
  holding_pool_percentage,
  holding_company_percentage,
  holding_purchase_count,
  holding_purchases = [],
}: AngelPoolSharePurchaseProps) {
  const year = new Date().getFullYear()

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        Angel Pool share purchase confirmed — {fmtNum(shares_purchased)} shares ({share_reference})
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
                          <Img src={logo_url} alt={company_name} width="130" style={logoImg} />
                        </td>
                        <td align="right" valign="middle" className="hide-mobile" style={secureLabel}>
                          Share Purchase
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Angel Pool Share Purchase Confirmation</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greeting}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      This is to confirm that your Angel Pool share purchase has been successfully processed.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={detailCard}>
                      <tbody>
                        <tr>
                          <td style={detailHeader}>
                            <Text style={detailHeaderLabel}>Angel Pool Detail</Text>
                            <Text style={detailHeaderValue}>
                              {pool_name} <span style={refBadge}>(Ref: {share_reference})</span>
                            </Text>
                          </td>
                        </tr>

                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td colSpan={2} style={{ paddingBottom: '20px' }}>
                                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                      <tbody>
                                        <tr>
                                          <td valign="top" style={{ paddingBottom: '12px' }}>
                                            <div style={pillBlue}>
                                              <Text style={pillBlueLabel}>Shares Purchased</Text>
                                              <Text style={pillBlueValue}>{fmtNum(shares_purchased)}</Text>
                                            </div>
                                          </td>
                                        </tr>
                                        <tr>
                                          <td valign="top" style={{ paddingBottom: '12px' }}>
                                            <div style={pillGreen}>
                                              <Text style={pillGreenLabel}>Investment Amount</Text>
                                              <Text style={pillGreenValue}>{currency} {fmtNum(investment_amount)}</Text>
                                            </div>
                                          </td>
                                        </tr>
                                        <tr>
                                          <td valign="top">
                                            <div style={pillPurple}>
                                              <Text style={pillPurpleLabel}>Ownership</Text>
                                              <Text style={pillPurpleValue}>{ownership_percentage}%</Text>
                                            </div>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>

                                <tr>
                                  <td width="50%" valign="top" className="td-block mobile-padding-bottom" style={{ paddingBottom: '20px' }}>
                                    <Text style={subKey}>Price Per Share</Text>
                                    <Text style={subVal}>{currency} {fmtNum(price_per_share)}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '20px' }}>
                                    <Text style={subKey}>Pool Valuation</Text>
                                    <Text style={subVal}>{currency} {fmtNum(pool_valuation)}</Text>
                                  </td>
                                </tr>

                                <tr>
                                  <td width="50%" valign="top" className="td-block mobile-padding-bottom">
                                    <Text style={subKey}>Purchase Date</Text>
                                    <Text style={subValMuted}>{purchase_date}</Text>
                                  </td>
                                  <td width="50%" valign="top" className="td-block">
                                    <Text style={subKey}>Status</Text>
                                    <Text style={statusConfirmed}>Confirmed</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td colSpan={2} valign="top" style={{ paddingTop: '15px' }}>
                                    <Text style={subKey}>Funded By</Text>
                                    <Text style={subValMuted}>
                                      {funded_by === 'agent' ? "Agent's Wallet (paid on your behalf)" : "Your Wallet"}
                                    </Text>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    {holding_total_shares !== undefined && (
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={poolSummaryCard}>
                      <tbody><tr>
                        <td style={{ padding: '20px 30px' }}>
                          <Text style={sectionLabel}>Your Total Shareholding</Text>
                          <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                            <tbody>
                              <tr>
                                <td width="50%" valign="top" style={{ paddingBottom: '15px' }}>
                                  <Text style={miniKey}>Total Shares Held</Text>
                                  <Text style={miniVal}>{fmtNum(holding_total_shares)}</Text>
                                </td>
                                <td width="50%" valign="top" style={{ paddingBottom: '15px' }}>
                                  <Text style={miniKey}>Total Invested</Text>
                                  <Text style={miniVal}>{currency} {fmtNum(holding_total_invested)}</Text>
                                </td>
                              </tr>
                              <tr>
                                <td width="50%" valign="top" style={{ paddingBottom: '15px' }}>
                                  <Text style={miniKey}>Share of Welile</Text>
                                  <Text style={miniVal}>{holding_company_percentage}%</Text>
                                </td>
                                <td width="50%" valign="top" style={{ paddingBottom: '15px' }}>
                                  <Text style={miniKey}>Share of Angel Pool</Text>
                                  <Text style={miniVal}>{holding_pool_percentage}%</Text>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                          {holding_purchases.length > 0 && (
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ marginTop: '10px', borderTop: '1px solid #e5e7eb' }}>
                              <tbody>
                                <tr>
                                  <td style={{ padding: '10px 0 6px 0' }}><Text style={miniKey}>Date</Text></td>
                                  <td style={{ padding: '10px 0 6px 0' }}><Text style={miniKey}>Reference</Text></td>
                                  <td align="right" style={{ padding: '10px 0 6px 0' }}><Text style={miniKey}>Shares</Text></td>
                                  <td align="right" style={{ padding: '10px 0 6px 0' }}><Text style={miniKey}>Amount</Text></td>
                                </tr>
                                {holding_purchases.map((p, i) => (
                                  <tr key={i}>
                                    <td style={{ padding: '4px 0' }}><Text style={miniVal}>{p.date}</Text></td>
                                    <td style={{ padding: '4px 0' }}><Text style={miniVal}>{p.reference}</Text></td>
                                    <td align="right" style={{ padding: '4px 0' }}><Text style={miniVal}>{fmtNum(p.shares)}</Text></td>
                                    <td align="right" style={{ padding: '4px 0' }}><Text style={miniVal}>{currency} {fmtNum(p.amount)}</Text></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <Text style={{ ...miniKey, marginTop: '12px', textTransform: 'none' }}>
                            {fmtNum(holding_purchase_count)} confirmed purchase(s) in total.
                          </Text>
                        </td>
                      </tr></tbody>
                    </table>
                    )}

                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={poolSummaryCard}>
                      <tbody><tr>
                        <td style={{ padding: '20px 30px' }}>
                          <Text style={sectionLabel}>Pool Summary</Text>
                          <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                            <tbody>
                              <tr>
                                <td width="50%" valign="top" className="td-block mobile-padding-bottom" style={{ paddingBottom: '15px' }}>
                                  <Text style={miniKey}>Total Pool Shares</Text>
                                  <Text style={miniVal}>{fmtNum(total_pool_shares)}</Text>
                                </td>
                                <td width="50%" valign="top" className="td-block" style={{ paddingBottom: '15px' }}>
                                  <Text style={miniKey}>Available Shares</Text>
                                  <Text style={miniVal}>{fmtNum(available_shares)}</Text>
                                </td>
                              </tr>
                              <tr>
                                <td width="50%" valign="top" className="td-block mobile-padding-bottom">
                                  <Text style={miniKey}>Pool Percentage Rep.</Text>
                                  <Text style={miniVal}>{pool_percentage}%</Text>
                                </td>
                                <td width="50%" valign="top" className="td-block">
                                  <Text style={miniKey}>Current Pool Round</Text>
                                  <Text style={miniVal}>{pool_round}</Text>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 20px 40px' }}>
                    <Text style={bodyText}>
                      Your share allocation has been recorded under the Angel Pool. This confirmation reflects your current shareholding based on the pool valuation and share price at the time of purchase.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ctaCard}>
                      <tbody>
                        <tr>
                          <td style={{ padding: '28px 28px 22px 28px' }} align="center">
                            <Text style={ctaEyebrow}>Next Step · Sign Your Shareholders Agreement</Text>
                            <Text style={ctaTitle}>You're officially an early shareholder.</Text>
                            <Text style={ctaBody}>
                              Download the <strong>Early Angel Pool Shareholders Agreement</strong>, review it carefully, and sign it to formalise your stake in {company_name}.
                            </Text>
                            <table border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ margin: '8px auto 6px auto' }}>
                              <tbody><tr>
                                <td align="center" style={ctaButtonWrap}>
                                  <a href={agreement_url} target="_blank" rel="noopener noreferrer" style={ctaButton}>
                                    ⬇  Download Shareholders Agreement (PDF)
                                  </a>
                                </td>
                              </tr></tbody>
                            </table>
                            <Text style={ctaDivider}>— or —</Text>
                            <Text style={dashboardLinkWrap}>
                              <a href={dashboard_url} target="_blank" rel="noopener noreferrer" style={dashboardLink}>
                                Access Dashboard →
                              </a>
                            </Text>
                            <Text style={ctaFootnote}>
                              Log in to view your live shareholding, valuation projections and share certificate.
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={noticeCard}>
                      <tbody><tr>
                        <td style={{ padding: '15px 20px' }}>
                          <Text style={noticeTitle}>Important Notice</Text>
                          <Text style={noticeBody}>
                            Please retain this confirmation for your records. Any future valuation updates, distributions, or shareholder notices will be communicated through the official system channels.
                          </Text>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={bodyText}>
                      If you require further clarification, please contact support with your share reference ID.
                    </Text>
                    <Text style={signOff}>
                      Warm regards,<br />
                      <span style={signOffSub}>Welile Technologies Limited</span>
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td style={taglineCell}>
                    <i><q style={tagline}>Welile is turning rent into an asset.</q></i>
                  </td>
                </tr>
              </tbody>
            </table>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={{ marginTop: '30px' }}>
              <tbody><tr>
                <td align="center" style={{ padding: '0 20px' }}>
                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ marginBottom: '25px' }}>
                    <tbody><tr>
                      <td style={{ padding: '0 12px' }}><a href="https://x.com/Welile2025"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/twitter.png" alt="Twitter" width="22" style={socialIcon} /></a></td>
                      <td style={{ padding: '0 12px' }}><a href="https://ug.linkedin.com/company/welile"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/linkedin.png" alt="LinkedIn" width="22" style={socialIcon} /></a></td>
                      <td style={{ padding: '0 12px' }}><a href="https://www.facebook.com/profile.php?id=61578974799814"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/facebook-new.png" alt="Facebook" width="22" style={socialIcon} /></a></td>
                      <td style={{ padding: '0 12px' }}><a href="https://www.instagram.com/welile_technologies/"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/instagram-new.png" alt="Instagram" width="22" style={socialIcon} /></a></td>
                    </tr></tbody>
                  </table>
                  <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                  <Text style={{ margin: '0 0 20px 0', fontSize: '13px', textAlign: 'center' as const }}>
                    <Link href="https://maps.app.goo.gl/zfmsP2m2cCXEJXPe9" style={{ color: '#a855f7', textDecoration: 'none' }}>Palm Lane Kabaale, Entebbe</Link>
                  </Text>
                  <Text style={footerDisclaimer}>
                    Automated Angel Pool Notification<br />
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
const greeting: React.CSSProperties = { margin: '0 0 15px 0', color: INK, fontSize: '16px', fontWeight: 600 }
const introText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }
const detailCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const detailHeader: React.CSSProperties = { backgroundColor: '#f8fafc', padding: '25px 30px', borderBottom: `1px solid ${BORDER}` }
const detailHeaderLabel: React.CSSProperties = { margin: '0 0 5px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }
const detailHeaderValue: React.CSSProperties = { margin: 0, color: INK, fontSize: '18px', fontWeight: 700 }
const refBadge: React.CSSProperties = { color: '#a855f7', fontSize: '15px' }
const pillBlue: React.CSSProperties = { backgroundColor: '#eff6ff', borderLeft: '3px solid #3b82f6', padding: '15px', borderRadius: '6px' }
const pillBlueLabel: React.CSSProperties = { margin: '0 0 5px 0', color: '#1d4ed8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }
const pillBlueValue: React.CSSProperties = { margin: 0, color: '#1e3a8a', fontSize: '16px', fontWeight: 800 }
const pillGreen: React.CSSProperties = { backgroundColor: '#ecfdf5', borderLeft: '3px solid #10b981', padding: '15px', borderRadius: '6px' }
const pillGreenLabel: React.CSSProperties = { margin: '0 0 5px 0', color: '#047857', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }
const pillGreenValue: React.CSSProperties = { margin: 0, color: '#064e3b', fontSize: '16px', fontWeight: 800 }
const pillPurple: React.CSSProperties = { backgroundColor: '#fdf4ff', borderLeft: '3px solid #d946ef', padding: '15px', borderRadius: '6px' }
const pillPurpleLabel: React.CSSProperties = { margin: '0 0 5px 0', color: '#a21caf', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }
const pillPurpleValue: React.CSSProperties = { margin: 0, color: '#701a75', fontSize: '16px', fontWeight: 800 }
const subKey: React.CSSProperties = { margin: '0 0 5px 0', color: MUTED, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' }
const subVal: React.CSSProperties = { margin: 0, color: INK, fontSize: '15px', fontWeight: 600 }
const subValMuted: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', fontWeight: 600 }
const statusConfirmed: React.CSSProperties = { margin: 0, color: '#10b981', fontSize: '14px', fontWeight: 700 }
const poolSummaryCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#ffffff', marginTop: '25px' }
const sectionLabel: React.CSSProperties = { margin: '0 0 15px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }
const miniKey: React.CSSProperties = { margin: '0 0 3px 0', color: MUTED, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }
const miniVal: React.CSSProperties = { margin: 0, color: BODY, fontSize: '14px', fontWeight: 600 }
const bodyText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }
const noticeCard: React.CSSProperties = { backgroundColor: '#fef2f2', borderRadius: '8px', borderLeft: '4px solid #ef4444' }
const noticeTitle: React.CSSProperties = { margin: '0 0 5px 0', color: '#b91c1c', fontSize: '14px', fontWeight: 600 }
const noticeBody: React.CSSProperties = { margin: 0, color: '#7f1d1d', fontSize: '14px', lineHeight: '20px' }
const signOff: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signOffSub: React.CSSProperties = { fontWeight: 400, color: BODY }
const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center', borderTop: '1px solid #e5e7eb' }
const tagline: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px', lineHeight: '18px', fontWeight: 500 }
const socialIcon: React.CSSProperties = { display: 'block', opacity: 0.8 }
const footerCompanyName: React.CSSProperties = { margin: '0 0 12px 0', color: MUTED, fontSize: '14px', fontWeight: 700 }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 20px 0', color: MUTED, fontSize: '12px', lineHeight: '18px' }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }
const footerCopyText: React.CSSProperties = { margin: 0, color: '#cbd5e1', fontSize: '12px' }

const ctaCard: React.CSSProperties = {
  backgroundImage: `linear-gradient(135deg, #faf5ff 0%, #ffffff 50%, #f0f9ff 100%)`,
  border: `1px solid ${BORDER}`,
  borderRadius: '14px',
  overflow: 'hidden',
}
const ctaEyebrow: React.CSSProperties = {
  margin: '0 0 8px 0', color: BRAND, fontSize: '11px', fontWeight: 800,
  textTransform: 'uppercase', letterSpacing: '1.4px', textAlign: 'center',
}
const ctaTitle: React.CSSProperties = {
  margin: '0 0 10px 0', color: INK, fontSize: '18px', fontWeight: 800,
  textAlign: 'center', letterSpacing: '-0.3px',
}
const ctaBody: React.CSSProperties = {
  margin: '0 0 18px 0', color: BODY, fontSize: '14px', lineHeight: '22px', textAlign: 'center',
}
const ctaButtonWrap: React.CSSProperties = { borderRadius: '10px' }
const ctaButton: React.CSSProperties = {
  display: 'inline-block',
  backgroundColor: BRAND,
  backgroundImage: `linear-gradient(135deg, ${BRAND} 0%, #a855f7 100%)`,
  color: '#ffffff',
  textDecoration: 'none',
  padding: '14px 28px',
  borderRadius: '10px',
  fontSize: '14px',
  fontWeight: 700,
  letterSpacing: '0.3px',
  boxShadow: '0 6px 18px rgba(123, 25, 212, 0.28)',
}
const ctaDivider: React.CSSProperties = {
  margin: '14px 0 10px 0', color: MUTED, fontSize: '11px',
  fontWeight: 600, letterSpacing: '1px', textAlign: 'center', textTransform: 'uppercase',
}
const dashboardLinkWrap: React.CSSProperties = { margin: '0 0 8px 0', textAlign: 'center' }
const dashboardLink: React.CSSProperties = {
  color: BRAND, fontSize: '14px', fontWeight: 700, textDecoration: 'none',
  borderBottom: `2px solid ${BRAND}`, paddingBottom: '2px',
}
const ctaFootnote: React.CSSProperties = {
  margin: '6px 0 0 0', color: MUTED, fontSize: '12px', textAlign: 'center', fontStyle: 'italic',
}

export const template = {
  component: AngelPoolSharePurchase,
  subject: (data: Record<string, any>) => {
    const shares = data?.shares_purchased ?? 0
    const ref = data?.share_reference ?? ''
    return `Angel Pool share purchase confirmed — ${fmtNum(shares)} shares (${ref})`
  },
  displayName: 'Angel Pool Share Purchase Confirmation',
  previewData: {
    holding_total_shares: 15,
    holding_total_invested: 300000,
    holding_pool_percentage: '0.0600',
    holding_company_percentage: '0.0048',
    holding_purchase_count: 2,
    holding_purchases: [
      { reference: 'ANG-1A2B3C4D', date: '02 Sep 2026', shares: 10, amount: 200000 },
      { reference: 'ANG-5E6F7A8B', date: '29 Sep 2026', shares: 5, amount: 100000 },
    ],
    partner_name: 'Atuhaire Carolyne',
    pool_name: 'Welile Angel Pool',
    share_reference: 'ANG260505A1B2',
    shares_purchased: 10,
    currency: 'UGX',
    investment_amount: 200000,
    ownership_percentage: '0.0032',
    price_per_share: 20000,
    pool_valuation: 500000000,
    purchase_date: '05 May 2026, 14:32',
    total_pool_shares: 25000,
    available_shares: 24990,
    pool_percentage: 8,
    pool_round: 'Seed Round',
    company_name: 'Welile',
  },
} satisfies TemplateEntry