import * as React from 'npm:react@18.3.1'
import { Body, Head, Heading, Html, Img, Link, Preview, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  remaining?: string | number
  contract_amount?: string | number
  currency?: string
  dashboard_url?: string
  logo_url?: string
}

const fmt = (a: string | number | undefined, c: string) => {
  const n = typeof a === 'number' ? a : Number(String(a ?? 0).replace(/,/g, ''))
  return `${c} ${Number.isNaN(n) ? a : n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function SelfSupportUnallocated({
  partner_name = 'Supporter', remaining = 0, contract_amount = 0, currency = 'UGX',
  dashboard_url = 'https://welileapp.com/dashboard/funder',
  logo_url = 'https://welileapp.com/welile-logo.png',
}: Props) {
  const left = fmt(remaining, currency)
  return (
    <Html>
      <Head />
      <Preview>{`${left} of your partnership is waiting for you to choose who to support`}</Preview>
      <Body style={{ backgroundColor: '#f4f4f7', fontFamily: 'Arial, sans-serif', margin: 0, padding: '30px 10px' }}>
        <div style={{ maxWidth: 560, margin: '0 auto', background: '#ffffff', borderRadius: 8, padding: 32 }}>
          <Img src={logo_url} alt="Welile" width="130" />
          <Heading style={{ fontSize: 22, color: '#1a1a2e' }}>Choose the tenants or houses you support</Heading>
          <Text style={{ fontSize: 15, color: '#333' }}>Dear {partner_name},</Text>
          <Text style={{ fontSize: 15, color: '#333' }}>
            Your partnership of <strong>{fmt(contract_amount, currency)}</strong> is set up as self-support, so you choose
            the tenants or houses your money supports. <strong>{left}</strong> is still waiting for you to choose.
          </Text>
          <Text style={{ fontSize: 15, color: '#333' }}>
            Returns start on each tenant or house once Welile approves it. Open your dashboard to choose:
          </Text>
          <Text><Link href={dashboard_url} style={{ color: '#6d28d9', fontWeight: 'bold' }}>Open my dashboard</Link></Text>
          <Text style={{ fontSize: 13, color: '#777' }}>Thank you for being a Welile Supporter.</Text>
        </div>
      </Body>
    </Html>
  )
}

export const template = {
  component: SelfSupportUnallocated,
  subject: (d: Record<string, any>) => `${fmt(d?.remaining, d?.currency || 'UGX')} is waiting for you to choose who to support`,
  displayName: 'Self-support not yet allocated',
  previewData: { partner_name: 'Sarah Nakato', remaining: 2000000, contract_amount: 5000000, currency: 'UGX' },
} satisfies TemplateEntry
