import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface ProxyAgentOnboardedProps {
  recipient_name?: string
  onboarded_on?: string
  app_url?: string
}

export function ProxyAgentOnboardedEmail({
  recipient_name = 'there',
  onboarded_on = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  app_url = 'https://welileapp.com',
}: ProxyAgentOnboardedProps) {
  return (
    <Html>
      <Head />
      <Preview>You are now an approved Welile Proxy Agent</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>You are now a Welile Proxy Agent</Heading>
          <Text style={text}>Dear {recipient_name},</Text>
          <Text style={text}>
            Welile Partner Operations has approved you as a <strong>Proxy Agent</strong>, effective {onboarded_on}.
            This is a trusted field role: you may act on behalf of partners you are assigned to, and their
            payouts can be routed through you for delivery.
          </Text>

          <Section style={infoBox}>
            <Text style={infoLabel}>What this role lets you do</Text>
            <Text style={bullet}>• Register and support partners in the field on Welile's behalf.</Text>
            <Text style={bullet}>• Capture partner deposits and investments directly in the app.</Text>
            <Text style={bullet}>• Receive and deliver partner payouts you are authorised to handle.</Text>
            <Text style={bullet}>• Access the Proxy Agent tools inside your Welile dashboard.</Text>
          </Section>

          <Section style={infoBox}>
            <Text style={infoLabel}>Your benefits</Text>
            <Text style={bullet}>• 2% commission on every deposit you capture for a partner, credited instantly.</Text>
            <Text style={bullet}>• 10% commission on rent collections you record.</Text>
            <Text style={bullet}>• Commission lands in your withdrawable wallet — yours to withdraw.</Text>
            <Text style={bullet}>• Priority support from the Partner Operations team.</Text>
          </Section>

          <Text style={text}>
            Sign in at {app_url} to see your Proxy Agent tools. Please keep every partner transaction
            recorded in the app on the same day it happens — this protects both you and the partner.
          </Text>

          <Hr style={hr} />
          <Text style={footer}>
            Welile · Questions about this role? Reply to this email and Partner Operations will help.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#f8fafc', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' }
const infoBox: React.CSSProperties = { backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const infoLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px', fontWeight: 600 }
const bullet: React.CSSProperties = { color: '#0f172a', fontSize: '14px', lineHeight: '22px', margin: '0 0 6px' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }

export const template = {
  component: ProxyAgentOnboardedEmail,
  subject: 'You are now an approved Welile Proxy Agent',
  displayName: 'Proxy Agent Onboarded',
  previewData: {
    recipient_name: 'Timothy Kalyango',
    onboarded_on: '30 August 2026',
    app_url: 'https://welileapp.com',
  },
} satisfies TemplateEntry
