/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

/**
 * Cash deposit code — the same 4-digit receipt code the depositor receives by
 * SMS, delivered to their own inbox as an alternative channel when SMS is
 * unavailable. This email NEVER credits anything: the wallet is only credited
 * after the depositor enters the code in the Welile app.
 */
interface CashDepositCodeProps {
  code?: string
  referenceNumber?: string
  amountUgx?: number
  depositorName?: string
  cashOwnerName?: string
  issuedAt?: string
  expiresAt?: string
  resendUrl?: string
  minutesValid?: number
  supportPhone?: string
  supportWhatsapp?: string
  helpLink?: string
}

const ugx = (n: number | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? `UGX ${Math.round(n).toLocaleString('en-UG')}`
    : 'UGX 0'

export function CashDepositCodeEmail({
  code = '0000',
  referenceNumber = 'DEP-00000000',
  amountUgx = 0,
  depositorName = 'there',
  cashOwnerName = '',
  issuedAt = new Date().toISOString(),
  expiresAt,
  resendUrl = 'https://welileapp.com/cash-deposit/resend',
  minutesValid = 10,
  supportPhone = '+256 708 257 899',
  supportWhatsapp = '+256708257899',
  helpLink = 'https://welileapp.com/help',
}: CashDepositCodeProps) {
  const when = new Date(issuedAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
  const expiry = new Date(expiresAt ?? new Date(issuedAt).getTime() + minutesValid * 60_000).toLocaleString('en-UG', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return (
    <Html>
      <Head />
      <Preview>Welile has received your cash deposit of {ugx(amountUgx)}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={brandHeader}>
            <Img
              src="https://welileapp.com/welile-logo.png"
              width="132"
              alt="Welile"
              style={logo}
            />
          </Section>

          <Section style={content}>
          <Text style={eyebrow}>CASH DEPOSIT RECEIVED</Text>
          <Heading style={h1}>Welile has received your cash deposit</Heading>
          <Text style={text}>
            Hi {depositorName}, we have received your cash deposit of <strong>{ugx(amountUgx)}</strong>.
            Enter the cash deposit code below in the Welile app to confirm your cash deposit and
            have it credited to your Welile Wallet.
          </Text>

          <Text style={codeLabel}>YOUR CASH DEPOSIT CODE</Text>
          <Section style={codeBox}>
            <Text style={codeText}>{code}</Text>
          </Section>

          <Text style={muted}>
            This code expires on {expiry} EAT (Kampala time) and can be used once.
          </Text>
          <Text style={resendText}>
            Code expired or did not arrive? <Link href={resendUrl} style={resendLink}>Resend code</Link>
          </Text>

          <Hr style={hr} />
          <Text style={label}>DEPOSIT REFERENCE</Text>
          <Text style={referenceValue}>{referenceNumber}</Text>
          <Text style={label}>AMOUNT</Text>
          <Text style={value}>{ugx(amountUgx)}</Text>
          {cashOwnerName ? (
            <>
              <Text style={label}>CASH OWNER</Text>
              <Text style={value}>{cashOwnerName}</Text>
            </>
          ) : null}
          <Text style={label}>ISSUED</Text>
          <Text style={value}>{when} (EAT)</Text>
          <Hr style={hr} />

          <Text style={muted}>
            Do not share this code with anyone who has not received your cash. Your Welile Wallet is credited only after
            you enter this code in the Welile app.
          </Text>
          </Section>

          <Section style={helpSection}>
            <Text style={helpTitle}>Need help?</Text>
            <Text style={helpText}>
              If you have questions about this deposit, message us on{' '}
              <Link href={`https://wa.me/${supportWhatsapp.replace(/\D/g, '')}`} style={helpLinkStyle}>
                WhatsApp
              </Link>{' '}
              or call <strong>{supportPhone}</strong>.
            </Text>
            <Text style={helpText}>
              Visit our <Link href={helpLink} style={helpLinkStyle}>help center</Link> for quick answers.
            </Text>
          </Section>

          <Section style={footerSection}>
            <Text style={footerTitle}>WELILE TECHNOLOGIES LTD</Text>
            <Text style={footer}>Turning rent into an asset.</Text>
            <Text style={footerLink}>welileapp.com</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: '#f4f7f9',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
  margin: 0,
  padding: '32px 12px',
}
const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  maxWidth: '560px',
  borderRadius: '12px',
  overflow: 'hidden',
  border: '1px solid #e2e8f0',
}
const brandHeader: React.CSSProperties = {
  borderTop: '6px solid #7b19d4',
  borderBottom: '1px solid #e2e8f0',
  padding: '24px 32px',
}
const logo: React.CSSProperties = { display: 'block', height: 'auto', maxWidth: '132px' }
const content: React.CSSProperties = { padding: '32px' }
const eyebrow: React.CSSProperties = {
  color: '#7b19d4',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  margin: '0 0 8px',
}
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '25px', lineHeight: '32px', margin: '0 0 14px', fontWeight: 700 }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 20px' }
const codeLabel: React.CSSProperties = {
  color: '#64748b',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  margin: '0 0 8px',
  textAlign: 'center' as const,
}
const codeBox: React.CSSProperties = {
  backgroundColor: '#0f172a',
  borderRadius: '8px',
  padding: '20px',
  textAlign: 'center' as const,
  margin: '0 0 12px',
}
const codeText: React.CSSProperties = {
  color: '#ffffff',
  fontSize: '34px',
  letterSpacing: '0.35em',
  fontWeight: 700,
  margin: 0,
}
const muted: React.CSSProperties = { color: '#64748b', fontSize: '13px', lineHeight: '20px', margin: '0 0 12px' }
const resendText: React.CSSProperties = { color: '#475569', fontSize: '13px', lineHeight: '20px', margin: '0 0 12px', textAlign: 'center' as const }
const resendLink: React.CSSProperties = { color: '#7b19d4', fontWeight: 700, textDecoration: 'underline' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '18px 0' }
const label: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '11px',
  letterSpacing: '0.08em',
  margin: '0 0 2px',
  fontWeight: 700,
}
const value: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 12px' }
const referenceValue: React.CSSProperties = {
  color: '#0f172a',
  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  fontSize: '15px',
  fontWeight: 700,
  margin: '0 0 12px',
}
const footerSection: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderTop: '1px solid #e2e8f0',
  padding: '22px 32px',
  textAlign: 'center' as const,
}
const footerTitle: React.CSSProperties = { color: '#475569', fontSize: '11px', fontWeight: 700, margin: '0 0 5px' }
const footer: React.CSSProperties = { color: '#64748b', fontSize: '12px', margin: '0 0 5px' }
const footerLink: React.CSSProperties = { color: '#7b19d4', fontSize: '12px', fontWeight: 600, margin: 0 }
const helpSection: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderTop: '1px solid #e2e8f0',
  padding: '22px 32px',
}
const helpTitle: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '14px',
  fontWeight: 700,
  margin: '0 0 8px',
}
const helpText: React.CSSProperties = {
  color: '#475569',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0 0 6px',
}
const helpLinkStyle: React.CSSProperties = {
  color: '#7b19d4',
  fontWeight: 600,
  textDecoration: 'underline',
}

export const template = {
  component: CashDepositCodeEmail,
  subject: (data: Record<string, any>) =>
    `Welile received your cash deposit · ${ugx(Number(data?.amountUgx ?? 0))}`,
  displayName: 'Cash deposit code',
  previewData: {
    code: '4821',
    referenceNumber: 'DEP-5A7C91E2',
    amountUgx: 5000000,
    depositorName: 'Benjamin',
    cashOwnerName: 'BENJAMIN MUHANGUZI',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    resendUrl: 'https://welileapp.com/cash-deposit/resend?deposit=00000000-0000-0000-0000-000000000000',
    minutesValid: 10,
  },
} satisfies TemplateEntry
