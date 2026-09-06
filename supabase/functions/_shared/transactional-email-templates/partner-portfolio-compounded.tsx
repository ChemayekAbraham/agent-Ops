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
 * Partner Portfolio Compounded — for partners whose portfolio is created as a
 * compounding portfolio from the start.
 *
 * Triggered when:
 *   • A partner creates a new portfolio and selects the compounding ROI mode.
 *
 * For EXISTING partners receiving an auto-cron compound on a live portfolio,
 * use the `partner-compound` template instead.
 */

interface PartnerPortfolioCompoundedProps {
  partner_name?: string
  portfolio_id?: string
  creation_date?: string
  compound_date?: string
  contribution_date?: string
  principal?: string | number
  initial_partnership_amount?: string | number
  roi_return?: string
  roi_percentage?: number | string
  return_amount?: string | number
  new_total_partnership_value?: string | number
  payment_number?: number | string
  duration_months?: number | string
  compound_history?: Array<{
    cycle?: number | string
    month_name?: string
    date?: string
    balance_before?: string | number
    return_amount?: string | number
    balance_after?: string | number
  }>
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

const resolveRoiLabel = (
  roi_percentage: number | string | undefined,
  roi_return: string | undefined,
  principalNum: number,
) => {
  const explicit = roi_percentage === undefined || roi_percentage === null || roi_percentage === ''
    ? NaN
    : Number(roi_percentage)
  if (Number.isFinite(explicit) && explicit > 0) {
    const r = Math.round(explicit * 100) / 100
    return `${r}%`
  }
  if (typeof roi_return === 'string' && roi_return.trim().length > 0) return roi_return
  return '0%'
}

export function PartnerPortfolioCompounded({
  partner_name = 'Partner',
  portfolio_id = 'PF-XXXXXXXX',
  creation_date = '',
  compound_date = '',
  contribution_date = '',
  principal = 0,
  initial_partnership_amount = 0,
  roi_return,
  roi_percentage,
  return_amount = 0,
  new_total_partnership_value = 0,
  payment_number,
  duration_months,
  compound_history,
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  dashboard_url = 'https://welileapp.com/auth',
}: PartnerPortfolioCompoundedProps) {
  const year = new Date().getFullYear()
  // Existing-partner compound event: the portfolio earned a return and was
  // compounded into a new total. Show what was earned this cycle.
  const principalNum = Number(String(initial_partnership_amount).replace(/,/g, ''))
    || Number(String(principal).replace(/,/g, '')) || 0
  const retNum = Number(String(return_amount).replace(/,/g, '')) || 0
  const newTotalNum = Number(String(new_total_partnership_value).replace(/,/g, '')) || (principalNum + retNum)

  // The return for this cycle is earned on the portfolio value AT THE START of
  // the cycle (principal plus every return compounded in earlier cycles) — NOT
  // on the original contribution. Senders historically passed the original
  // contribution as `initial_partnership_amount`, which made the sentence read
  // "your portfolio of 250,000 earned a 20% return (206,400)". Derive the true
  // opening balance from the arithmetic that always holds: new total − return.
  const openingNum = newTotalNum > 0 && retNum > 0 && newTotalNum - retNum > 0
    ? newTotalNum - retNum
    : principalNum
  const showOriginalContribution =
    principalNum > 0 && Math.round(principalNum) !== Math.round(openingNum)

  const formattedInitial = formatAmount(Math.round(principalNum), currency)
  const formattedOpening = formatAmount(Math.round(openingNum), currency)
  const formattedReturn = formatAmount(Math.round(retNum), currency)
  const formattedNewTotal = formatAmount(Math.round(newTotalNum), currency)
  const roiLabel = resolveRoiLabel(roi_percentage, roi_return, openingNum)


  const compoundDateLabel = compound_date || contribution_date || creation_date || 'the date shown above'

  // Forward-looking compounding projection for the REMAINING months of the
  // portfolio — same projection style as the "New Account Compound" email, but
  // anchored to the contribution date (not cycle count) so it stays correct
  // even if a past cycle was skipped or backfilled. The projection starts the
  // month AFTER the compound month and runs through maturity
  // (contribution_date + duration_months), compounding the new total value at
  // the agreed monthly rate.
  const parseFlexibleDate = (raw: string | undefined): Date | null => {
    if (!raw) return null
    const cleaned = String(raw)
      .replace(/(\d+)(st|nd|rd|th)/gi, '$1')
      .replace(/\bof\b/gi, '')
      .replace(/,/g, '')
      .trim()
    const d = new Date(cleaned)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const addMonths = (base: Date, n: number) => {
    const d = new Date(base.getTime())
    d.setMonth(d.getMonth() + n)
    return d
  }
  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const monthsBetween = (a: Date, b: Date) =>
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())

  const ratePct = (() => {
    const explicit = roi_percentage === undefined || roi_percentage === null || roi_percentage === ''
      ? NaN
      : Number(roi_percentage)
    if (Number.isFinite(explicit) && explicit > 0) return explicit
    return principalNum > 0 ? (retNum / principalNum) * 100 : 0
  })()
  const r = ratePct / 100

  const contributionDate = parseFlexibleDate(contribution_date) || parseFlexibleDate(creation_date)
  const compoundDate = parseFlexibleDate(compound_date) || new Date()
  const durationMonths = Number(duration_months) > 0 ? Number(duration_months) : 12

  const timeline = (() => {
    if (!contributionDate || !(newTotalNum > 0) || !(r > 0)) return []
    // First day of the month AFTER the compound month.
    const projectionStart = new Date(compoundDate.getFullYear(), compoundDate.getMonth() + 1, 1)
    // Maturity = contribution date + duration months.
    const maturity = addMonths(contributionDate, durationMonths)
    const remainingMonths = Math.max(0, monthsBetween(projectionStart, maturity))
    const monthsElapsed = Math.max(0, monthsBetween(contributionDate, projectionStart))

    const rows: { cycleLabel: string; before: number; earned: number; after: number; isCurrent: boolean }[] = []
    let bal = newTotalNum
    for (let i = 0; i < remainingMonths; i++) {
      const d = addMonths(projectionStart, i)
      const before = bal
      const earned = Math.round(before * r)
      const after = before + earned
      rows.push({
        cycleLabel: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        before,
        earned,
        after,
        isCurrent: i === 0,
      })
      bal = after
    }
    return rows
  })()

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>Portfolio compounded — new value {formattedNewTotal}</Preview>
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
                          Compounding Confirmation
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Portfolio Successfully Compounded</Heading>
                  </td>
                </tr>

                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={introText}>I hope this message finds you well.</Text>
                    <Text style={introText}>
                      We are pleased to confirm the successful compounding of your portfolio (<span style={portfolioIdAccent}>{portfolio_id}</span>) with {company_name} Technologies Limited.
                    </Text>
                    <Text style={{ ...introText, margin: showOriginalContribution ? undefined : 0 }}>
                      On the <strong>{compoundDateLabel}</strong>, in accordance with your existing agreement, your portfolio value of <strong>{formattedOpening}</strong> earned a {roiLabel} return (<strong>{formattedReturn}</strong>). This brings your new total portfolio value to <strong>{formattedNewTotal}</strong>.
                    </Text>
                    {showOriginalContribution && (
                      <Text style={{ ...introText, margin: 0 }}>
                        Your original contribution was <strong>{formattedInitial}</strong>. The value above includes every return compounded in previous cycles.
                      </Text>
                    )}

                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={highlightCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={returnCardInner}>
                            <Text style={returnEyebrow}>Return Earned ({roiLabel})</Text>
                            <Text style={returnValue}>+{formattedReturn}</Text>
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style={highlightInner}>
                            <Text style={highlightEyebrow}>New Total Partnership Value</Text>
                            <Text style={highlightValue}>{formattedNewTotal}</Text>
                            <Text style={highlightSub}>Your portfolio has been compounded accordingly.</Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                {timeline.length > 0 && (
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <Text style={timelineTitle}>Projected compounding schedule</Text>
                    <Text style={timelineSubtitle}>
                      This is projected from your new portfolio value ({formattedNewTotal}) at the rate of ({roiLabel}) for the remaining months of your portfolio.
                    </Text>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={timelineCard}>
                      <tbody>
                        {timeline.map((row, i) => {
                          const isLast = i === timeline.length - 1
                          return (
                            <tr key={i}>
                              <td width={28} valign="top" style={timelineRailCell}>
                                <div style={{ ...timelineDot, ...(row.isCurrent ? timelineDotCurrent : {}) }} />
                                {!isLast && <div style={timelineLine} />}
                              </td>
                              <td valign="top" style={{ ...timelineRowCell, ...(isLast ? { paddingBottom: 4 } : {}) }}>
                                <Text style={timelineCycleLabel}>
                                  {row.cycleLabel}
                                  {row.isCurrent && <span style={timelineCurrentTag}>&nbsp;· Next</span>}
                                </Text>
                                <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ marginTop: 6 }}>
                                  <tbody>
                                    <tr>
                                      <td style={timelineKvLabel}>Opening balance</td>
                                      <td align="right" style={timelineKvValue}>{formatAmount(row.before, currency)}</td>
                                    </tr>
                                    <tr>
                                      <td style={timelineKvLabel}>Return compounded ({roiLabel})</td>
                                      <td align="right" style={timelineKvEarned}>+{formatAmount(row.earned, currency)}</td>
                                    </tr>
                                    <tr>
                                      <td style={timelineKvLabelStrong}>Balance after compound</td>
                                      <td align="right" style={timelineKvAfter}>{formatAmount(row.after, currency)}</td>
                                    </tr>
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <Text style={timelineFootnote}>Projection assumes the portfolio continues compounding at the same monthly return through maturity. Actual values may vary if you withdraw, top up, or change the portfolio.</Text>
                  </td>
                </tr>
                )}

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={outroText}>
                      We appreciate your continued trust and are excited about the growth ahead. Our team remains committed to supporting your partnership journey with consistent value and transparency.
                    </Text>
                    <Text style={{ ...outroText, margin: '25px 0 0 0' }}>
                      Should you require any further clarification or a detailed update on your partnership performance, please feel free to reach out to us at{' '}
                      <Link href="mailto:info@welile.com" style={inlineLink}>info@welile.com</Link>.
                    </Text>
                    <Text style={{ ...outroText, margin: '25px 0 0 0' }}>
                      Thank you once again for choosing {company_name} Technologies Limited.
                    </Text>
                    <Text style={signatureText}>
                      Warm regards,<br />
                      <span style={signatureSub}>{company_name} Technologies Limited</span>
                    </Text>
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
const ACCENT_BG = '#fcf9ff'
const SUCCESS_BG = '#f0fdf4'
const SUCCESS = '#059669'
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
const heroH1: React.CSSProperties = { margin: '0 0 15px 0', color: INK, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px', textAlign: 'center' as const }
const greetingText: React.CSSProperties = { margin: '0 0 15px 0', color: INK, fontSize: '16px', fontWeight: 600 }
const introText: React.CSSProperties = { margin: '0 0 15px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }

const highlightCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden', backgroundColor: '#fafaf9' }
const highlightInner: React.CSSProperties = { backgroundColor: ACCENT_BG, padding: '30px 20px' }
const highlightEyebrow: React.CSSProperties = { margin: '0 0 10px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const highlightValue: React.CSSProperties = { margin: '0 0 5px 0', color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-1px' }
const highlightSub: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '13px', fontWeight: 500 }
const portfolioIdAccent: React.CSSProperties = { color: '#a855f7' }
const returnCardInner: React.CSSProperties = { backgroundColor: SUCCESS_BG, padding: '30px 20px', borderBottom: `1px solid ${BORDER}` }
const returnEyebrow: React.CSSProperties = { margin: '0 0 10px 0', color: SUCCESS, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const returnValue: React.CSSProperties = { margin: '0 0 5px 0', color: SUCCESS, fontSize: '24px', fontWeight: 700, letterSpacing: '-0.5px' }

const sectionTitle: React.CSSProperties = { margin: '0 0 12px 0', color: INK, fontSize: '18px', fontWeight: 800 }
const sectionBody: React.CSSProperties = { margin: '0 0 15px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const ctaLink: React.CSSProperties = { display: 'inline-block', padding: '14px 28px', color: '#ffffff', fontSize: '16px', fontWeight: 600, textDecoration: 'none', borderRadius: '8px', border: '1px solid #7b19d4' }

const timelineTitle: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '18px', fontWeight: 800 }
const timelineSubtitle: React.CSSProperties = { margin: '0 0 16px 0', color: BODY, fontSize: '14px', lineHeight: '22px' }
const timelineCard: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '12px', backgroundColor: '#ffffff', padding: '18px 18px 6px 18px' }
const timelineRailCell: React.CSSProperties = { padding: '4px 0 0 0' }
const timelineDot: React.CSSProperties = { width: 10, height: 10, borderRadius: 999, backgroundColor: '#cbd5e1', margin: '2px auto 0 auto' }
const timelineDotCurrent: React.CSSProperties = { backgroundColor: BRAND, boxShadow: `0 0 0 4px ${ACCENT_BG}` }
const timelineLine: React.CSSProperties = { width: 2, height: 78, backgroundColor: HAIRLINE, margin: '4px auto 0 auto' }
const timelineRowCell: React.CSSProperties = { padding: '0 0 18px 12px' }
const timelineCycleLabel: React.CSSProperties = { margin: 0, color: INK, fontSize: '14px', fontWeight: 800 }
const timelineCurrentTag: React.CSSProperties = { color: BRAND, fontSize: '12px', fontWeight: 800 }
const timelineDateLabel: React.CSSProperties = { color: MUTED, fontSize: '12px', fontWeight: 600 }
const timelineKvLabel: React.CSSProperties = { padding: '3px 0', color: SUB, fontSize: '12px', lineHeight: '18px' }
const timelineKvValue: React.CSSProperties = { padding: '3px 0', color: BODY, fontSize: '12px', lineHeight: '18px', fontWeight: 600 }
const timelineKvEarned: React.CSSProperties = { padding: '3px 0', color: SUCCESS, fontSize: '12px', lineHeight: '18px', fontWeight: 800 }
const timelineKvLabelStrong: React.CSSProperties = { padding: '6px 0 3px 0', color: INK, fontSize: '12px', lineHeight: '18px', fontWeight: 800, borderTop: `1px solid ${HAIRLINE}` }
const timelineKvAfter: React.CSSProperties = { padding: '6px 0 3px 0', color: BRAND, fontSize: '12px', lineHeight: '18px', fontWeight: 800, borderTop: `1px solid ${HAIRLINE}` }
const timelineFootnote: React.CSSProperties = { margin: '12px 0 0 0', color: MUTED, fontSize: '12px', lineHeight: '18px' }

const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }
const inlineLink: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 600 }
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
  component: PartnerPortfolioCompounded,
  subject: (data: Record<string, any>) => {
    const currency = data?.currency || 'UGX'
    const principalNum = Number(String(data?.principal !== undefined ? data.principal : data?.initial_partnership_amount ?? 0).replace(/,/g, '')) || 0
    const newTotalNum = Number(String(data?.new_total_partnership_value ?? 0).replace(/,/g, '')) || 0
    const headline = newTotalNum > 0 ? newTotalNum : principalNum
    return `Portfolio Compounded — New Value ${formatAmount(headline, currency)}`
  },
  displayName: 'Partner Portfolio Compounded (Existing Partner)',
  previewData: {
    partner_name: 'Sarah Nakato',
    portfolio_id: 'PF-1A2B3C4D',
    creation_date: '20th of April, 2026',
    compound_date: '20th of June, 2026',
    initial_partnership_amount: 5_600_000,
    principal: 5_600_000,
    roi_percentage: 12,
    return_amount: 672_000,
    new_total_partnership_value: 6_272_000,
    payment_number: 2,
    contribution_date: '20 April 2026',
    duration_months: 12,
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    dashboard_url: 'https://welileapp.com/auth',
  },
} satisfies TemplateEntry
