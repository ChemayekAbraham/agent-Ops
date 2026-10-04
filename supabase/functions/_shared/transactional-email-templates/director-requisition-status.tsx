import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  requester_name?: string
  requisition_code?: string
  title?: string
  amount?: string
  status_label?: string
  decided_by?: string
  decided_at?: string
  comment?: string
  review_url?: string
}

export function DirectorRequisitionStatus({
  requester_name = 'there',
  requisition_code = 'REQ-00000',
  title = 'Requisition',
  amount = 'UGX 0',
  status_label = 'Updated',
  decided_by = 'Director',
  decided_at = '',
  comment = '',
  review_url = 'https://welileapp.com/director/dashboard',
}: Props) {
  return (
    <Html>
      <Head />
      <Preview>{requisition_code} — {status_label}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Requisition {status_label.toLowerCase()}</Heading>
          <Text style={text}>Hi {requester_name},</Text>
          <Text style={text}>
            Your requisition <strong>{requisition_code}</strong> ({title}, {amount}) has been{' '}
            <strong>{status_label.toLowerCase()}</strong> by {decided_by}.
          </Text>

          <Section style={box}>
            <Text style={rowLabel}>Status</Text>
            <Text style={rowValue}>{status_label}</Text>
            <Text style={rowLabel}>Decision time</Text>
            <Text style={rowValue}>{decided_at}</Text>
            {comment ? (
              <>
                <Text style={rowLabel}>Director comment</Text>
                <Text style={rowValue}>{comment}</Text>
              </>
            ) : null}
          </Section>

          <Section style={{ textAlign: 'center', margin: '8px 0 20px' }}>
            <Button style={button} href={review_url}>Open requisition</Button>
          </Section>

          <Hr style={hr} />
          <Text style={footer}>Welile · Trusted rent &amp; receipts for Uganda</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: DirectorRequisitionStatus,
  subject: (d: Record<string, any>) =>
    `${d.requisition_code || 'Requisition'} — ${d.status_label || 'Update'}`,
  displayName: 'Director requisition — status update',
  previewData: {
    requester_name: 'CFO',
    requisition_code: 'REQ-00001',
    title: 'Merchant Line Top-up Request',
    amount: 'UGX 8,000,000',
    status_label: 'Approved',
    decided_by: 'Director',
    decided_at: '9 Jul 2026, 15:10',
    comment: 'Approved. Proceed with the top-up.',
    review_url: 'https://welileapp.com/director/dashboard',
  },
} satisfies TemplateEntry

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' }
const box: React.CSSProperties = { borderRadius: '10px', padding: '16px', margin: '8px 0 16px', backgroundColor: '#f1f5f9' }
const rowLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '8px 0 2px' }
const rowValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: 0 }
const button: React.CSSProperties = { backgroundColor: '#0f172a', color: '#ffffff', borderRadius: '8px', padding: '12px 24px', fontSize: '15px', fontWeight: 600, textDecoration: 'none' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }
