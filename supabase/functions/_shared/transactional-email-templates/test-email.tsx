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

interface TestEmailProps {
  recipientName?: string
  testTimestamp?: string
}

export function TestEmail({
  recipientName = 'there',
  testTimestamp = new Date().toISOString(),
}: TestEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Welile transactional email system test</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>✅ Welile Email System</Heading>
          <Text style={text}>Hi {recipientName},</Text>
          <Text style={text}>
            This is a test email from the Welile transactional email system. If
            you received this message, the email pipeline is working end-to-end:
            queue → worker → Mailgun → inbox.
          </Text>
          <Section style={infoBox}>
            <Text style={infoLabel}>Sender</Text>
            <Text style={infoValue}>info@welile.com</Text>
            <Text style={infoLabel}>Sent at</Text>
            <Text style={infoValue}>{testTimestamp}</Text>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>
            Welile · Trusted rent & receipts for Uganda
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: '#f6f7f9',
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
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const hr: React.CSSProperties = {
  borderColor: '#e2e8f0',
  margin: '24px 0 16px',
}
const footer: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '12px',
  margin: 0,
}

export const template = {
  component: TestEmail,
  subject: '✅ Welile email system test',
  displayName: 'Test Email',
  previewData: {
    recipientName: 'Welile Team',
    testTimestamp: new Date().toISOString(),
  },
} satisfies TemplateEntry