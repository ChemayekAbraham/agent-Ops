import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  director_name?: string
  requisition_code?: string
  title?: string
  amount?: string
  requester?: string
  requested_at?: string
  reason?: string
  review_url?: string
}

export function DirectorRequisitionNew({
  director_name = 'Director',
  requisition_code = 'REQ-00000',
  title = 'Requisition',
  amount = 'UGX 0',
  requester = 'Staff',
  requested_at = '',
  reason = '',
  review_url = 'https://welileapp.com/director/dashboard',
}: Props) {
  return (
    <Html>
      <Head />
      <Preview>New requisition {requisition_code} awaiting your approval</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>New requisition for approval</Heading>
          <Text style={text}>Hi {director_name},</Text>
          <Text style={text}>
            A new funding requisition has been submitted and requires your review.
          </Text>

          <Section style={box}>
            <Text style={boxLabel}>Requisition</Text>
            <Text style={boxValue}>{requisition_code} — {title}</Text>
            <Text style={rowLabel}>Amount requested</Text>
            <Text style={rowValue}>{amount}</Text>
            <Text style={rowLabel}>Requested by</Text>
            <Text style={rowValue}>{requester}</Text>
            <Text style={rowLabel}>Date &amp; time</Text>
            <Text style={rowValue}>{requested_at}</Text>
            <Text style={rowLabel}>Reason</Text>
            <Text style={rowValue}>{reason}</Text>
          </Section>

          <Section style={{ textAlign: 'center', margin: '8px 0 20px' }}>
            <Button style={button} href={review_url}>Review requisition</Button>
          </Section>
          <Text style={muted}>Or open: {review_url}</Text>

          <Hr style={hr} />
          <Text style={footer}>Welile · Trusted rent &amp; receipts for Uganda</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: DirectorRequisitionNew,
  subject: (d: Record<string, any>) =>
    `Approval needed: ${d.requisition_code || 'Requisition'} — ${d.amount || ''}`.trim(),
  displayName: 'Director requisition — new',
  previewData: {
    director_name: 'Director',
    requisition_code: 'REQ-00001',
    title: 'Merchant Line Top-up Request',
    amount: 'UGX 8,000,000',
    requester: 'CFO',
    requested_at: '9 Jul 2026, 14:30',
    reason: 'Kindly requesting UGX 8,000,000 to top up the merchant lines to ensure uninterrupted operations and maintain sufficient transaction liquidity.',
    review_url: 'https://welileapp.com/director/dashboard',
  },
} satisfies TemplateEntry

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' }
const box: React.CSSProperties = { borderRadius: '10px', padding: '16px', margin: '8px 0 16px', backgroundColor: '#eff6ff' }
const boxLabel: React.CSSProperties = { color: '#2563eb', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 4px' }
const boxValue: React.CSSProperties = { color: '#1e3a8a', fontSize: '16px', fontWeight: 600, margin: '0 0 12px' }
const rowLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '8px 0 2px' }
const rowValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: 0 }
const button: React.CSSProperties = { backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '8px', padding: '12px 24px', fontSize: '15px', fontWeight: 600, textDecoration: 'none' }
const muted: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', textAlign: 'center', margin: '0 0 8px', wordBreak: 'break-all' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }
