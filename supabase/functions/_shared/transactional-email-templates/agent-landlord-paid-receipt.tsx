// Sent to the agent when their landlord has been paid: the email twin of the AP
// SMS (rent-plan-transition-notices). It says what the SMS says - who was paid,
// the receipt number and code, when the tenant starts repaying, the commission
// - laid out for reading, with a button to the public receipt.
//
// Every figure arrives already formatted by `agentPaidEmailData`, next to the
// SMS, so the two cannot disagree. This file only lays them out.
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

interface AgentLandlordPaidReceiptProps {
  agent_name?: string
  landlord_name?: string
  tenant_name?: string
  amount?: string | number
  currency?: string
  receipt_number?: string
  receipt_code?: string
  receipt_url?: string
  paid_on?: string
  repayment_starts_on?: string
  instalment?: string | number
  period_label?: string
  commission?: string | number
  rent_request_ref?: string
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

const present = (v: string | number | undefined) => v !== undefined && v !== null && v !== ''

interface LedgerLine {
  label: string
  value: string
  mono?: boolean
}

export function AgentLandlordPaidReceipt({
  agent_name = 'there',
  landlord_name = 'your landlord',
  tenant_name = 'your tenant',
  amount = 0,
  currency = 'UGX',
  receipt_number = '',
  receipt_code = '',
  receipt_url = '',
  paid_on = '',
  repayment_starts_on = '',
  instalment,
  period_label = 'per day',
  commission,
  rent_request_ref = '',
  company_name = 'Welile',
  logo_url = 'https://welileapp.com/welile-logo.png',
  unsubscribe_url = 'https://welile.com/unsubscribe',
  contact_url = 'https://welile.com/contact',
}: AgentLandlordPaidReceiptProps) {
  const year = new Date().getFullYear()
  const formattedAmount = formatAmount(amount, currency)
  const formattedInstalment = present(instalment) ? formatAmount(instalment, currency) : ''
  const formattedCommission = present(commission) ? formatAmount(commission, currency) : ''

  // Only the lines that have something to say; the last one drops its divider.
  const lines: LedgerLine[] = [
    { label: 'Landlord', value: landlord_name },
    { label: 'Tenant', value: tenant_name },
    receipt_number ? { label: 'Receipt No', value: receipt_number, mono: true } : null,
    receipt_code ? { label: 'Receipt Code', value: receipt_code, mono: true } : null,
    paid_on ? { label: 'Paid on', value: paid_on } : null,
    rent_request_ref ? { label: 'Reference', value: rent_request_ref, mono: true } : null,
  ].filter((l): l is LedgerLine => l !== null)

  return (
    <Html>
      <Head>
        <style>{clientOverrides}</style>
      </Head>
      <Preview>
        {formattedAmount} paid to {landlord_name}
        {receipt_number ? ` — Receipt ${receipt_number}` : ''}
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
                          Landlord Payment Receipt
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
                            alt="Paid"
                            width="32"
                            height="32"
                            style={{ display: 'block', margin: '0 auto', border: 0 }}
                          />
                        </td>
                      </tr></tbody>
                    </table>
                    <Heading style={heroH1}>Landlord Paid</Heading>
                    <Text style={heroSub}>Hi {agent_name},</Text>
                  </td>
                </tr>

                <tr>
                  <td align="center" className="padding-mobile" style={{ padding: '0 40px 25px 40px' }}>
                    <Text style={introText}>
                      <strong>{landlord_name}</strong> has been paid the rent for{' '}
                      <strong>{tenant_name}</strong>&apos;s Rent Plan. Keep the receipt details below — the
                      landlord was sent the same number and code.
                    </Text>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={ledgerCard}>
                      <tbody>
                        <tr>
                          <td align="center" style={ledgerAmountHeader}>
                            <Text style={ledgerAmountLabel}>Paid to landlord</Text>
                            <Text className="amount-text" style={ledgerAmountValue}>{formattedAmount}</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: '10px 30px' }}>
                            <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                {lines.map((line, i) => (
                                  <tr key={line.label}>
                                    <td style={i === lines.length - 1 ? ledgerRowLast : ledgerRow}>
                                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation"><tbody><tr>
                                        <td className="td-block" width="40%" style={ledgerKey}>{line.label}</td>
                                        <td className="td-block" width="60%" align="right" style={line.mono ? ledgerValMono : ledgerVal}>
                                          {line.value}
                                        </td>
                                      </tr></tbody></table>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                {receipt_url ? (
                  <tr>
                    <td align="center" className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                      <table border={0} cellPadding={0} cellSpacing={0} role="presentation" align="center">
                        <tbody><tr>
                          <td align="center" style={ctaCell}>
                            <Link href={receipt_url} style={ctaButton}>
                              View Receipt
                            </Link>
                          </td>
                        </tr></tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 10px 40px' }}>
                    <Heading as="h2" style={stepsH2}>What happens next</Heading>
                  </td>
                </tr>
                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 30px 40px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={stepsCard}>
                      <tbody>
                        {repayment_starts_on ? (
                          <tr>
                            <td style={stepRow}>
                              <Text style={stepText}>
                                <strong>{tenant_name}</strong> starts repaying on{' '}
                                <strong>{repayment_starts_on}</strong>
                                {formattedInstalment ? <>: <strong>{formattedInstalment}</strong> {period_label}</> : ''}.
                              </Text>
                            </td>
                          </tr>
                        ) : null}
                        {formattedCommission ? (
                          <tr>
                            <td style={stepRow}>
                              <Text style={stepText}>
                                You earned <strong>{formattedCommission}</strong> commission.
                              </Text>
                            </td>
                          </tr>
                        ) : null}
                        <tr>
                          <td style={stepRowLast}>
                            <Text style={stepText}>Please upload the receipt.</Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td className="padding-mobile" style={{ padding: '0 40px 40px 40px', textAlign: 'center' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody><tr>
                        <td align="center" style={supportCell}>
                          <Text style={supportText}>
                            Something look wrong?{' '}
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

/* === Styles (the same family as agent-landlord-float-funded) === */
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
  component: AgentLandlordPaidReceipt,
  subject: (data: Record<string, any>) => {
    const amt = formatAmount(data?.amount, data?.currency || 'UGX')
    const landlord = data?.landlord_name || 'your landlord'
    return data?.receipt_number
      ? `Receipt ${data.receipt_number}: ${amt} paid to ${landlord}`
      : `${amt} paid to ${landlord}`
  },
  displayName: 'Agent · Landlord Paid (Receipt)',
  previewData: {
    agent_name: 'James',
    landlord_name: 'Mr. Mukasa',
    tenant_name: 'Sarah Nakato',
    amount: 850000,
    currency: 'UGX',
    receipt_number: 'WLR-101214',
    receipt_code: '5NKSV5RMGB',
    receipt_url: 'https://welileapp.com/r/5NKSV5RMGB',
    paid_on: '09 Oct 2026, 12:15',
    repayment_starts_on: 'Tuesday 13 October',
    instalment: 12000,
    period_label: 'per day',
    commission: 8500,
    rent_request_ref: '9C7E2A41',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    contact_url: 'https://welile.com/contact',
  },
} satisfies TemplateEntry
