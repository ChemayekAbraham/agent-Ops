import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Img, Preview, Section, Text, Hr,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  amount?: string | number
  currency?: string
  started_on?: string
  ends_on?: string
}

const fmt = (a: string | number | undefined, c: string) => {
  const n = Number(String(a ?? 0).replace(/,/g, ''))
  return Number.isNaN(n) ? `${c} ${a}` : `${c} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const RedemptionNoticeStarted = ({
  partner_name = 'Partner',
  portfolio_name = 'Partnership Portfolio',
  portfolio_id = '',
  amount,
  currency = 'UGX',
  started_on = '',
  ends_on = '',
}: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your capital redemption is being processed — 90-day notice ends {ends_on}</Preview>
    <Body style={main}>
      <Container style={container}>
        <div style={accent} />
        <Section style={{ padding: '28px 32px 8px' }}>
          <Img src="https://welileapp.com/welile-logo.png" alt="Welile" width="120" />
        </Section>
        <Section style={{ padding: '8px 32px 24px' }}>
          <Heading style={h1}>Your redemption is now being processed</Heading>
          <Text style={p}>Dear {partner_name},</Text>
          <Text style={p}>
            Partner Operations has started processing your capital redemption request for{' '}
            <strong>{portfolio_name}{portfolio_id ? ` (#${portfolio_id})` : ''}</strong>
            {amount !== undefined && amount !== null && amount !== '' ? <> — {fmt(amount, currency)}</> : null}.
          </Text>
          <Section style={card}>
            <Text style={cardTitle}>Your 90-day notice period</Text>
            <Text style={row}>Started: <strong>{started_on || '—'}</strong></Text>
            <Text style={row}>Ends: <strong>{ends_on || '—'}</strong></Text>
          </Section>
          <Text style={p}>
            As set out in your partnership agreement, capital redemptions have a 90-day notice period.
            Your money is working inside real Rent Plans with tenants, so we collect it back safely over this time.
          </Text>
          <Text style={p}>
            • Your portfolio is now locked for this redemption.<br />
            • Your money will be paid to your registered payout channel on or before {ends_on || 'the end of the notice period'}.<br />
            • If it can be paid sooner, we will pay and let you know.<br />
            • You do not need to do anything else. Simply reply to this email if you have questions.
          </Text>
          <Hr style={{ borderColor: '#e5e7eb', margin: '24px 0' }} />
          <Text style={small}>Welile Technologies Limited · Partnerships Team</Text>
        </Section>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: RedemptionNoticeStarted,
  subject: (d: Record<string, any>) =>
    `Your redemption is being processed — 90-day notice ends ${d?.ends_on ?? ''}`.trim(),
  displayName: 'Redemption 90-day notice started',
  previewData: {
    partner_name: 'Amito Elizabeth',
    portfolio_name: 'Partnership Portfolio',
    portfolio_id: 'WIP2511095682',
    amount: 800000,
    currency: 'UGX',
    started_on: '13 Oct 2026',
    ends_on: '11 Jan 2027',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, Helvetica, sans-serif' }
const container = { maxWidth: '600px', margin: '0 auto', border: '1px solid #ede9fe', borderRadius: '12px', overflow: 'hidden' }
const accent = { height: '6px', backgroundColor: '#7c3aed' }
const h1 = { fontSize: '22px', color: '#1f2937', margin: '0 0 16px' }
const p = { fontSize: '15px', lineHeight: '24px', color: '#374151', margin: '0 0 14px' }
const card = { backgroundColor: '#f5f3ff', borderRadius: '10px', padding: '16px 20px', margin: '8px 0 18px' }
const cardTitle = { fontSize: '15px', fontWeight: 700, color: '#6d28d9', margin: '0 0 8px' }
const row = { fontSize: '15px', color: '#1f2937', margin: '0 0 4px' }
const small = { fontSize: '12px', color: '#6b7280', margin: 0 }
