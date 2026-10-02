import * as React from 'npm:react@18.3.1'
import { Body, Container, Head, Heading, Html, Img, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  portfolio_id?: string
  amount?: string | number
  paid_date?: string
}

const fmt = (a: string | number | undefined) => {
  const n = typeof a === 'number' ? a : Number(String(a ?? 0).replace(/,/g, ''))
  return `UGX ${Number.isNaN(n) ? a : n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const RedemptionPaid = ({ partner_name = 'Partner', portfolio_id = '', amount = 0, paid_date = '' }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`Your redemption of ${fmt(amount)} has been paid to your Welile wallet`}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Img src="https://welileapp.com/welile-logo.png" alt="Welile" width="120" style={{ marginBottom: '24px' }} />
        <Heading style={h1}>Your redemption has been paid</Heading>
        <Text style={text}>Dear {partner_name},</Text>
        <Text style={text}>
          Your capital redemption has been approved and the full principal has been credited to your
          Welile wallet. You can withdraw it from your wallet at any time.
        </Text>
        <Section style={card}>
          <Text style={label}>Amount paid</Text>
          <Text style={value}>{fmt(amount)}</Text>
          <Text style={label}>Portfolio</Text>
          <Text style={sub}>{portfolio_id ? `#${portfolio_id}` : '—'}</Text>
          <Text style={label}>Paid on</Text>
          <Text style={sub}>{paid_date || '—'}</Text>
        </Section>
        <Text style={text}>This portfolio is now closed. Thank you for being a Welile Supporter.</Text>
        <Text style={text}>Warm regards,<br />Partnership Team</Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: RedemptionPaid,
  subject: (d: Record<string, any>) => `Redemption paid — ${fmt(d?.amount)} credited to your wallet`,
  displayName: 'Redemption paid to wallet',
  previewData: { partner_name: 'Sarah Nakato', portfolio_id: 'WIP2604024329', amount: 9818988, paid_date: '2 October 2026' },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px 28px', maxWidth: '560px' }
const h1 = { color: '#0f172a', fontSize: '22px', fontWeight: 800, margin: '0 0 16px' }
const text = { color: '#475569', fontSize: '15px', lineHeight: '24px', margin: '0 0 14px' }
const card = { border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px 20px', margin: '8px 0 18px' }
const label = { color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase' as const, margin: '8px 0 2px' }
const value = { color: '#7b19d4', fontSize: '22px', fontWeight: 800, margin: 0 }
const sub = { color: '#0f172a', fontSize: '15px', fontWeight: 600, margin: 0 }
