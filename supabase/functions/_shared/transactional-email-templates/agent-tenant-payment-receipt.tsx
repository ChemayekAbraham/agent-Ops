import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Link, Preview, Text, Section, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  agent_name?: string
  tenant_name?: string
  amount?: string | number
  commission?: string | number
  date?: string
  // Wallet (capacity)
  float_left?: string | number
  withdrawable?: string | number
  advance_owed?: string | number
  // Today's report
  collected_today?: string | number
  expected_today?: string | number
  rate_today?: number
  tenants_paid?: number
  tenants_still_owing?: number
  // This tenant
  remaining_for_tenant?: string | number
  daily_for_tenant?: string | number
  dashboard_url?: string
}

const fmt = (a: string | number | undefined) => {
  if (a === undefined || a === null || a === '') return 'UGX 0'
  const n = typeof a === 'number' ? a : Number(String(a).replace(/,/g, ''))
  return Number.isFinite(n) ? `UGX ${Math.round(n).toLocaleString('en-US')}` : `UGX ${a}`
}

const SITE_NAME = 'Welile'

export function AgentTenantPaymentReceipt({
  agent_name = 'there',
  tenant_name = 'your tenant',
  amount = 0,
  commission = 0,
  date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  float_left = 0,
  withdrawable = 0,
  advance_owed = 0,
  collected_today = 0,
  expected_today = 0,
  rate_today = 0,
  tenants_paid = 0,
  tenants_still_owing = 0,
  remaining_for_tenant = 0,
  daily_for_tenant = 0,
  dashboard_url = 'https://welileapp.com/dashboard/agent',
}: Props) {
  const amt = fmt(amount)
  const com = fmt(commission)
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>You paid {amt} for {tenant_name}. You earned {com}.</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={{ padding: '32px 32px 8px 32px' }}>
            <Heading style={h1}>Good job, {agent_name}!</Heading>
            <Text style={lead}>{date}</Text>
            <Text style={body}>
              You just paid rent for <strong>{tenant_name}</strong>. Here is a short report
              and where your money stands right now. Keep this email — it is your proof.
            </Text>
          </Section>

          <Section style={{ padding: '0 32px' }}>
            <Section style={amountCard}>
              <Text style={amountLabel}>You paid for this tenant</Text>
              <Text style={amountValue}>{amt}</Text>
              <Text style={amountSub}>You earned {com} commission on this payment.</Text>
            </Section>
          </Section>

          <Section style={{ padding: '20px 32px 0 32px' }}>
            <Text style={sectionTitle}>This tenant ({tenant_name})</Text>
            <Section style={metaCard}>
              <Row label="Paid just now" value={amt} />
              <Row label="Still to clear" value={fmt(remaining_for_tenant)} />
              <Row label="Daily target" value={fmt(daily_for_tenant)} last />
            </Section>
          </Section>

          <Section style={{ padding: '20px 32px 0 32px' }}>
            <Text style={sectionTitle}>Your day so far ({date})</Text>
            <Section style={metaCard}>
              <Row label="Collected today" value={fmt(collected_today)} />
              <Row label="Today's target" value={fmt(expected_today)} />
              <Row label="How well you are doing" value={`${Math.max(0, Math.min(100, Math.round(rate_today)))}%`} />
              <Row label="Tenants you paid today" value={String(tenants_paid)} />
              <Row label="Tenants still to pay" value={String(tenants_still_owing)} last />
            </Section>
          </Section>

          <Section style={{ padding: '20px 32px 0 32px' }}>
            <Text style={sectionTitle}>What is in your wallet now</Text>
            <Section style={metaCard}>
              <Row
                label="Float left (company money for paying tenants)"
                value={fmt(float_left)}
              />
              <Row
                label="Your own money you can withdraw"
                value={fmt(withdrawable)}
              />
              <Row
                label="Advance you still owe Welile"
                value={fmt(advance_owed)}
                last
              />
            </Section>
            <Text style={hint}>
              "Float" is Welile's money you use to pay rent for tenants. "Withdrawable" is your own
              money (commission + bonuses) — you can cash it out any time.
            </Text>
          </Section>

          <Section style={{ padding: '24px 32px 8px 32px', textAlign: 'center' as const }}>
            <Button href={dashboard_url} style={ctaBtn}>Open my agent dashboard</Button>
          </Section>

          <Section style={{ padding: '8px 32px 32px 32px' }}>
            <Text style={fineprint}>
              If something here looks wrong, reply to this email or{' '}
              <Link href="https://welile.com/contact" style={link}>contact support</Link> right away.
            </Text>
          </Section>
        </Container>
        <Text style={footer}>© {new Date().getFullYear()} {SITE_NAME}. Asante kwa kazi nzuri.</Text>
      </Body>
    </Html>
  )
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <table width="100%" cellPadding={0} cellSpacing={0} role="presentation"
      style={{ borderBottom: last ? 'none' : `1px dashed ${BORDER}` }}>
      <tbody><tr>
        <td style={rowKey}>{label}</td>
        <td align="right" style={rowVal}>{value}</td>
      </tr></tbody>
    </table>
  )
}

