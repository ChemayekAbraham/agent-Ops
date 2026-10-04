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
 * Two-step verification code — sent to the account owner's inbox whenever a
 * NEW device tries to sign in while two-step verification is switched on.
 */
interface TwoFactorCodeProps {
  code?: string
  userName?: string
  deviceLabel?: string
  requestedAt?: string
  minutesValid?: number
}

export function TwoFactorCodeEmail({
  code = '000000',
  userName = 'there',
  deviceLabel = 'A new device',
  requestedAt = new Date().toISOString(),
  minutesValid = 10,
}: TwoFactorCodeProps) {
  const when = new Date(requestedAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
  return (
    <Html>
      <Head />
      <Preview>Your Welile verification code is {code}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Your verification code</Heading>
          <Text style={text}>
            Hi {userName}, a new device is trying to sign in to your Welile account.
            Enter this code on that device to continue.
          </Text>
          <Section style={codeBox}>
            <Text style={codeText}>{code}</Text>
          </Section>
          <Text style={muted}>
            The code expires in {minutesValid} minutes and can be used once.
          </Text>
          <Hr style={hr} />
          <Text style={label}>DEVICE</Text>
          <Text style={value}>{deviceLabel}</Text>
          <Text style={label}>REQUESTED</Text>
          <Text style={value}>{when} (EAT)</Text>
          <Hr style={hr} />
          <Text style={muted}>
            If this was not you, do NOT share this code. Sign in on your own device,
            open Settings, and change your password immediately.
          </Text>
          <Text style={footer}>Welile · https://welileapp.com</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#f8fafc', fontFamily: 'Arial, sans-serif' }
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
  fontSize: '32px',
  letterSpacing: '0.35em',
  margin: 0,
  fontWeight: 700,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const muted: React.CSSProperties = { color: '#64748b', fontSize: '13px', lineHeight: '20px', margin: '0 0 8px' }
const label: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '11px',
  letterSpacing: '0.05em',
  margin: '0 0 2px',
  fontWeight: 600,
}
const value: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 12px' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: '12px 0 0' }

export const template = {
  component: TwoFactorCodeEmail,
  subject: (data: Record<string, any>) => `Welile verification code: ${data?.code ?? '******'}`,
  displayName: 'Two-Step Verification Code',
  previewData: {
    code: '482915',
    userName: 'Jane',
    deviceLabel: 'Android · Chrome',
    requestedAt: new Date().toISOString(),
    minutesValid: 10,
  },
} satisfies TemplateEntry
