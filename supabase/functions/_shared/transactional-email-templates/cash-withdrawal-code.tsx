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
 * Cash withdrawal pickup code — sent at REQUEST time to the central
 * Financial Ops inbox (weliletenants@gmail.com). The code is reserved
 * against the pending withdrawal row in the approval queue so FinOps
 * can match the email against the pending request and auto-verify
 * before disbursing cash.
 *
 * The subject line is deliberately prefixed with "MONEY OUT" so the
 * Gmail transactions panel surfaces it alongside the other outgoing
 * payouts (MTN / Airtel / Equity).
 */
interface CashWithdrawalCodeProps {
  payoutCode?: string
  amountUgx?: number
  userName?: string
  userPhone?: string
  requestReference?: string
  agentLocation?: string
  requestedAt?: string
}

const ugx = (n: number | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? `UGX ${Math.round(n).toLocaleString('en-UG')}`
    : 'UGX 0'

export function CashWithdrawalCodeEmail({
  payoutCode = 'WPO-XXXXX',
  amountUgx = 0,
  userName = 'Welile user',
  userPhone = '',
  requestReference = 'PENDING',
  agentLocation = 'Nearest Agent',
  requestedAt = new Date().toISOString(),
}: CashWithdrawalCodeProps) {
  return (
    <Html>
      <Head />
      <Preview>
        MONEY OUT · Cash pickup code {payoutCode} · {ugx(amountUgx)}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>💵 Cash Withdrawal Reserved</Heading>
          <Text style={text}>
            A new cash withdrawal has been reserved against pending requests.
            Use the pickup code below to verify the requester before disbursing
            cash.
          </Text>

          <Section style={codeBox}>
            <Text style={codeLabel}>Pickup code</Text>
            <Text style={codeValue}>{payoutCode}</Text>
            <Text style={codeAmount}>{ugx(amountUgx)}</Text>
          </Section>

          <Section style={infoBox}>
            <Text style={infoLabel}>Requested by</Text>
            <Text style={infoValue}>
              {userName}
              {userPhone ? ` · ${userPhone}` : ''}
            </Text>
            <Text style={infoLabel}>Reference</Text>
            <Text style={infoValue}>{requestReference}</Text>
            <Text style={infoLabel}>Pickup location</Text>
            <Text style={infoValue}>{agentLocation}</Text>
            <Text style={infoLabel}>Requested at</Text>
            <Text style={infoValue}>{requestedAt}</Text>
          </Section>

          <Hr style={hr} />
          <Text style={footer}>
            The code must match exactly what the requester presents on their
            screen before cash is handed over. After payout, mark the request
            approved in Financial Ops → Pending Withdrawals.
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
const codeBox: React.CSSProperties = {
  background: '#0f172a',
  borderRadius: '12px',
  padding: '24px',
  textAlign: 'center',
  margin: '20px 0',
}
const codeLabel: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  margin: '0 0 6px',
  fontWeight: 600,
}
const codeValue: React.CSSProperties = {
  color: '#fde68a',
  fontSize: '32px',
  letterSpacing: '0.18em',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontWeight: 700,
  margin: '0 0 8px',
}
const codeAmount: React.CSSProperties = {
  color: '#ffffff',
  fontSize: '18px',
  fontWeight: 700,
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
  component: CashWithdrawalCodeEmail,
  subject: (data: Record<string, any>) =>
    `MONEY OUT · Cash code ${data?.payoutCode ?? 'WPO-?????'} · ${ugx(
      Number(data?.amountUgx ?? 0),
    )}`,
  displayName: 'Cash Withdrawal Pickup Code',
  // Always route to the Financial Ops inbox — the same address that the
  // Gmail transactions panel polls.
  to: 'weliletenants@gmail.com',
  previewData: {
    payoutCode: 'WPO-AB12C',
    amountUgx: 50000,
    userName: 'Jane Doe',
    userPhone: '+256 7XX XXX XXX',
    requestReference: 'REQ-ABC123DEF456',
    agentLocation: 'Kampala Central',
    requestedAt: new Date().toISOString(),
  },
} satisfies TemplateEntry