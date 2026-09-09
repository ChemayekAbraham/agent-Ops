import * as React from 'npm:react@18.3.1'
import { Body, Head, Html, Img, Preview } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PartnershipMaturityNoticeProps {
  partner_name?: string
  partnership_reference?: string
  portfolio_id?: string
  partnership_amount?: string | number
  start_date?: string
  maturity_date?: string
  currency?: string
  company_name?: string
  logo_url?: string
  dashboard_url?: string
  renew_url?: string
  redeem_url?: string
  unsubscribe_url?: string
  privacy_url?: string
  terms_url?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const clientOverrides = `
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  table { border-collapse: collapse !important; }
  body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
  a { color: #7b19d4; text-decoration: none; font-weight: 600; }
  a:hover { color: #5a129e; text-decoration: underline; }
  @media screen and (max-width: 600px) {
    .responsive-table { width: 100% !important; max-width: 100% !important; }
    .padding-mobile { padding: 20px 16px !important; }
    .opt-outer { padding: 10px 16px 10px 16px !important; }
    .opt-outer-last { padding: 10px 16px 24px 16px !important; }
    .opt-inner { padding: 22px 18px !important; }
    .circ-col { display: block !important; width: 100% !important; padding-right: 0 !important; padding-bottom: 14px !important; }
    .content-col { display: block !important; width: 100% !important; }
    .ref-col { display: block !important; width: 100% !important; padding-bottom: 10px !important; }
    .badge-col { display: block !important; width: 100% !important; text-align: left !important; }
    .td-block { display: block !important; width: 100% !important; text-align: left !important; }
    .hide-mobile { display: none !important; }
    .mobile-padding-bottom { padding-bottom: 14px !important; }
    .dash-section { padding: 32px 20px !important; }
    .proxy-section { padding: 20px 16px !important; }
    .banner-pad { padding: 0 16px !important; }
  }
`

export function PartnershipMaturityNotice({
  partner_name = 'Partner',
  partnership_reference = '',
  portfolio_id = '',
  partnership_amount = 0,
  start_date = '',
  maturity_date = '',
  currency = 'UGX',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  dashboard_url = 'https://welileapp.com/dashboard/funder',
  renew_url = '',
  redeem_url = '',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  privacy_url = 'https://welile.com/company-profile',
  terms_url = 'https://welile.com/company-profile',
}: PartnershipMaturityNoticeProps) {
  const fmtAmount = formatAmount(partnership_amount, currency)
  const portfolioPath = encodeURIComponent(portfolio_id || '')
  const renewHref = renew_url || `https://welileapp.com/portfolios/${portfolioPath}/renew`
  const redeemHref = redeem_url || `https://welileapp.com/portfolios/${portfolioPath}/redeem`

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>Your Partnership Agreement Is Approaching Maturity</Preview>
      <Body style={{ margin: 0, padding: 0, backgroundColor: '#f4f7f9', fontFamily: FONT_STACK, WebkitFontSmoothing: 'antialiased' }}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ backgroundColor: '#f4f7f9' }}>
          <tbody><tr>
            <td align="center" style={{ padding: '40px 10px' }}>

              <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table"
                style={{ backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 4px 15px rgba(0,0,0,0.05)' }}>
                <tbody>

                  {/* Top Accent Bar */}
                  <tr>
                    <td height={6} style={{ backgroundColor: '#7b19d4', backgroundImage: 'linear-gradient(90deg, #7b19d4 0%, #a855f7 100%)' }}></td>
                  </tr>

                  {/* HEADER */}
                  <tr>
                    <td className="padding-mobile" style={{ padding: '30px 40px', borderBottom: '1px solid #f1f5f9' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                        <tbody><tr>
                          <td align="left" style={{ verticalAlign: "middle" }}>
                            <Img src={logo_url} alt={`${company_name} Technologies Limited`} width="130" style={{ display: 'block', maxWidth: '130px', height: 'auto' }} />
                          </td>
                          <td align="right" className="hide-mobile"
                            style={{ verticalAlign: "middle", fontSize: '11px', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>
                            MATURITY NOTICE
                          </td>
                        </tr></tbody>
                      </table>
                    </td>
                  </tr>

                  {/* ALERT BANNER */}
                  <tr>
                    <td className="banner-pad" style={{ padding: '0 40px', paddingTop: 0 }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"
                        style={{ backgroundImage: 'linear-gradient(135deg, #7b19d4 0%, #9333ea 50%, #a855f7 100%)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
                        <tbody><tr>
                          <td align="center" style={{ padding: '32px 24px' }}>
                            <p style={{ margin: '0 0 10px 0', color: 'rgba(255,255,255,0.75)', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2px' }}>
                              ACTION REQUIRED
                            </p>
                            <h1 style={{ margin: 0, color: '#ffffff', fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: '32px' }}>
                              Your Partnership Agreement<br />Is Approaching Maturity
                            </h1>
                          </td>
                        </tr></tbody>
                      </table>
                    </td>
                  </tr>

                  {/* GREETING */}
                  <tr>
                    <td align="left" className="padding-mobile" style={{ padding: '35px 40px 20px 40px' }}>
                      <p style={{ margin: '0 0 15px 0', color: '#0f172a', fontSize: '16px', fontWeight: 600 }}>Dear {partner_name},</p>
                      <p style={{ margin: 0, color: '#475569', fontSize: '15px', lineHeight: '26px' }}>
                        We are writing to inform you that your partnership agreement with Welile Technologies Limited is
                        approaching its maturity date. As your agreement nears the end of its current term, action may be
                        required on your part before the maturity date to ensure a seamless transition in accordance with
                        the applicable partnership terms and conditions.
                      </p>
                      <p style={{ margin: '15px 0 0 0', color: '#475569', fontSize: '15px', lineHeight: '26px' }}>
                        Please review the details of your partnership below and select your preferred course of action
                        at your earliest convenience.
                      </p>
                    </td>
                  </tr>

                  {/* PARTNERSHIP SUMMARY CARD */}
                  <tr>
                    <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"
                        style={{ backgroundColor: '#faf5ff', borderRadius: '16px', overflow: 'hidden' }}>
                        <tbody>
                          <tr>
                            <td height={5} style={{ backgroundColor: '#7b19d4', backgroundImage: 'linear-gradient(90deg, #7b19d4 0%, #a855f7 100%)' }}></td>
                          </tr>
                          <tr>
                            <td style={{ backgroundColor: '#f5f0fe', padding: '18px 28px 14px 28px' }}>
                              <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                <tbody><tr>
                                  <td style={{ verticalAlign: "middle" }} className="ref-col">
                                    <p style={{ margin: '0 0 3px 0', color: '#7c3aed', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>
                                      Partnership Summary
                                    </p>
                                    <p style={{ margin: 0, color: '#3b0764', fontSize: '16px', fontWeight: 800, letterSpacing: '-0.2px' }}>
                                      {partnership_reference || '—'}
                                    </p>
                                  </td>
                                  <td align="right" style={{ verticalAlign: "middle" }} className="badge-col">
                                    <span style={{ display: 'inline-block', backgroundColor: '#fef9c3', color: '#854d0e', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', padding: '6px 14px', borderRadius: '100px' }}>
                                      Approaching Maturity
                                    </span>
                                  </td>
                                </tr></tbody>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style={{ padding: '20px 28px 24px 28px' }}>
                              <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                <tbody>
                                  <tr>
                                    <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block mobile-padding-bottom" >
                                      <p style={{ margin: '0 0 4px 0', color: '#9333ea', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Portfolio ID</p>
                                      <p style={{ margin: 0, color: '#1e1b4b', fontSize: '15px', fontWeight: 700 }}>{portfolio_id || '—'}</p>
                                    </td>
                                    <td width="50%" style={{ verticalAlign: "top", paddingBottom: '18px' }} className="td-block" >
                                      <p style={{ margin: '0 0 4px 0', color: '#9333ea', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Partnership Amount</p>
                                      <p style={{ margin: 0, color: '#1e1b4b', fontSize: '18px', fontWeight: 800 }}>{fmtAmount}</p>
                                    </td>
                                  </tr>
                                  <tr>
                                    <td width="50%" style={{ verticalAlign: "top", paddingBottom: '6px' }} className="td-block mobile-padding-bottom" >
                                      <p style={{ margin: '0 0 4px 0', color: '#9333ea', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Start Date</p>
                                      <p style={{ margin: 0, color: '#475569', fontSize: '14px', fontWeight: 600 }}>{start_date || '—'}</p>
                                    </td>
                                    <td width="50%" style={{ verticalAlign: "top", paddingBottom: '6px' }} className="td-block" >
                                      <p style={{ margin: '0 0 4px 0', color: '#9333ea', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Maturity Date</p>
                                      <p style={{ margin: 0, color: '#7b19d4', fontSize: '14px', fontWeight: 700 }}>{maturity_date || '—'}</p>
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

                  {/* OPTIONS HEADING */}
                  <tr>
                    <td className="padding-mobile" style={{ backgroundColor: '#ffffff', padding: '30px 40px 10px 40px' }}>
                      <p style={{ margin: '0 0 5px 0', color: '#0f172a', fontSize: '18px', fontWeight: 800, letterSpacing: '-0.3px' }}>Available Options</p>
                      <p style={{ margin: 0, color: '#64748b', fontSize: '14px', lineHeight: '22px' }}>Please select your preferred course of action before the maturity date.</p>
                    </td>
                  </tr>

                  {/* OPTION 1: RENEW */}
                  <tr>
                    <td className="opt-outer" style={{ backgroundColor: '#ffffff', padding: '16px 40px 10px 40px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"
                        style={{ backgroundColor: '#faf5ff', borderRadius: '16px', overflow: 'hidden' }}>
                        <tbody><tr>
                          <td className="opt-inner" style={{ padding: '28px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody><tr style={{ verticalAlign: "top" }}>
                                <td width="62" style={{ verticalAlign: "top", paddingRight: '18px' }} className="circ-col" >
                                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                    <tbody><tr>
                                      <td align="center" 
                                        style={{ verticalAlign: "middle", width: '44px', height: '44px', backgroundColor: '#7b19d4', backgroundImage: 'linear-gradient(135deg, #7b19d4 0%, #a855f7 100%)', borderRadius: '50%' }}>
                                        <span style={{ color: '#ffffff', fontSize: '17px', fontWeight: 800, lineHeight: '44px', display: 'block', width: '44px', textAlign: 'center' }}>1</span>
                                      </td>
                                    </tr></tbody>
                                  </table>
                                </td>
                                <td style={{ verticalAlign: "top" }} className="content-col">
                                  <p style={{ margin: '0 0 2px 0', color: '#7c3aed', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Option 01</p>
                                  <p style={{ margin: '0 0 10px 0', color: '#3b0764', fontSize: '17px', fontWeight: 800 }}>Renew Partnership</p>
                                  <p style={{ margin: '0 0 22px 0', color: '#64748b', fontSize: '14px', lineHeight: '23px' }}>
                                    Continue your partnership with Welile by renewing your agreement for a new term and
                                    continue participating in future opportunities available on the platform.
                                  </p>
                                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                    <tbody><tr>
                                      <td style={{ backgroundColor: '#7b19d4', backgroundImage: 'linear-gradient(135deg, #7b19d4 0%, #9333ea 100%)', borderRadius: '8px' }}>
                                        <a href={renewHref} style={{ display: 'inline-block', padding: '11px 26px', color: '#ffffff', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.4px' }}>
                                          Renew Partnership
                                        </a>
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

                  {/* OPTION 2: REDEEM */}
                  <tr>
                    <td className="opt-outer-last" style={{ backgroundColor: '#ffffff', padding: '10px 40px 30px 40px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"
                        style={{ backgroundColor: '#f0fdf4', borderRadius: '16px', overflow: 'hidden' }}>
                        <tbody><tr>
                          <td className="opt-inner" style={{ padding: '28px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody><tr style={{ verticalAlign: "top" }}>
                                <td width="62" style={{ verticalAlign: "top", paddingRight: '18px' }} className="circ-col" >
                                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                    <tbody><tr>
                                      <td align="center" 
                                        style={{ verticalAlign: "middle", width: '44px', height: '44px', backgroundColor: '#21C45D', backgroundImage: 'linear-gradient(135deg, #16a34a 0%, #21C45D 100%)', borderRadius: '50%' }}>
                                        <span style={{ color: '#ffffff', fontSize: '17px', fontWeight: 800, lineHeight: '44px', display: 'block', width: '44px', textAlign: 'center' }}>2</span>
                                      </td>
                                    </tr></tbody>
                                  </table>
                                </td>
                                <td style={{ verticalAlign: "top" }} className="content-col">
                                  <p style={{ margin: '0 0 2px 0', color: '#16a34a', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Option 02</p>
                                  <p style={{ margin: '0 0 10px 0', color: '#14532d', fontSize: '17px', fontWeight: 800 }}>Redeem Partnership Capital</p>
                                  <p style={{ margin: '0 0 22px 0', color: '#64748b', fontSize: '14px', lineHeight: '23px' }}>
                                    Request the return of your partnership capital at maturity in accordance with the
                                    applicable partnership terms and conditions.
                                  </p>
                                  <table border={0} cellPadding={0} cellSpacing={0} role="presentation">
                                    <tbody><tr>
                                      <td style={{ backgroundColor: '#21C45D', backgroundImage: 'linear-gradient(135deg, #16a34a 0%, #21C45D 100%)', borderRadius: '8px' }}>
                                        <a href={redeemHref} style={{ display: 'inline-block', padding: '11px 26px', color: '#ffffff', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.4px' }}>
                                          Redeem Capital
                                        </a>
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

                  {/* DASHBOARD SECTION */}
                  <tr>
                    <td className="dash-section" style={{ backgroundImage: 'linear-gradient(135deg, #6d28d9 0%, #7b19d4 55%, #9333ea 100%)', padding: '40px 48px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                        <tbody><tr>
                          <td align="center">
                            <p style={{ margin: '0 0 8px 0', color: '#e9d5ff', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2px' }}>Partner Dashboard</p>
                            <p style={{ margin: '0 0 24px 0', color: '#ffffff', fontSize: '16px', fontWeight: 600, lineHeight: '26px' }}>
                              Log in to your dashboard to review your partnership details,
                              monitor performance, and select your preferred option.
                            </p>
                            <table border={0} cellPadding={0} cellSpacing={0} role="presentation" align="center">
                              <tbody><tr>
                                <td style={{ backgroundColor: '#ffffff', borderRadius: '10px' }}>
                                  <a href={dashboard_url} style={{ display: 'inline-block', padding: '14px 40px', color: '#7b19d4', fontSize: '15px', fontWeight: 800, textDecoration: 'none', letterSpacing: '0.3px' }}>
                                    Access Dashboard
                                  </a>
                                </td>
                              </tr></tbody>
                            </table>
                          </td>
                        </tr></tbody>
                      </table>
                    </td>
                  </tr>

                  {/* PROXY AGENT NOTICE */}
                  <tr>
                    <td className="proxy-section" style={{ backgroundColor: '#f8fafc', padding: '22px 48px' }}>
                      <p style={{ margin: '0 0 5px 0', color: '#475569', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.2px' }}>Proxy Agent</p>
                      <p style={{ margin: 0, color: '#64748b', fontSize: '14px', lineHeight: '22px' }}>
                        If your account is currently managed by an authorized proxy agent, you may also coordinate
                        with them regarding your preferred course of action.
                      </p>
                    </td>
                  </tr>

                  {/* CONTACT SECTION */}
                  <tr>
                    <td className="padding-mobile" style={{ padding: '0 40px 35px 40px' }}>
                      <p style={{ margin: '0 0 8px 0', color: '#475569', fontSize: '15px', lineHeight: '26px', paddingTop: '24px' }}>
                        If you have any questions or require further assistance regarding your partnership agreement,
                        please do not hesitate to contact us.
                      </p>
                      <p style={{ margin: 0, color: '#475569', fontSize: '15px' }}>
                        Email:{' '}
                        <a href="mailto:weliletechnologies@gmail.com" style={{ color: '#7b19d4', fontWeight: 600, textDecoration: 'none' }}>
                          weliletechnologies@gmail.com
                        </a>
                      </p>
                    </td>
                  </tr>

                  {/* SIGN-OFF */}
                  <tr>
                    <td className="padding-mobile" style={{ padding: '0 40px 35px 40px' }}>
                      <p style={{ margin: 0, color: '#0f172a', fontSize: '15px', fontWeight: 600 }}>
                        Warm regards,<br />
                        <span style={{ fontWeight: 700, color: '#475569' }}>Partnership Department</span><br />
                        <span style={{ fontWeight: 400, color: '#64748b', fontSize: '14px' }}>Welile Technologies Limited</span>
                      </p>
                    </td>
                  </tr>

                  {/* SLOGAN / INNER FOOTER */}
                  <tr>
                    <td style={{ backgroundColor: '#faf5ff', padding: '18px 40px', textAlign: 'center' }}>
                      <p style={{ margin: 0, color: '#9333ea', fontSize: '12px', fontStyle: 'italic', fontWeight: 500, letterSpacing: '0.3px' }}>
                        "Welile is Turning Rent into an Asset."
                      </p>
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
                          <a href="https://x.com/Welile2025"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/twitter.png" alt="Twitter" width="22" style={{ display: 'block', opacity: 0.8 }} /></a>
                        </td>
                        <td style={{ padding: '0 12px' }}>
                          <a href="https://ug.linkedin.com/company/welile"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/linkedin.png" alt="LinkedIn" width="22" style={{ display: 'block', opacity: 0.8 }} /></a>
                        </td>
                        <td style={{ padding: '0 12px' }}>
                          <a href="https://www.facebook.com/profile.php?id=61578974799814"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/facebook-new.png" alt="Facebook" width="22" style={{ display: 'block', opacity: 0.8 }} /></a>
                        </td>
                        <td style={{ padding: '0 12px' }}>
                          <a href="https://www.instagram.com/welile_technologies/"><Img src="https://img.icons8.com/ios-filled/50/94a3b8/instagram-new.png" alt="Instagram" width="22" style={{ display: 'block', opacity: 0.8 }} /></a>
                        </td>
                      </tr></tbody>
                    </table>

                    <p style={{ margin: '0 0 12px 0', color: '#94a3b8', fontSize: '14px', fontWeight: 700, textTransform: 'uppercase' }}>
                      WELILE TECHNOLOGIES LIMITED</p>

                    <p style={{ margin: '0 0 12px 0', fontSize: '13px' }}>
                      <a href="https://maps.app.goo.gl/zfmsP2m2cCXEJXPe9" style={{ color: '#a855f7', textDecoration: 'none' }}>Palm Lane Kabaale, Entebbe</a>
                    </p>

                    <p style={{ margin: '0 0 20px 0', color: '#94a3b8', fontSize: '12px', lineHeight: '18px' }}>
                      You are receiving this email because you are a registered partner at Welile.<br />
                      This is an automated notification. You may reply directly to this email if you need assistance.
                    </p>

                    <p style={{ margin: '0 0 15px 0' }}>
                      <a href={privacy_url} style={{ color: '#94a3b8', fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }}>Privacy Policy</a>
                      <a href={terms_url} style={{ color: '#94a3b8', fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }}>Terms of Service</a>
                      <a href={unsubscribe_url} style={{ color: '#94a3b8', fontSize: '12px', textDecoration: 'underline', margin: '0 10px' }}>Unsubscribe</a>
                    </p>

                    <p style={{ margin: 0, color: '#cbd5e1', fontSize: '12px' }}>
                      © 2026 Welile Technologies Limited. All rights reserved.
                    </p>

                  </td>
                </tr></tbody>
              </table>

            </td>
          </tr></tbody>
        </table>
      </Body>
    </Html>
  )
}

export const template = {
  component: PartnershipMaturityNotice,
  subject: 'Your Partnership Agreement Is Approaching Maturity',
  displayName: 'Partnership Maturity Notice',
  previewData: {
    partner_name: 'Sarah Nakato',
    partnership_reference: 'WLP-2025-0042',
    portfolio_id: 'PF-A1B2C3D4',
    partnership_amount: 1_500_000,
    start_date: '28 April 2025',
    maturity_date: '28 April 2026',
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    dashboard_url: 'https://welileapp.com/dashboard/funder',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    privacy_url: 'https://welile.com/company-profile',
    terms_url: 'https://welile.com/company-profile',
  },
} satisfies TemplateEntry