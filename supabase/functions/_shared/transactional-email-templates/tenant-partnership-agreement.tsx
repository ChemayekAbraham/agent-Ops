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

interface TenantPartnershipAgreementProps {
  partner_name?: string
  partner_email?: string
  partner_reference?: string
  partnership_amount?: string
  partnership_amount_words?: string
  monthly_return?: string
  payout_summary?: string
  agreement_download_url?: string
  company_name?: string
  logo_url?: string
  unsubscribe_url?: string
}

export function TenantPartnershipAgreement({
  partner_name = 'Partner',
  partner_email = '',
  partner_reference = '',
  partnership_amount = '',
  partnership_amount_words = '',
  monthly_return = '',
  payout_summary = '',
  agreement_download_url = 'https://welileapp.com',
  company_name = 'WELILE TECHNOLOGIES LTD',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
}: TenantPartnershipAgreementProps) {
  const year = new Date().getFullYear()

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        Your Tenant Partnership Agreement with {company_name} — download your personalised PDF
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
                          PARTNERSHIP AGREEMENT
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Title */}
                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '40px 40px 20px 40px' }}>
                    <Heading style={heroH1}>Your Tenant Partnership Agreement</Heading>
                  </td>
                </tr>

                {/* Greeting + intro */}
                <tr>
                  <td align="left" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={greeting}>Dear {partner_name},</Text>
                    <Text style={introText}>
                      Thank you for partnering with {company_name}. We have prepared your
                      personalised Tenant Partnership Agreement using the details you provided
                      during onboarding.
                    </Text>
                    <Text style={{ ...introText, marginTop: '15px' }}>
                      A PDF copy of your agreement is ready for you below. Please keep it for your
                      records. Welile Technologies Limited will counter-sign the agreement on its part.
                    </Text>
                  </td>
                </tr>

                {/* Agreement summary card */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={docsCard}>
                      <tbody>
                        <tr>
                          <td style={docsHeader}>
                            <Text style={docsHeaderTag}>Agreement Summary</Text>
                            <Text style={docsHeaderTitle}>Key Terms</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '25px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block mobile-padding-bottom" >
                                    <Text style={docKey}>Partner Reference</Text>
                                    <Text style={docValStrong}>{partner_reference || '—'}</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block" >
                                    <Text style={docKey}>Account Email</Text>
                                    <Text style={docValStrong}>{partner_email || '—'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block mobile-padding-bottom" >
                                    <Text style={docKey}>Partnership Amount</Text>
                                    <Text style={docValStrong}>{partnership_amount || '—'}</Text>
                                    {partnership_amount_words ? (
                                      <Text style={docValStrong}>{partnership_amount_words} Shillings Only</Text>
                                    ) : null}
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block" >
                                    <Text style={docKey}>Monthly Return</Text>
                                    <Text style={docValStrong}>{monthly_return || '15%'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block mobile-padding-bottom" >
                                    <Text style={docKey}>Term</Text>
                                    <Text style={docValBody}>One (1) year</Text>
                                  </td>
                                  <td width="50%" style={{ verticalAlign: "top", paddingBottom: '20px' }} className="td-block" >
                                    <Text style={docKey}>Payout Method</Text>
                                    <Text style={docValStrong}>{payout_summary || '—'}</Text>
                                  </td>
                                </tr>
                                <tr>
                                  <td colSpan={2} style={{ verticalAlign: "top", ...statusRow }}>
                                    <Text style={docKey}>Counter-signature</Text>
                                    <Text style={statusPending}>Pending Welile execution</Text>
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
                          <a href={agreement_download_url} target="_blank" style={ctaLink}>
                            Download Your Agreement (PDF)
                          </a>
                        </td>
                      </tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Note callout */}
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={noteBox}>
                      <tbody><tr>
                        <td style={{ padding: '15px 20px' }}>
                          <Text style={noteTitle}>Important</Text>
                          <Text style={noteBody}>
                            Keep this agreement safe. Your principal and expected returns are guaranteed
                            by {company_name}. For any questions, reply to this email or contact our
                            Partnership Team.
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
                  <Text style={footerCompanyName}>{company_name}</Text>
                  <Text style={footerDisclaimer}>
                    You are receiving this email because you registered as a partner at {company_name}.<br />
                    Automated Partnership Agreement delivery. If you need assistance, contact us at{' '}
                    <Link href="mailto:partnership@welile.com" style={{ color: INK, textDecoration: 'none' }}>
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
const INK = '#0F172A'
/* All body copy unified to the requested #0F172A ink. */
const BODY = INK
const SUB = INK
const MUTED = INK
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
  a { color: ${INK}; }
  a:hover { color: ${INK}; }
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
  fontWeight: 400,
  textTransform: 'uppercase',
  letterSpacing: '1.5px',
}
const heroH1: React.CSSProperties = {
  margin: '0 0 15px 0',
  color: INK,
  fontSize: '24px',
  fontWeight: 400,
  letterSpacing: '-0.5px',
  lineHeight: '32px',
}
const greeting: React.CSSProperties = {
  margin: '0 0 15px 0',
  color: INK,
  fontSize: '16px',
  fontWeight: 400,
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
  fontWeight: 400,
  textTransform: 'uppercase',
  letterSpacing: '1px',
}
const docsHeaderTitle: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '18px',
  fontWeight: 400,
}
const docKey: React.CSSProperties = {
  margin: '0 0 5px 0',
  color: MUTED,
  fontSize: '12px',
  fontWeight: 400,
  textTransform: 'uppercase',
}
const docValStrong: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '15px',
  fontWeight: 400,
}
const docValBody: React.CSSProperties = {
  margin: '4px 0 0 0',
  color: BODY,
  fontSize: '13px',
  fontWeight: 400,
}
const statusRow: React.CSSProperties = {
  paddingTop: '15px',
  borderTop: `1px solid ${BORDER}`,
}
const statusPending: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '16px',
  fontWeight: 400,
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
  fontWeight: 400,
}
const noteBox: React.CSSProperties = {
  backgroundColor: '#eff6ff',
  borderRadius: '8px',
  borderLeft: '4px solid #3b82f6',
}
const noteTitle: React.CSSProperties = {
  margin: '0 0 5px 0',
  color: INK,
  fontSize: '14px',
  fontWeight: 400,
}
const noteBody: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '14px',
  lineHeight: '20px',
}
const outroSign: React.CSSProperties = {
  margin: 0,
  color: INK,
  fontSize: '15px',
  fontWeight: 400,
}
const outroTeam: React.CSSProperties = {
  fontWeight: 400,
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
  fontWeight: 400,
}
const footerCompanyName: React.CSSProperties = {
  margin: '0 0 12px 0',
  color: MUTED,
  fontSize: '14px',
  fontWeight: 400,
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
  color: INK,
  fontSize: '12px',
}

export const template = {
  component: TenantPartnershipAgreement,
  subject: (data: Record<string, any>) =>
    `Your Welile Tenant Partnership Agreement${data?.partner_name ? `, ${data.partner_name}` : ''}`,
  displayName: 'Tenant Partnership Agreement',
  previewData: {
    partner_name: 'SSENKAALI PIUS',
    partner_email: 'pius@example.com',
    partner_reference: 'WLP-2026-00428',
    partnership_amount: 'UGX 1,500,000',
    partnership_amount_words: 'One Million Five Hundred Thousand',
    monthly_return: '15%',
    payout_summary: 'Mobile Money — MTN 0780000000',
    agreement_download_url: 'https://welileapp.com',
    company_name: 'WELILE TECHNOLOGIES LTD',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
  },
} satisfies TemplateEntry