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
 * Sent after the owner said "I don't know this device": that device has been
 * signed out, and changing the password is suggested (never forced).
 * See _shared/newDeviceAlert.ts.
 */
interface PasswordChangeTipProps {
  userName?: string
  deviceIcon?: string
  deviceLabel?: string
  location?: string
  signedOutAt?: string
}

export function PasswordChangeTipEmail({
  userName = 'there',
  deviceIcon = '❔',
  deviceLabel = 'the device',
  location = 'Unknown location',
  signedOutAt = new Date().toISOString(),
}: PasswordChangeTipProps) {
  const when = new Date(signedOutAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
  return (
    <Html>
      <Head />
      <Preview>We signed out the device you didn't recognise</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>We signed out that device</Heading>
          <Text style={text}>
            Hi {userName}, you told us you don't recognise this device, so we've signed it out of your Welile account.
          </Text>
          <Section style={deviceBox}>
            <Text style={iconText}>{deviceIcon}</Text>
            <Text style={deviceText}>{deviceLabel}</Text>
            <Text style={deviceMuted}>{location}</Text>
          </Section>
          <Text style={label}>SIGNED OUT</Text>
          <Text style={value}>{when} (EAT)</Text>
          <Hr style={hr} />
          <Text style={text}>
            <strong>Tip:</strong> if someone else may know your password, change it from <strong>Settings</strong> in
            the Welile app. A new password stops them from signing in again. Never share your password or sign-in
            codes with anyone, including people who say they work for Welile.
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
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 16px' }
const deviceBox: React.CSSProperties = {
  backgroundColor: '#f1f5f9',
  borderRadius: '10px',
  padding: '16px',
  textAlign: 'center' as const,
  margin: '0 0 16px',
}
const iconText: React.CSSProperties = { fontSize: '36px', lineHeight: '40px', margin: '0 0 4px' }
const deviceText: React.CSSProperties = { color: '#0f172a', fontSize: '16px', fontWeight: 700, margin: 0 }
const deviceMuted: React.CSSProperties = { color: '#64748b', fontSize: '13px', margin: '4px 0 0' }
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
  component: PasswordChangeTipEmail,
  subject: () => 'We signed out a device you didn\'t recognise',
  displayName: 'Password Change Tip',
  previewData: {
    userName: 'Jane',
    deviceIcon: '🪟',
    deviceLabel: 'Windows · Chrome',
    location: 'Kampala, Uganda',
    signedOutAt: new Date().toISOString(),
  },
} satisfies TemplateEntry
