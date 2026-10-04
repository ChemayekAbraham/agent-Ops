import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface StandingOrderCreatedProps {
  recipient_name?: string
  amount?: string | number
  currency?: string
  schedule?: string
  reason?: string
  next_run?: string
  company_name?: string
}

const formatAmount = (amount: string | number | undefined, currency: string) => {
  if (amount === undefined || amount === null || amount === '') return `${currency} 0`
  const num = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, ''))
  if (Number.isNaN(num)) return `${currency} ${amount}`
  return `${currency} ${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const Email = ({
  recipient_name = 'there',
  amount = 0,
  currency = 'UGX',
  schedule = 'on a recurring basis',
  reason = '',
  next_run = '',
  company_name = 'Welile',
}: StandingOrderCreatedProps) => {
  const year = new Date().getFullYear()
  const formattedAmount = formatAmount(amount, currency)
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>A recurring payout of {formattedAmount} has been set up for you</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={card}>
            <Heading style={h1}>Recurring payout activated</Heading>
            <Text style={greeting}>Hi {recipient_name},</Text>
            <Text style={body}>
              {company_name} has set up an automatic recurring payout to your wallet. You don't need to do
              anything — the funds will land in your wallet on schedule and you'll get a notification each time.
            </Text>

            <Section style={amountBox}>
              <Text style={amountLabel}>Amount each time</Text>
              <Text style={amountValue}>{formattedAmount}</Text>
            </Section>

            <Section style={detailRow}>
              <Text style={detailKey}>Schedule</Text>
              <Text style={detailVal}>{schedule}</Text>
            </Section>
            {next_run ? (
              <Section style={detailRow}>
                <Text style={detailKey}>First payout</Text>
                <Text style={detailVal}>{next_run}</Text>
              </Section>
            ) : null}
            {reason ? (
              <Section style={detailRow}>
                <Text style={detailKey}>Purpose</Text>
                <Text style={detailVal}>{reason}</Text>
              </Section>
            ) : null}

            <Text style={body}>
              Log in any time to view and cash out your wallet at{' '}
              <Link href="https://welileapp.com" style={link}>welileapp.com</Link>.
            </Text>
          </Section>
          <Text style={footer}>© {year} {company_name} Technologies Ltd. This is an automated notification.</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: Email,
  subject: 'Your recurring payout has been set up',
  displayName: 'Standing Order Created',
  previewData: {
    recipient_name: 'Jane',
    amount: 50000,
    currency: 'UGX',
    schedule: 'Monthly on day 15',
    reason: 'Monthly support',
    next_run: '15 Jul 2026, 09:00',
  },
} satisfies TemplateEntry

const BRAND = '#7b19d4'
const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", margin: 0, padding: 0 }
const container: React.CSSProperties = { maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }
const accentBar: React.CSSProperties = { height: '6px', backgroundColor: BRAND, borderRadius: '6px 6px 0 0' }
const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: '28px 28px 8px 28px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 800, margin: '0 0 16px 0' }
const greeting: React.CSSProperties = { color: '#334155', fontSize: '15px', fontWeight: 600, margin: '0 0 8px 0' }
const body: React.CSSProperties = { color: '#475569', fontSize: '15px', lineHeight: '24px', margin: '0 0 18px 0' }
const amountBox: React.CSSProperties = { backgroundColor: '#fcf9ff', border: '1px solid #ecd9ff', borderRadius: '10px', padding: '20px', textAlign: 'center', margin: '0 0 18px 0' }
const amountLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', margin: '0 0 6px 0' }
const amountValue: React.CSSProperties = { color: BRAND, fontSize: '32px', fontWeight: 800, margin: 0 }
const detailRow: React.CSSProperties = { borderBottom: '1px dashed #e2e8f0', padding: '10px 0' }
const detailKey: React.CSSProperties = { color: '#64748b', fontSize: '12px', fontWeight: 600, margin: '0 0 2px 0' }
const detailVal: React.CSSProperties = { color: '#0f172a', fontSize: '14px', fontWeight: 600, margin: 0 }
const link: React.CSSProperties = { color: BRAND, fontWeight: 600 }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', textAlign: 'center', margin: '20px 0 0 0' }
