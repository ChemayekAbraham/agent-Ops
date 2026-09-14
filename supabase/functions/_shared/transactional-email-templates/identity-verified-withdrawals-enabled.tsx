import * as React from 'npm:react@18.3.1'
import {
  Body,
  Button,
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
 * Sent the moment Financial Ops verifies a holder's identity (National ID +
 * selfie + payout destination). Confirms the success and tells the holder
 * they can withdraw now.
 */
interface IdentityVerifiedProps {
  userName?: string
  destinationLabel?: string
  verifiedAt?: string
  appUrl?: string
}

export function IdentityVerifiedWithdrawalsEnabledEmail({
  userName = 'there',
  destinationLabel = '',
  verifiedAt = '',
  appUrl = 'https://welileapp.com',
}: IdentityVerifiedProps) {
  return (
    <Html>
      <Head />
      <Preview>Your Welile account is verified — you can withdraw now</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={brand}>WELILE</Text>
          <Heading style={h1}>Your account is verified</Heading>
          <Text style={text}>
            Hi {userName}, your identity check is complete. Your National ID and
            selfie were reviewed and approved by our Financial Ops team.
          </Text>

          <Section style={successBox}>
            <Text style={successLabel}>You can withdraw now</Text>
            <Text style={successText}>
              Your payout destination is verified and ready to receive money.
            </Text>
          </Section>

          {destinationLabel ? (
            <Section style={infoBox}>
              <Text style={infoLabel}>Verified payout destination</Text>
              <Text style={infoValue}>{destinationLabel}</Text>
              {verifiedAt ? (
                <>
                  <Text style={infoLabel}>Verified on</Text>
                  <Text style={infoValue}>{verifiedAt}</Text>
                </>
              ) : null}
            </Section>
          ) : null}

          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button style={button} href={appUrl}>
              Open my wallet
            </Button>
          </Section>

          <Hr style={hr} />
          <Text style={footer}>
            Keep your account details private. Welile staff will never ask you
            for your password or a one-time code.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: '#ffffff',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
}
const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '32px 24px',
  maxWidth: '560px',
  backgroundColor: '#ffffff',
  borderRadius: '12px',
}
const brand: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '13px',
  fontWeight: 700,
  letterSpacing: '0.22em',
  margin: '0 0 20px',
}
const h1: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '22px',
  fontWeight: 700,
  margin: '0 0 16px',
}
const text: React.CSSProperties = {
  color: '#334155',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '0 0 16px',
}
const successBox: React.CSSProperties = {
  background: '#0f172a',
  borderRadius: '12px',
  padding: '22px',
  textAlign: 'center',
  margin: '20px 0',
}
const successLabel: React.CSSProperties = {
  color: '#86efac',
  fontSize: '20px',
  fontWeight: 700,
  margin: '0 0 6px',
}
const successText: React.CSSProperties = {
  color: '#e2e8f0',
  fontSize: '14px',
  lineHeight: '21px',
  margin: 0,
}
const infoBox: React.CSSProperties = {
  backgroundColor: '#f1f5f9',
  borderRadius: '8px',
  padding: '16px',
  margin: '20px 0',
}
const infoLabel: React.CSSProperties = {
  color: '#64748b',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '0 0 2px',
  fontWeight: 600,
}
const infoValue: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '14px',
  margin: '0 0 12px',
}
const button: React.CSSProperties = {
  backgroundColor: '#0f172a',
  color: '#ffffff',
  borderRadius: '10px',
  fontSize: '15px',
  fontWeight: 700,
  padding: '13px 26px',
  textDecoration: 'none',
}
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '12px',
  margin: 0,
}

export const template = {
  component: IdentityVerifiedWithdrawalsEnabledEmail,
  subject: 'Your Welile account is verified — you can withdraw now',
  displayName: 'Identity Verified — Withdrawals Enabled',
  previewData: {
    userName: 'Jane',
    destinationLabel: 'MTN Mobile Money · 07XX XXX XXX',
    verifiedAt: '14 September 2026',
    appUrl: 'https://welileapp.com',
  },
} satisfies TemplateEntry
