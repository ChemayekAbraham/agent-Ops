/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
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
      <Preview>Your Welile cash deposit code is {code}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Your cash deposit code</Heading>
          <Text style={text}>
            Hi {depositorName}, Financial Ops has recorded cash of {ugx(amountUgx)}. Enter the code
            below in the Welile app to confirm the deposit and have it credited to your wallet.
          </Text>

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
            Do not share this code with anyone who has not physically received your cash. Nothing is
            credited until you enter it yourself in the Welile app.
          </Text>
          <Text style={footer}>Welile · https://welileapp.com</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '32px 24px',
  maxWidth: '520px',
  borderRadius: '12px',
}
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', margin: '0 0 12px', fontWeight: 700 }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 20px' }
const codeBox: React.CSSProperties = {
  backgroundColor: '#0f172a',
  borderRadius: '10px',
  padding: '18px',
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
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: '16px 0 0' }

export const template = {
  component: CashDepositCodeEmail,
  subject: 'Your Welile cash deposit code',
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
