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
  category_label?: string
  role_interest?: string
}

export function JobApplicationReceived({
  recipient_name = 'there',
  category_label = 'a role',
  role_interest = '',
}: Props) {
  const roleLine = role_interest
    ? `${role_interest} (${category_label})`
    : category_label
  return (
    <Html>
      <Head />
      <Preview>We received your job application at Welile</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Thanks for applying to Welile 🎉</Heading>
          <Text style={text}>Hi {recipient_name},</Text>
          <Text style={text}>
            We've received your application and it's now with our hiring team. Thank you
            for your interest in joining Welile.
          </Text>

          <Section style={box}>
            <Text style={boxLabel}>Application</Text>
            <Text style={boxValue}>{roleLine}</Text>
          </Section>

          <Text style={text}>
            Our team reviews every application carefully. If your profile is a match,
            we'll reach out to you directly on WhatsApp or by email to discuss the next
            steps. This can take a little time, so thank you for your patience.
          </Text>
          <Text style={text}>
            If you have questions, simply reply to this email — it reaches our team at{' '}
            <strong>info@welile.com</strong>.
          </Text>

          <Hr style={hr} />
          <Text style={footer}>Welile · Trusted rent & receipts for Uganda</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: JobApplicationReceived,
  subject: 'We received your application — Welile',
  displayName: 'Job application received',
  previewData: {
    recipient_name: 'Sarah',
    category_label: 'Developer',
    role_interest: 'Frontend Developer',
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
const box: React.CSSProperties = {
  borderRadius: '10px',
  padding: '16px',
  margin: '8px 0 16px',
  backgroundColor: '#eef2ff',
}
const boxLabel: React.CSSProperties = {
  color: '#6366f1',
  fontSize: '12px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  margin: '0 0 4px',
}
const boxValue: React.CSSProperties = {
  color: '#1e1b4b',
  fontSize: '16px',
  fontWeight: 600,
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
