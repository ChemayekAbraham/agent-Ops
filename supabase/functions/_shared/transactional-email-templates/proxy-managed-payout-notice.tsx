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

interface ProxyManagedPayoutProps {
  agent_name?: string
  partner_name?: string
  amount?: number
  currency?: string
  transaction_id?: string
  payout_kind?: string // e.g. "Monthly Returns"
  date?: string
  reason?: string // e.g. "Managed Proxy Account"
}

const fmt = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—')

export function ProxyManagedPayoutNoticeEmail({
  agent_name = 'Agent',
  partner_name = 'your partner',
  amount,
  currency = 'UGX',
  transaction_id = '',
  payout_kind = 'Returns Payout',
  date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  reason = 'Managed Proxy Account',
}: ProxyManagedPayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>
        {currency} {fmt(amount)} credited to your wallet on behalf of {partner_name}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Proxy Payout Received</Heading>
          <Text style={text}>Hi {agent_name},</Text>
          <Text style={text}>
            A payout meant for <strong>{partner_name}</strong> has been credited to{' '}
            <strong>your wallet</strong> because you are the registered proxy agent
            managing their account.
          </Text>
          <Section style={infoBox}>
            <Text style={infoLabel}>Amount</Text>
            <Text style={infoValue}>{currency} {fmt(amount)}</Text>
            <Text style={infoLabel}>On behalf of</Text>
            <Text style={infoValue}>{partner_name}</Text>
            <Text style={infoLabel}>Payout Type</Text>
            <Text style={infoValue}>{payout_kind}</Text>
            <Text style={infoLabel}>Reason</Text>
            <Text style={infoValue}>{reason}</Text>
            <Text style={infoLabel}>Reference</Text>
            <Text style={infoValue}>{transaction_id || '—'}</Text>
            <Text style={infoLabel}>Date</Text>
            <Text style={infoValue}>{date}</Text>
          </Section>
          <Text style={text}>
            You are responsible for handing this money over to the partner or
            using it strictly per the standing agreement. Every proxy movement
            is logged for audit.
          </Text>
          <Hr style={hr} />
          <Text style={footer}>Welile · Trusted rent & receipts for Uganda</Text>
        </Container>
      </Body>
    </Html>
  )
}

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
  component: ProxyManagedPayoutNoticeEmail,
  subject: 'Proxy payout received on behalf of your partner',
  displayName: 'Proxy Managed Payout Notice',
  previewData: {
    agent_name: 'Lilian Nakato',
    partner_name: 'Joseph Lukoda',
    amount: 150000,
    currency: 'UGX',
    transaction_id: 'ROI-A1B2C3D4-3',
    payout_kind: 'Monthly Returns',
    date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
    reason: 'Managed Proxy Account',
  },
} satisfies TemplateEntry