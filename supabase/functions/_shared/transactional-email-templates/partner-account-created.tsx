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

interface PartnerAccountCreatedProps {
  partner_name?: string
  partner_email?: string
  partner_reference?: string
  agreement_download_url?: string
  portal_url?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
}

export function PartnerAccountCreated({
  partner_name = 'Partner',
  partner_email = '',
  partner_reference = '',
  agreement_download_url = 'https://welileapp.com/dashboard',
  portal_url = 'https://welileapp.com/dashboard',
  company_name = 'WELILE TECHNOLOGIES LTD',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: PartnerAccountCreatedProps) {
  const year = new Date().getFullYear()

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        Your partner account with {company_name} has been created — your agreement follows shortly
      </Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={bgTable}>
          <tbody><tr><td align="center" style={{ padding: '40px 10px' }}>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" className="responsive-table" style={contentCard}>
              <tbody>
                <tr>
                  <td height={6} style={accentBar}></td>
                </tr>

                {/* Header */}
                <tr>
                  <td className="padding-mobile" style={headerCell}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="left" style={{ verticalAlign: "middle" }}>
                          <Img src={logo_url} alt={company_name} width="130" style={logoImg} />
                        </td>
                        <td align="right" className="hide-mobile" style={{ verticalAlign: "middle", ...secureLabel }}>
                          SYSTEM NOTIFICATION
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Title */}
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Partner Account Created</Heading>
                  </td>
                </tr>

                {/* Greeting + intro */}
                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greeting}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      Your partnership account has been successfully created with <b>{company_name}.</b>
                    </Text>
                    <Text style={{ ...introText, marginTop: '15px' }}>
                      The details you submitted in the onboarding form have been captured. Your personalised
                      partnership agreement is generated automatically from those details and is sent to you in a
                      separate email — there is nothing to download, print or fill in by hand.
                    </Text>
                  </td>
                </tr>

                {/* Required Documents Card */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={docsCard}>
                      <tbody>
                        <tr>
                          <td style={docsHeader}>
                            <Text style={docsHeaderTag}>Onboarding Details</Text>
                            <Text style={docsHeaderTitle}>Your Account</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block mobile-padding-bottom" >
                                    <Text style={docKey}>Account Email</Text>
                                    <Text style={docValStrong}>{partner_email || '—'}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block" >
                                    <Text style={docKey}>Partner Reference</Text>
                                    <Text style={docValStrong}>{partner_reference || '—'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block mobile-padding-bottom" >
                                    <Text style={docKey}>Partnership Agreement</Text>
                                    <Text style={docValBody}>Pre-filled from your form — sent separately</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block" >
                                    <Text style={docKey}>Next Step</Text>
                                    <Text style={docValBody}>Sign in and review your dashboard</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td colSpan={2} style={{ verticalAlign: "top", ...statusRow }}>
                                    <Text style={docKey}>Account Status</Text>
                                    <Text style={statusPending}>Active</Text>
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

                {/* CTA */}
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table border={0} cellSpacing={0} cellPadding={0} role="presentation">
                      <tbody><tr>
                        <td align="center" style={{ ...ctaCell, backgroundColor: BRAND }}>
                          <a href={portal_url || agreement_download_url} target="_blank" style={ctaLink}>
                            Open Your Partner Dashboard
                          </a>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Submission instructions */}
                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={introText}>
                      Watch for the follow-up email titled “Your Partnership Agreement” — it contains your
                      personalised, pre-filled PDF with your name, amount and payout details already on it.
                    </Text>
                  </td>
                </tr>

                {/* Note callout */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={noteBox}>
                      <tbody><tr>
                        <td style={{ padding: '15px 20px' }}>
                          <Text style={noteTitle}>Note</Text>
                          <Text style={noteBody}>
                            If your agreement email has not arrived within a few minutes, check your spam folder or
                            reply here and our Partnership Team will re-send it. Do not send us a hand-filled copy.
                          </Text>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Outro */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px' }}>
                    <Text style={outroSign}>
                      Warm regards,<br />
                      <span style={outroTeam}>Partnership Team</span>
                    </Text>
                  </td>
                </tr>

                {/* Quote */}
                <tr>
                  <td style={quoteCell}>
                    <Text style={quoteText}><i>“Welile is turning rent into an asset.”</i></Text>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Footer */}
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

                  <Text style={footerCompanyName}>{company_name}</Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you registered as a partner at {company_name}.<br />
                    Automated Partner Onboarding Notification. If you need assistance, contact us at{' '}
                    <Link href="mailto:partnership@welile.com" style={{ color: '#a855f7', textDecoration: 'none' }}>
                      partnership@welile.com
                    </Link>.
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
    .mobile-padding-bottom { padding-bottom: 15px !important; }
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
const heroH1: React.CSSProperties = {
  margin: '0 0 15px 0',
  color: INK,
  fontSize: '24px',
  fontWeight: 800,
  letterSpacing: '-0.5px',
  lineHeight: '32px',
}
const greeting: React.CSSProperties = {
  margin: '0 0 15px 0',
  color: INK,
  fontSize: '16px',
  fontWeight: 600,
}
const introText: React.CSSProperties = {
  margin: 0,
  color: BODY,
  fontSize: '15px',
  lineHeight: '24px',
}
const docsCard: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: '12px',
  overflow: 'hidden',
  backgroundColor: '#fafaf9',
}
const docsHeader: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  padding: '25px 30px',
  borderBottom: `1px solid ${BORDER}`,
}
const docsHeaderTag: React.CSSProperties = {
  margin: '0 0 5px 0',
  color: SUB,
  fontSize: '12px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '1px',
}
const docsHeaderTitle: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '18px',
  fontWeight: 700,
}
const docKey: React.CSSProperties = {
  margin: '0 0 5px 0',
  color: MUTED,
  fontSize: '12px',
  fontWeight: 600,
  textTransform: 'uppercase',
}
const docValStrong: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '15px',
  fontWeight: 700,
}
const docValBody: React.CSSProperties = {
  margin: 0,
  color: BODY,
  fontSize: '14px',
  fontWeight: 600,
}
const statusRow: React.CSSProperties = {
  paddingTop: '15px',
  borderTop: `1px solid ${BORDER}`,
}
const statusPending: React.CSSProperties = {
  margin: 0,
  color: '#ea580c',
  fontSize: '16px',
  fontWeight: 700,
}
const ctaCell: React.CSSProperties = {
  borderRadius: '8px',
}
const ctaLink: React.CSSProperties = {
  fontSize: '16px',
  fontFamily: FONT_STACK,
  color: '#ffffff',
  textDecoration: 'none',
  borderRadius: '8px',
  padding: '14px 32px',
  border: `1px solid ${BRAND}`,
  display: 'inline-block',
  fontWeight: 700,
}
const noteBox: React.CSSProperties = {
  backgroundColor: '#eff6ff',
  borderRadius: '8px',
  borderLeft: '4px solid #3b82f6',
}
const noteTitle: React.CSSProperties = {
  margin: '0 0 5px 0',
  color: '#1e40af',
  fontSize: '14px',
  fontWeight: 600,
}
const noteBody: React.CSSProperties = {
  margin: 0,
  color: '#1e40af',
  fontSize: '14px',
  lineHeight: '20px',
}
const outroSign: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '15px',
  fontWeight: 600,
}
const outroTeam: React.CSSProperties = {
  fontWeight: 700,
  color: BODY,
}
const quoteCell: React.CSSProperties = {
  padding: '20px 40px',
  textAlign: 'center' as const,
  borderTop: '1px solid #e5e7eb',
}
const quoteText: React.CSSProperties = {
  margin: 0,
  color: MUTED,
  fontSize: '12px',
  lineHeight: '18px',
  fontWeight: 500,
}
const socialIcon: React.CSSProperties = { display: 'block', opacity: 0.8 }
const footerCompanyName: React.CSSProperties = {
  margin: '0 0 12px 0',
  color: MUTED,
  fontSize: '14px',
  fontWeight: 700,
  textTransform: 'uppercase' as const,
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
  component: PartnerAccountCreated,
  subject: (data: Record<string, any>) =>
    `Welcome to Welile, ${data?.partner_name || 'Partner'} — your account is ready`,
  displayName: 'Partner Account Created',
  previewData: {
    partner_name: 'SSENKAALI PIUS',
    partner_email: 'pius@example.com',
    partner_reference: 'WLP-2026-00428',
    agreement_download_url: 'https://welileapp.com/dashboard',
    portal_url: 'https://welileapp.com/dashboard',
    company_name: 'WELILE TECHNOLOGIES LTD',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
  },
} satisfies TemplateEntry
