import * as React from 'npm:react@18.3.1'
import { Body, Head, Heading, Html, Img, Preview, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  portfolio_code?: string
  amount?: string | number
  paid_date?: string
  currency?: string
  logo_url?: string
}

const fmt = (a: string | number | undefined, c: string) => {
  const n = typeof a === 'number' ? a : Number(String(a ?? 0).replace(/,/g, ''))
  return `${c} ${Number.isNaN(n) ? a : n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function RedemptionPaid({
  partner_name = 'Supporter', portfolio_code = '', amount = 0, paid_date = '',
  currency = 'UGX', logo_url = 'https://welileapp.com/welile-logo.png',
}: Props) {
  const amt = fmt(amount, currency)
  return (
    <Html>
      <Head />
      <Preview>{`Your redemption of ${amt} has been paid to your wallet`}</Preview>
      <Body style={{ backgroundColor: '#f4f4f7', fontFamily: 'Arial, sans-serif', margin: 0, padding: '30px 10px' }}>
        <div style={{ maxWidth: 560, margin: '0 auto', background: '#ffffff', borderRadius: 8, padding: 32 }}>
          <Img src={logo_url} alt="Welile" width="130" />
          <Heading style={{ fontSize: 22, color: '#1a1a2e' }}>Your redemption has been paid</Heading>
          <Text style={{ fontSize: 15, color: '#333' }}>Dear {partner_name},</Text>
          <Text style={{ fontSize: 15, color: '#333' }}>
            Your redemption of <strong>{amt}</strong>{portfolio_code ? <> from portfolio <strong>{portfolio_code}</strong></> : null} has
            been approved and paid into your Welile wallet{paid_date ? ` on ${paid_date}` : ''}. The money is available to withdraw now.
          </Text>
          <Text style={{ fontSize: 13, color: '#777' }}>Thank you for being a Welile Supporter.</Text>
        </div>
      </Body>
    </Html>
  )
}

export const template = {
  component: RedemptionPaid,
  subject: (d: Record<string, any>) => `Your redemption of ${fmt(d?.amount, d?.currency || 'UGX')} has been paid`,
  displayName: 'Redemption paid',
  previewData: { partner_name: 'Sarah Nakato', portfolio_code: 'WPF-1234', amount: 1000000, paid_date: '2 October 2026', currency: 'UGX' },
} satisfies TemplateEntry
