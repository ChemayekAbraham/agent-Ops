import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Link, Preview, Text, Section, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  recipient_name?: string
  sender_name?: string
  amount?: string | number
  currency?: string
  reference?: string
  date?: string
  description?: string
  wallet_url?: string
  advance_increase?: number
  advance_total?: number
  advance_min?: number
  advance_max?: number
}

const fmt = (a: string | number | undefined, c: string) => {
  if (a === undefined || a === null || a === '') return `${c} 0`
  const n = typeof a === 'number' ? a : Number(String(a).replace(/,/g, ''))
  return Number.isFinite(n) ? `${c} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${c} ${a}`
}

const SITE_NAME = 'Welile'

export function WalletTransferReceived({
  recipient_name = 'there',
  sender_name = 'A Welile user',
  amount = 0,
  currency = 'UGX',
  reference = '',
  date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  description = '',
  wallet_url = 'https://welileapp.com/dashboard/tenant',
  advance_increase,
  advance_total,
  advance_min = 30000,
  advance_max = 30000000,
}: Props) {
  const amt = fmt(amount, currency)
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>You received {amt} from {sender_name}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={{ padding: '32px 32px 8px 32px' }}>
            <Heading style={h1}>You received money</Heading>
            <Text style={lead}>Hi {recipient_name},</Text>
            <Text style={body}>
              <strong>{sender_name}</strong> just sent money to your {SITE_NAME} wallet.
            </Text>
          </Section>
          <Section style={{ padding: '0 32px' }}>
            <Section style={amountCard}>
              <Text style={amountLabel}>Amount received</Text>
              <Text style={amountValue}>{amt}</Text>
            </Section>
            <Section style={metaCard}>
              <Row label="From" value={sender_name} />
              <Row label="Date" value={date} />
              {reference ? <Row label="Reference" value={reference} mono /> : null}
              {description ? <Row label="Note" value={description} /> : null}
            </Section>
          </Section>
          {typeof advance_increase === 'number' && advance_increase > 0 ? (
            <Section style={{ padding: '16px 32px 0 32px' }}>
              <Section style={amountCard}>
                <Text style={amountLabel}>Your Shopping Advance access limit</Text>
                <Text style={amountValue}>{fmt(advance_total ?? advance_increase, currency)}</Text>
                <Text style={body}>
                  This transfer increased your access limit by <strong>{fmt(advance_increase, currency)}</strong> —
                  2× the {amt} you received. Every time someone sends to you, your limit grows by 2× the amount.
                </Text>
                <Text style={fineprint}>
                  Every Welile user can access a Shopping Advance from a minimum of {fmt(advance_min, currency)} up to a maximum of {fmt(advance_max, currency)}.
                </Text>
              </Section>
            </Section>
          ) : null}
          <Section style={{ padding: '24px 32px 8px 32px', textAlign: 'center' as const }}>
            <Button href={wallet_url} style={ctaBtn}>Tap here to view your wallet balance</Button>
          </Section>
          <Section style={{ padding: '16px 32px 32px 32px' }}>
            <Text style={fineprint}>
              If you don't recognize this transfer, please{' '}
              <Link href="https://welile.com/contact" style={link}>contact support</Link> immediately.
            </Text>
          </Section>
        </Container>
        <Text style={footer}>© {new Date().getFullYear()} {SITE_NAME}. All rights reserved.</Text>
      </Body>
    </Html>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <table width="100%" cellPadding={0} cellSpacing={0} role="presentation" style={{ borderBottom: `1px dashed ${BORDER}` }}>
      <tbody><tr>
        <td style={rowKey}>{label}</td>
        <td align="right" style={mono ? rowValMono : rowVal}>{value}</td>
      </tr></tbody>
    </table>
  )
}

export const template = {
  component: WalletTransferReceived,
  subject: (d: Record<string, any>) => {
    const amt = fmt(d?.amount, d?.currency ?? 'UGX')
    const from = d?.sender_name ? ` from ${d.sender_name}` : ''
    return `You received ${amt}${from}`
  },
  displayName: 'Wallet transfer received',
  previewData: { recipient_name: 'Jane', sender_name: 'John Doe', amount: 25000, reference: 'WT-AB12CD34', description: 'Lunch money', advance_increase: 50000, advance_total: 80000 },
} satisfies TemplateEntry

const BRAND = '#7b19d4'
const INK = '#0f172a'
const BODY = '#475569'
const SUB = '#64748b'
const BORDER = '#e2e8f0'

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", margin: 0, padding: '24px 12px' }
const container: React.CSSProperties = { maxWidth: '560px', margin: '0 auto', backgroundColor: '#ffffff', border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' }
const accentBar: React.CSSProperties = { height: '6px', backgroundColor: BRAND }
const h1: React.CSSProperties = { margin: '0 0 12px 0', color: INK, fontSize: '24px', fontWeight: 800 }
const lead: React.CSSProperties = { margin: '0 0 8px 0', color: SUB, fontSize: '15px' }
const body: React.CSSProperties = { margin: '0 0 16px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const amountCard: React.CSSProperties = { backgroundColor: '#fcf9ff', border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '24px', textAlign: 'center' as const }
const amountLabel: React.CSSProperties = { margin: '0 0 6px 0', color: SUB, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.5px' }
const amountValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-0.5px' }
const metaCard: React.CSSProperties = { marginTop: '16px', padding: '4px 16px', border: `1px solid ${BORDER}`, borderRadius: '12px' }
const rowKey: React.CSSProperties = { color: SUB, fontSize: '13px', fontWeight: 600, padding: '12px 0' }
const rowVal: React.CSSProperties = { color: INK, fontSize: '13px', fontWeight: 600, padding: '12px 0' }
const rowValMono: React.CSSProperties = { ...rowVal, fontFamily: "'Courier New', Courier, monospace" }
const ctaBtn: React.CSSProperties = { backgroundColor: BRAND, color: '#ffffff', padding: '14px 24px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, textDecoration: 'none', display: 'inline-block' }
const fineprint: React.CSSProperties = { margin: 0, color: SUB, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const link: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 700 }
const footer: React.CSSProperties = { margin: '16px 0 0 0', color: '#94a3b8', fontSize: '11px', textAlign: 'center' as const }