export const template = {
  component: AgentTenantPaymentReceipt,
  subject: (d: Record<string, any>) => {
    const amt = fmt(d?.amount)
    const t = d?.tenant_name ? ` for ${d.tenant_name}` : ''
    return `You paid ${amt}${t} — your report & capacity`
  },
  displayName: 'Agent tenant payment receipt',
  previewData: {
    agent_name: 'Sarah',
    tenant_name: 'James Okello',
    amount: 150000,
    commission: 15000,
    float_left: 850000,
    withdrawable: 42000,
    advance_owed: 0,
    collected_today: 450000,
    expected_today: 600000,
    rate_today: 75,
    tenants_paid: 3,
    tenants_still_owing: 2,
    remaining_for_tenant: 300000,
    daily_for_tenant: 15000,
  },
} satisfies TemplateEntry

const BRAND = '#7b19d4'
const INK = '#0f172a'
const BODY = '#475569'
const SUB = '#64748b'
const BORDER = '#e2e8f0'

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", margin: 0, padding: '24px 12px' }
const container: React.CSSProperties = { maxWidth: '580px', margin: '0 auto', backgroundColor: '#ffffff', border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' }
const accentBar: React.CSSProperties = { height: '6px', backgroundColor: BRAND }
const h1: React.CSSProperties = { margin: '0 0 6px 0', color: INK, fontSize: '24px', fontWeight: 800 }
const lead: React.CSSProperties = { margin: '0 0 12px 0', color: SUB, fontSize: '13px' }
const body: React.CSSProperties = { margin: '0 0 16px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const sectionTitle: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.6px' }
const amountCard: React.CSSProperties = { backgroundColor: '#fcf9ff', border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '24px', textAlign: 'center' as const }
const amountLabel: React.CSSProperties = { margin: '0 0 6px 0', color: SUB, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.5px' }
const amountValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-0.5px' }
const amountSub: React.CSSProperties = { margin: '8px 0 0 0', color: BODY, fontSize: '13px' }
const metaCard: React.CSSProperties = { padding: '4px 16px', border: `1px solid ${BORDER}`, borderRadius: '12px' }
const rowKey: React.CSSProperties = { color: SUB, fontSize: '13px', fontWeight: 600, padding: '12px 0', verticalAlign: 'top' as const }
const rowVal: React.CSSProperties = { color: INK, fontSize: '13px', fontWeight: 700, padding: '12px 0', verticalAlign: 'top' as const }
const hint: React.CSSProperties = { margin: '10px 2px 0 2px', color: SUB, fontSize: '12px', lineHeight: '18px' }
const ctaBtn: React.CSSProperties = { backgroundColor: BRAND, color: '#ffffff', padding: '14px 24px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, textDecoration: 'none', display: 'inline-block' }
const fineprint: React.CSSProperties = { color: SUB, fontSize: '12px', lineHeight: '18px', margin: 0 }
const link: React.CSSProperties = { color: BRAND, textDecoration: 'underline' }
const footer: React.CSSProperties = { textAlign: 'center' as const, color: SUB, fontSize: '12px', marginTop: '16px' }