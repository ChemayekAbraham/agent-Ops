import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Link, Preview, Text, Section,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  recipient_name?: string
  amount?: string | number
  currency?: string
  item_label?: string
  brand?: string
  model?: string
  daily_amount?: string | number | null
  repayment_starts_on?: string
  supplier_name?: string
  supplier_phone?: string
  supplier_email?: string
  order_reference?: string
  tracking_reference?: string
  disbursed_at?: string
}

const fmt = (a: string | number | undefined | null, c: string) => {
  if (a === undefined || a === null || a === '') return `${c} 0`
  const n = typeof a === 'number' ? a : Number(String(a).replace(/,/g, ''))
  return Number.isFinite(n) ? `${c} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${c} ${a}`
}

const SITE_NAME = 'Welile'

export function SmartphoneOrderDisbursed({
  recipient_name = 'there',
  amount = 0,
  currency = 'UGX',
  item_label = 'Welile Smartphone',
  brand = '',
  model = '',
  daily_amount = null,
  repayment_starts_on = '',
  supplier_name = '',
  supplier_phone = '',
  supplier_email = '',
  order_reference = '',
  tracking_reference = '',
  disbursed_at = '',
}: Props) {
  const amt = fmt(amount, currency)
  const device = [brand, model].filter(Boolean).join(' ') || item_label
  const isIphone = /iphone/i.test(brand)
  const hasDaily = daily_amount !== null && daily_amount !== undefined && daily_amount !== '' && Number(daily_amount) > 0
  const hasSupplier = Boolean(supplier_name || supplier_phone || supplier_email)
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{amt} paid to the supplier — your {device} order is in procedure</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={{ padding: '32px 32px 8px 32px' }}>
            <Heading style={h1}>Your order is in procedure</Heading>
            <Text style={lead}>Hi {recipient_name},</Text>
            <Text style={body}>
              Your <strong>{device}</strong> order has been fully approved and Welile has paid{' '}
              <strong>{amt}</strong> {isIphone ? 'as the down payment ' : ''}straight into the supplier's wallet.
              The supplier is now processing the handover of your device.
            </Text>
          </Section>
          <Section style={{ padding: '0 32px' }}>
            <Section style={amountCard}>
              <Text style={amountLabel}>Paid to the supplier's wallet</Text>
              <Text style={amountValue}>{amt}</Text>
            </Section>
            <Section style={metaCard}>
              <Row label="Device" value={device} />
              {hasDaily ? <Row label="Your daily repayment" value={fmt(daily_amount as any, currency)} /> : null}
              {repayment_starts_on ? <Row label="Daily repayment starts" value={repayment_starts_on} /> : null}
              {order_reference ? <Row label="Order reference" value={order_reference} mono /> : null}
              {tracking_reference ? <Row label="Tracking reference" value={tracking_reference} mono /> : null}
              {disbursed_at ? <Row label="Released on" value={disbursed_at} /> : null}
            </Section>
            {hasSupplier ? (
              <Section style={metaCard}>
                <Text style={sectionTitle}>Supplier contact — for tracking your device</Text>
                {supplier_name ? <Row label="Supplier" value={supplier_name} /> : null}
                {supplier_phone ? <Row label="Phone" value={supplier_phone} /> : null}
                {supplier_email ? <Row label="Email" value={supplier_email} /> : null}
              </Section>
            ) : null}
            {isIphone ? (
              <Text style={body}>
                Remember: the amount above is the minimum down payment required by Mo Banja. You repay
                Welile daily from your wallet or commission, and you pay Mo Banja weekly directly — that
                weekly payment is settled outside the Welile platform.
              </Text>
            ) : (
              <Text style={body}>
                Your daily repayment is recovered from your wallet or commission, exactly as shown on your
                order.
              </Text>
            )}
          </Section>
          <Section style={{ padding: '16px 32px 32px 32px' }}>
            <Text style={fineprint}>
              Questions about your order? <Link href="https://welile.com/contact" style={link}>Contact support</Link>.
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
  component: SmartphoneOrderDisbursed,
  subject: (d: Record<string, any>) => {
    const amt = fmt(d?.amount, d?.currency ?? 'UGX')
    return `${amt} paid to the supplier — your device order is in procedure`
  },
  displayName: 'Smartphone order disbursed to supplier',
  previewData: {
    recipient_name: 'Jane',
    amount: 550000,
    brand: 'Iphone',
    model: '11 Pro Max',
    daily_amount: 12000,
    repayment_starts_on: '16 September 2026',
    supplier_name: 'Mo Banja Kampala',
    supplier_phone: '+256700000000',
    supplier_email: 'supplier@example.com',
    order_reference: 'a1b2c3d4',
    disbursed_at: '09 September 2026, 13:20',
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
const body: React.CSSProperties = { margin: '16px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const amountCard: React.CSSProperties = { backgroundColor: '#fcf9ff', border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '24px', textAlign: 'center' as const }
const amountLabel: React.CSSProperties = { margin: '0 0 6px 0', color: SUB, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.5px' }
const amountValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-0.5px' }
const metaCard: React.CSSProperties = { marginTop: '16px', padding: '4px 16px', border: `1px solid ${BORDER}`, borderRadius: '12px' }
const sectionTitle: React.CSSProperties = { margin: '10px 0 2px 0', color: INK, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase' as const, letterSpacing: '1px' }
const rowKey: React.CSSProperties = { color: SUB, fontSize: '13px', fontWeight: 600, padding: '12px 0' }
const rowVal: React.CSSProperties = { color: INK, fontSize: '13px', fontWeight: 600, padding: '12px 0' }
const rowValMono: React.CSSProperties = { ...rowVal, fontFamily: "'Courier New', Courier, monospace" }
const fineprint: React.CSSProperties = { margin: 0, color: SUB, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const link: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 700 }
const footer: React.CSSProperties = { margin: '16px 0 0 0', color: '#94a3b8', fontSize: '11px', textAlign: 'center' as const }
