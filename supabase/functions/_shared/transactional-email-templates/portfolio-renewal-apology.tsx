import * as React from 'npm:react@18.3.1'
import {
  Body, Head, Heading, Html, Img, Link, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  original_maturity_date?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
  terms_url?: string
  privacy_url?: string
}

export function PortfolioRenewalApology({
  partner_name = 'Partner',
  portfolio_name = 'Partnership Portfolio',
  portfolio_id = '',
  original_maturity_date = '',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  terms_url = 'https://welileapp.com/partners-terms',
  privacy_url = 'https://welileapp.com/privacy',
}: Props) {
  const year = new Date().getFullYear()
  const displayId = portfolio_id || ''
  return (
    <Html>
      <Head><style>{clientOverrides}</style></Head>
      <Preview>A quick apology about your portfolio</Preview>
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
                          A Note From Welile
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>We're sorry for the mix-up</Heading>
                  </td>
                </tr>
                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greetingText}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      Earlier today your portfolio {portfolio_name}{displayId && <span> (#{displayId})</span>} was renewed by mistake on our side.
                    </Text>
                    <Text style={introText}>
                      We have put everything back the way it was. Your maturity date of <strong>{original_maturity_date || '—'}</strong> still stands, and the choice to renew, top up, or withdraw when the time comes is still fully yours.
                    </Text>
                    <Text style={introText}>
                      Your money is safe, your returns are unchanged, and there is nothing you need to do.
                    </Text>
                  </td>
                </tr>
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={insightCard}>
                      <tbody><tr><td style={{ padding: '15px 20px' }}>
                        <Text style={insightTitle}>In short</Text>
                        <Text style={insightBody}>
                          Your portfolio was renewed by mistake. We noticed right away and put it back. Nothing on your side has changed.
                        </Text>
                      </td></tr></tbody>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={outroText}>
                      Thank you for trusting Welile. We're sorry for any confusion. If you have any questions, just reply to this email or write to <Link href="mailto:partnership@welile.com">partnership@welile.com</Link>.
                    </Text>
                    <Text style={signatureText}>
                      With sincere apologies,<br />
                      <span style={signatureSub}>Welile Partnership Team</span>
                    </Text>
                  </td>
                </tr>
                <tr>
                  <td style={taglineCell}>
                    <Text style={taglineText}><em>"Automated Notification System • Welile is turning rent into an asset."</em></Text>
                  </td>
                </tr>
              </tbody>
            </table>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={{ marginTop: '30px' }}>
              <tbody><tr><td align="center" style={{ padding: '0 20px' }}>
                <Text style={footerCompanyName}>WELILE TECHNOLOGIES LTD</Text>
                <Text style={{ margin: '0 0 20px 0', fontSize: '13px', textAlign: 'center' as const }}>
                  <Link href="https://maps.app.goo.gl/zfmsP2m2cCXEJXPe9" style={{ color: '#a855f7', textDecoration: 'none' }}>
                    Palm Lane Kabaale, Entebbe
                  </Link>
                </Text>
                <Text style={footerDisclaimer}>
                  You are receiving this email because you are a registered partner at {company_name}.
                </Text>
                <Text style={{ margin: '0 0 15px 0', textAlign: 'center' as const }}>
                  <Link href={privacy_url} style={footerLink}>Privacy Policy</Link>
                  <Link href={terms_url} style={footerLink}>Terms of Service</Link>
                  <Link href={unsubscribe_url} style={footerLink}>Unsubscribe</Link>
                </Text>
                <Text style={footerCopyText}>© {year} {company_name}. All rights reserved.</Text>
              </td></tr></tbody>
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
const MUTED = '#94a3b8'
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
const introText: React.CSSProperties = { margin: '0 0 15px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const insightCard: React.CSSProperties = { backgroundColor: '#fff7ed', borderRadius: '8px', borderLeft: '4px solid #f59e0b' }
const insightTitle: React.CSSProperties = { margin: '0 0 5px 0', color: '#9a3412', fontSize: '14px', fontWeight: 700 }
const insightBody: React.CSSProperties = { margin: 0, color: '#9a3412', fontSize: '14px', lineHeight: '20px' }
const outroText: React.CSSProperties = { margin: 0, color: BODY, fontSize: '15px', lineHeight: '24px' }
const signatureText: React.CSSProperties = { margin: '25px 0 0 0', color: INK, fontSize: '15px', fontWeight: 600 }
const signatureSub: React.CSSProperties = { fontWeight: 700, color: BODY }
const taglineCell: React.CSSProperties = { padding: '20px 40px', textAlign: 'center' as const, borderTop: `1px solid #e5e7eb` }
const taglineText: React.CSSProperties = { margin: 0, color: MUTED, fontSize: '12px' }
const footerCompanyName: React.CSSProperties = { margin: '0 0 10px 0', fontSize: '13px', fontWeight: 700, color: INK, textAlign: 'center' as const, letterSpacing: '1px' }
const footerDisclaimer: React.CSSProperties = { margin: '0 0 15px 0', fontSize: '12px', color: MUTED, textAlign: 'center' as const, lineHeight: '18px' }
const footerLink: React.CSSProperties = { color: MUTED, fontSize: '12px', margin: '0 8px', textDecoration: 'none' }
const footerCopyText: React.CSSProperties = { margin: 0, fontSize: '11px', color: MUTED, textAlign: 'center' as const }

export const template: TemplateEntry = {
  component: PortfolioRenewalApology,
  subject: (data: Props) =>
    `Apology & correction: your portfolio ${data?.portfolio_name || ''}${data?.portfolio_id ? ` (#${data.portfolio_id})` : ''}`.trim(),
}