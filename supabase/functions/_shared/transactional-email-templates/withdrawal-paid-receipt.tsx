import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Link, Preview, Text, Section, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  recipient_name?: string
  amount?: string | number
  currency?: string
  payment_method?: string
  proof_label?: string
  proof_reference?: string
  new_balance?: string | number | null
  date?: string
  wallet_url?: string
  receipt_url?: string | null
  copy_for?: string | null
  commission_earned?: string | number | null
}

const fmt = (a: string | number | undefined | null, c: string) => {
  if (a === undefined || a === null || a === '') return `${c} 0`
  const n = typeof a === 'number' ? a : Number(String(a).replace(/,/g, ''))
  return Number.isFinite(n) ? `${c} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${c} ${a}`
}

const SITE_NAME = 'Welile'

export function WithdrawalPaidReceipt({
  recipient_name = 'there',
  amount = 0,
  currency = 'UGX',
  payment_method = 'your selected method',
  proof_label = 'Transaction ID',
  proof_reference = '',
  new_balance = null,
  date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  wallet_url = 'https://welileapp.com/ZQhyGb',
  receipt_url = null,
  copy_for = null,
  commission_earned = null,
}: Props) {
  const amt = fmt(amount, currency)
  const hasBalance = new_balance !== null && new_balance !== undefined && new_balance !== ''
  const hasReceipt = !!receipt_url
  const isCopy = !!copy_for
  const hasCommission = commission_earned !== null && commission_earned !== undefined && commission_earned !== ''
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{isCopy ? `Receipt copy — payout of ${amt}` : `Your withdrawal of ${amt} has been paid`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={{ padding: '32px 32px 8px 32px' }}>
            <Heading style={h1}>{isCopy ? 'Payout receipt (copy) ✅' : 'Withdrawal paid ✅'}</Heading>
            <Text style={lead}>Hi {recipient_name},</Text>
            {isCopy ? (
              <Text style={body}>
                Receipt copy for <strong>{copy_for}</strong> records. A withdrawal of{' '}
                <strong>{amt}</strong> was <strong>approved and paid</strong> via {payment_method}.
              </Text>
            ) : (
              <Text style={body}>
                Here is your proof of payment. Your withdrawal has been{' '}
                <strong>approved and paid</strong> via {payment_method}.
              </Text>
            )}
          </Section>
          <Section style={{ padding: '0 32px' }}>
            <Section style={amountCard}>
              <Text style={amountLabel}>Amount paid</Text>
              <Text style={amountValue}>{amt}</Text>
            </Section>
            <Section style={metaCard}>
              <Row label="Payment method" value={payment_method} />
              {proof_reference ? <Row label={proof_label} value={proof_reference} mono /> : null}
              <Row label="Date" value={date} />
              {hasBalance && !isCopy ? <Row label="New wallet balance" value={fmt(new_balance as any, currency)} /> : null}
              {hasCommission ? <Row label="Commission earned" value={fmt(commission_earned as any, currency)} /> : null}
            </Section>
          </Section>
          <Section style={{ padding: '24px 32px 8px 32px', textAlign: 'center' as const }}>
            {hasReceipt ? (
              <>
                <Button href={receipt_url as string} style={ctaBtn}>View &amp; download your receipt</Button>
                <Text style={{ margin: '12px 0 0 0', color: SUB, fontSize: '12px' }}>
                  Or open this link (no sign-in required):{' '}
                  <Link href={receipt_url as string} style={link}>{receipt_url}</Link>
                </Text>
              </>
            ) : (
              <Button href={wallet_url} style={ctaBtn}>Access your dashboard</Button>
            )}
          </Section>
          <Section style={{ padding: '16px 32px 32px 32px' }}>
            {isCopy ? (
              <Text style={fineprint}>
                This is an automated receipt copy for internal records. No action is required.
              </Text>
            ) : (
              <Text style={fineprint}>
                If you didn't request this withdrawal, please{' '}
                <Link href="https://welile.com/contact" style={link}>contact support</Link> immediately.
              </Text>
            )}
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
  component: WithdrawalPaidReceipt,
  subject: (d: Record<string, any>) => {
    const amt = fmt(d?.amount, d?.currency ?? 'UGX')
    return `Receipt: your withdrawal of ${amt} has been paid`
  },
  displayName: 'Withdrawal paid receipt',
  previewData: {
    recipient_name: 'Jane',
    amount: 50000,
    payment_method: 'Mobile Money (MTN)',
    proof_label: 'Mobile Money transaction ID',
    proof_reference: 'MP260628.1234.A56789',
    new_balance: 12000,
    receipt_url: 'https://welileapp.com/r/2eaa0cdc65f145d5a65cd755b7910d2f',
  },
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
