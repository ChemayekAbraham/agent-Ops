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
 * New withdrawal request alert — sent to active Merchant (cash-out) Agents
 * the moment a user submits a withdrawal request, so they can claim and
 * process it from their dashboard.
 */
interface NewWithdrawalMerchantAlertProps {
  amountUgx?: number
  requesterName?: string
  requesterPhone?: string
  payoutMethod?: string
  requestReference?: string
  requestedAt?: string
}

const ugx = (n: number | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? `UGX ${Math.round(n).toLocaleString('en-UG')}`
    : 'UGX 0'

const methodLabel = (m: string | undefined): string => {
  switch ((m || '').toLowerCase()) {
    case 'mobile_money':
    case 'mtn_mobile_money':
    case 'airtel_money':
      return 'Mobile Money'
    case 'bank_transfer':
      return 'Bank Transfer'
    case 'cash':
    case 'cash_pickup':
      return 'Cash Pickup'
    default:
      return m || 'Cash Pickup'
  }
}

export function NewWithdrawalMerchantAlertEmail({
  amountUgx = 0,
  requesterName = 'A Welile user',
  requesterPhone = '',
  payoutMethod = 'cash',
  requestReference = 'PENDING',
  requestedAt = new Date().toISOString(),
}: NewWithdrawalMerchantAlertProps) {
  return (
    <Html>
      <Head />
      <Preview>
        New withdrawal to process · {ugx(amountUgx)} · {methodLabel(payoutMethod)}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>🔔 New Withdrawal Request</Heading>
          <Text style={text}>
            A user just requested a withdrawal. Open your Merchant Agent
            dashboard to claim and process it before another agent does.
          </Text>

          <Section style={amountBox}>
            <Text style={amountLabel}>Amount</Text>
            <Text style={amountValue}>{ugx(amountUgx)}</Text>
            <Text style={amountMethod}>{methodLabel(payoutMethod)}</Text>
          </Section>

          <Section style={infoBox}>
            <Text style={infoLabel}>Requested by</Text>
            <Text style={infoValue}>
              {requesterName}
              {requesterPhone ? ` · ${requesterPhone}` : ''}
            </Text>
            <Text style={infoLabel}>Reference</Text>
            <Text style={infoValue}>{requestReference}</Text>
            <Text style={infoLabel}>Requested at</Text>
            <Text style={infoValue}>{requestedAt}</Text>
          </Section>

          <Hr style={hr} />
          <Text style={footer}>
            First to claim wins. Process the payout from Merchant Agent →
            Pending Withdrawals and earn your commission on completion.
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
const amountBox: React.CSSProperties = {
  background: '#4c1d95',
  borderRadius: '12px',
  padding: '24px',
  textAlign: 'center',
  margin: '20px 0',
}
const amountLabel: React.CSSProperties = {
  color: '#c4b5fd',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  margin: '0 0 6px',
  fontWeight: 600,
}
const amountValue: React.CSSProperties = {
  color: '#ffffff',
  fontSize: '32px',
  fontWeight: 700,
  margin: '0 0 8px',
}
const amountMethod: React.CSSProperties = {
  color: '#ddd6fe',
  fontSize: '15px',
  fontWeight: 600,
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
  component: NewWithdrawalMerchantAlertEmail,
  subject: (data: Record<string, any>) =>
    `New withdrawal to process · ${ugx(Number(data?.amountUgx ?? 0))}`,
  displayName: 'New Withdrawal — Merchant Alert',
  previewData: {
    amountUgx: 50000,
    requesterName: 'Jane Doe',
    requesterPhone: '+256 7XX XXX XXX',
    payoutMethod: 'cash',
    requestReference: 'REQ-ABC123DEF456',
    requestedAt: new Date().toISOString(),
  },
} satisfies TemplateEntry
