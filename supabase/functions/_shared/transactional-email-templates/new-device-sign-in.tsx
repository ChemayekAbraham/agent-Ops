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
 * New-device sign-in alert — sent to the account owner the first time their
 * account signs in on a device it has never used. The sign-in is NOT blocked;
 * the owner confirms or rejects the device from a device they normally use.
 * See _shared/newDeviceAlert.ts.
 */
interface NewDeviceSignInProps {
  userName?: string
  deviceIcon?: string
  deviceLabel?: string
  location?: string
  ipAddress?: string
  signedInAt?: string
}

export function NewDeviceSignInEmail({
  userName = 'there',
  deviceIcon = '❔',
  deviceLabel = 'A new device',
  location = 'Unknown location',
  ipAddress = 'Unknown',
  signedInAt = new Date().toISOString(),
}: NewDeviceSignInProps) {
  const when = new Date(signedInAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
  return (
    <Html>
      <Head />
      <Preview>New sign-in to your Welile account from {deviceLabel}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>New sign-in to your account</Heading>
          <Text style={text}>
            Hi {userName}, your Welile account was just signed in to on a device it hasn't used before.
          </Text>
          <Section style={deviceBox}>
            <Text style={iconText}>{deviceIcon}</Text>
            <Text style={deviceText}>{deviceLabel}</Text>
          </Section>
          <Text style={label}>WHEN</Text>
          <Text style={value}>{when} (EAT)</Text>
          <Text style={label}>APPROXIMATE LOCATION</Text>
          <Text style={value}>{location}</Text>
          <Text style={label}>IP ADDRESS</Text>
          <Text style={value}>{ipAddress}</Text>
          <Hr style={hr} />
          <Text style={text}>
            <strong>Was this you?</strong> Open Welile on a phone or computer you normally use. You'll see this
            sign-in there: choose <strong>I know this device</strong> to keep it, or <strong>I don't know this
            device</strong> to sign it out.
          </Text>
          <Text style={muted}>
            Location is estimated from the internet connection and can be off, especially on mobile data.
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
  component: NewDeviceSignInEmail,
  subject: (data: Record<string, any>) => `New sign-in to your Welile account${data?.deviceLabel ? ` · ${data.deviceLabel}` : ''}`,
  displayName: 'New Device Sign-in Alert',
  previewData: {
    userName: 'Jane',
    deviceIcon: '🤖',
    deviceLabel: 'Android · Chrome',
    location: 'Kampala, Uganda',
    ipAddress: '102.85.0.1',
    signedInAt: new Date().toISOString(),
  },
} satisfies TemplateEntry
