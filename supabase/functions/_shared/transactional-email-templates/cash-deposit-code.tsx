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
  amountUgx?: number
  depositorName?: string
  cashOwnerName?: string
  issuedAt?: string
  minutesValid?: number
}

const ugx = (n: number | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? `UGX ${Math.round(n).toLocaleString('en-UG')}`
    : 'UGX 0'

export function CashDepositCodeEmail({
  code = '0000',
  amountUgx = 0,
  depositorName = 'there',
  cashOwnerName = '',
  issuedAt = new Date().toISOString(),
  minutesValid = 10,
}: CashDepositCodeProps) {
  const when = new Date(issuedAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
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
            Use the secure confirmation code below in the Welile app to complete the deposit and
            have it credited to your wallet.
          </Text>

          <Text style={codeLabel}>YOUR CONFIRMATION CODE</Text>
          <Section style={codeBox}>
            <Text style={codeText}>{code}</Text>
          </Section>

          <Text style={muted}>
            The code expires in {minutesValid} minutes and can be used once.
          </Text>

          <Hr style={hr} />
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
            For your security, do not share this code with anyone. Your wallet is credited only after
            you enter this code in the Welile app.
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
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '18px 0' }
const label: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '11px',
  letterSpacing: '0.08em',
  margin: '0 0 2px',
  fontWeight: 700,
}
const value: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 12px' }
const footerSection: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderTop: '1px solid #e2e8f0',
  padding: '22px 32px',
  textAlign: 'center' as const,
}
const footerTitle: React.CSSProperties = { color: '#475569', fontSize: '11px', fontWeight: 700, margin: '0 0 5px' }
const footer: React.CSSProperties = { color: '#64748b', fontSize: '12px', margin: '0 0 5px' }
const footerLink: React.CSSProperties = { color: '#7b19d4', fontSize: '12px', fontWeight: 600, margin: 0 }

export const template = {
  component: CashDepositCodeEmail,
  subject: (data: Record<string, any>) =>
    `Welile received your cash deposit · ${ugx(Number(data?.amountUgx ?? 0))}`,
  displayName: 'Cash deposit code',
  previewData: {
    code: '4821',
    amountUgx: 5000000,
    depositorName: 'Benjamin',
    cashOwnerName: 'BENJAMIN MUHANGUZI',
    issuedAt: new Date().toISOString(),
    minutesValid: 10,
  },
} satisfies TemplateEntry
