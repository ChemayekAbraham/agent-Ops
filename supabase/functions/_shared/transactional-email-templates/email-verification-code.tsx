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
 * Email ownership code — sent to the address a user has just typed into their
 * own profile. Entering the code back in the app is what proves they can read
 * that inbox, and only then does `profiles.email` move.
 */
interface EmailVerificationCodeProps {
  code?: string
  userName?: string
  minutesValid?: number
}

export function EmailVerificationCodeEmail({
  code = '000000',
  userName = 'there',
  minutesValid = 15,
}: EmailVerificationCodeProps) {
  return (
    <Html>
      <Head />
      <Preview>Your Welile email confirmation code is {code}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Confirm your email address</Heading>
          <Text style={text}>
            Hi {userName}, enter this code in the Welile app to confirm this inbox
            is yours.
          </Text>
          <Section style={codeBox}>
            <Text style={codeText}>{code}</Text>
          </Section>
          <Text style={muted}>
            The code expires in {minutesValid} minutes and can be used once.
          </Text>
          <Hr style={hr} />
          <Text style={muted}>
            If you did not ask to change your email address, ignore this message
            and nothing will happen. Do not share this code with anyone, including
            someone claiming to be from Welile.
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
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: '12px 0 0' }

export const template = {
  component: EmailVerificationCodeEmail,
  subject: (data: Record<string, any>) =>
    `Welile email confirmation code: ${data?.code ?? '******'}`,
  displayName: 'Email Confirmation Code',
  previewData: {
    code: '482915',
    userName: 'Jane',
    minutesValid: 15,
  },
} satisfies TemplateEntry
