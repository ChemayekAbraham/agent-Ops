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
 * Login-phone change approval code — sent by self-update-phone to the
 * account's settled inbox, as the second proof (beside the SMS code on the
 * NEW number) that the owner wants to move their login to another SIM.
 *
 * The subject deliberately carries no code: `email_send_log.subject` is
 * readable by staff, the same reason sms_delivery_log masks codes.
 */
interface PhoneChangeCodeProps {
  code?: string
  userName?: string
  newPhoneLast3?: string
  requestedAt?: string
  minutesValid?: number
}

export function PhoneChangeCodeEmail({
  code = '000000',
  userName = 'there',
  newPhoneLast3 = '***',
  requestedAt = new Date().toISOString(),
  minutesValid = 10,
}: PhoneChangeCodeProps) {
  const when = new Date(requestedAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
  return (
    <Html>
      <Head />
      <Preview>Approve your Welile login phone change</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Approve your phone change</Heading>
          <Text style={text}>
            Hi {userName}, someone signed in to your Welile account asked to change
            its login phone to a number ending in {newPhoneLast3}. If that was you,
            enter this code in the app to approve it.
          </Text>
          <Section style={codeBox}>
            <Text style={codeText}>{code}</Text>
          </Section>
          <Text style={muted}>
            The code expires in {minutesValid} minutes and can be used once.
          </Text>
          <Hr style={hr} />
          <Text style={label}>NEW LOGIN PHONE</Text>
          <Text style={value}>Ending in {newPhoneLast3}</Text>
          <Text style={label}>REQUESTED</Text>
          <Text style={value}>{when} (EAT)</Text>
          <Hr style={hr} />
          <Text style={muted}>
            Not you? Do NOT share this code with anyone, including someone claiming
            to be from Welile. Change your password in Settings and call support.
            Withdrawals pause for 24 hours after any phone change.
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
  component: PhoneChangeCodeEmail,
  // No code in the subject — it is stored in email_send_log.
  subject: 'Approve your Welile login phone change',
  displayName: 'Phone Change Approval Code',
  previewData: {
    code: '482915',
    userName: 'Jane',
    newPhoneLast3: '633',
    requestedAt: new Date().toISOString(),
    minutesValid: 10,
  },
} satisfies TemplateEntry
