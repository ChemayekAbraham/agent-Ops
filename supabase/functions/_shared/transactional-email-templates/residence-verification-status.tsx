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

interface Props {
  recipient_name?: string
  entity_label?: string   // "landlord (John)" or "LC1 chairperson (Jane)"
  status?: string         // verified | pending | rejected
  reason?: string
}

const STATUS_META: Record<string, { color: string; bg: string; label: string }> = {
  verified: { color: '#047857', bg: '#ecfdf5', label: 'Verified' },
  rejected: { color: '#b91c1c', bg: '#fef2f2', label: 'Rejected' },
  pending: { color: '#b45309', bg: '#fffbeb', label: 'Under review' },
}

export function ResidenceVerificationStatus({
  recipient_name = 'there',
  entity_label = 'your residence',
  status = 'pending',
  reason = '',
}: Props) {
  const meta = STATUS_META[status] || STATUS_META.pending
  const isRejected = status === 'rejected'
  const isVerified = status === 'verified'
  return (
    <Html>
      <Head />
      <Preview>{`${entity_label} verification: ${meta.label}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Verification update</Heading>
          <Text style={text}>Hi {recipient_name},</Text>
          <Text style={text}>
            The verification status for <strong>{entity_label}</strong> has been updated.
          </Text>

          <Section style={{ ...statusBox, backgroundColor: meta.bg }}>
            <Text style={{ ...statusLabel, color: meta.color }}>{meta.label}</Text>
            {reason ? (
              <Text style={reasonText}>
                {isRejected ? 'Reason: ' : 'Note: '}{reason}
              </Text>
            ) : null}
          </Section>

          {isVerified ? (
            <Text style={text}>
              You're all set — you can now continue with your loan request in the app.
            </Text>
          ) : isRejected ? (
            <Text style={text}>
              Please review the reason above, update your details in the app, and request
              verification again.
            </Text>
          ) : (
            <Text style={text}>
              Our team is reviewing your details. We'll let you know once a decision is made.
            </Text>
          )}

          <Hr style={hr} />
          <Text style={footer}>Welile · Trusted rent & receipts for Uganda</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: ResidenceVerificationStatus,
  subject: 'Your verification status was updated',
  displayName: 'Residence verification status',
  previewData: {
    recipient_name: 'Sarah',
    entity_label: 'your landlord (John Doe)',
    status: 'rejected',
    reason: 'The GPS pin does not match the stated village. Please recapture on-site.',
  },
} satisfies TemplateEntry

const main: React.CSSProperties = {
  backgroundColor: '#ffffff',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
}
const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '32px 24px',
  maxWidth: '560px',
  backgroundColor: '#ffffff',
  borderRadius: '12px',
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
  margin: '0 0 12px',
}
const statusBox: React.CSSProperties = {
  borderRadius: '10px',
  padding: '16px',
  margin: '8px 0 16px',
}
const statusLabel: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: 700,
  margin: '0 0 6px',
}
const reasonText: React.CSSProperties = {
  color: '#334155',
  fontSize: '14px',
  lineHeight: '22px',
  margin: 0,
}
const hr: React.CSSProperties = {
  borderColor: '#e2e8f0',
  margin: '20px 0',
}
const footer: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '12px',
  margin: 0,
}
