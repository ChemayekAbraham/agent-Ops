import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Link, Preview, Text, Section, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface OverdueTenant {
  name?: string
  phone?: string
  arrears?: string | number
  days_behind?: number
}

interface Props {
  agent_name?: string
  tenants?: OverdueTenant[]
  tenants_behind?: number
  arrears_total?: string | number
  dashboard_url?: string
}

const fmt = (a: string | number | undefined) => {
  if (a === undefined || a === null || a === '') return 'UGX 0'
  const n = typeof a === 'number' ? a : Number(String(a).replace(/,/g, ''))
  return Number.isFinite(n) ? `UGX ${Math.round(n).toLocaleString('en-US')}` : `UGX ${a}`
}

const SITE_NAME = 'Welile'

export function AgentOverdueCallDrive({
  agent_name = 'there',
  tenants = [],
  tenants_behind = 0,
  arrears_total = 0,
  dashboard_url = 'https://welileapp.com/dashboard/agent',
}: Props) {
  const count = tenants_behind || tenants.length
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Call {count} tenant{count === 1 ? '' : 's'} now — {fmt(arrears_total)} is overdue</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={{ padding: '32px 32px 8px 32px' }}>
            <Heading style={h1}>{agent_name}, call these tenants today</Heading>
            <Text style={body}>
              {count} of your tenants are behind on rent. Tap a number below to call
              them right now and ask them to pay today. Do not wait — every day
              you leave it, the amount grows and your rating drops.
            </Text>
          </Section>

          <Section style={{ padding: '0 32px' }}>
            <Section style={amountCard}>
              <Text style={amountLabel}>Overdue right now</Text>
              <Text style={amountValue}>{fmt(arrears_total)}</Text>
              <Text style={amountSub}>{count} tenant{count === 1 ? '' : 's'} to call today</Text>
            </Section>
          </Section>

          <Section style={{ padding: '20px 32px 0 32px' }}>
            <Text style={sectionTitle}>Tap a number to call</Text>
            <Section style={metaCard}>
              {tenants.map((t, i) => (
                <table key={i} width="100%" cellPadding={0} cellSpacing={0} role="presentation"
                  style={{ borderBottom: i === tenants.length - 1 ? 'none' : `1px dashed ${BORDER}` }}>
                  <tbody><tr>
                    <td style={rowKey}>
                      {t.name || 'Tenant'}
                      <br />
                      {t.phone
                        ? <Link href={`tel:${t.phone}`} style={phoneLink}>{t.phone} — call now</Link>
                        : <span style={{ color: SUB }}>No number on file</span>}
                    </td>
                    <td align="right" style={rowVal}>
                      {fmt(t.arrears)}
                      <br />
                      <span style={{ color: SUB, fontWeight: 600 }}>
                        {t.days_behind || 0} day{(t.days_behind || 0) === 1 ? '' : 's'} behind
                      </span>
                    </td>
                  </tr></tbody>
                </table>
              ))}
            </Section>
          </Section>

          <Section style={{ padding: '24px 32px 8px 32px', textAlign: 'center' as const }}>
            <Button href={dashboard_url} style={ctaBtn}>Open my list and start calling</Button>
          </Section>

          <Section style={{ padding: '8px 32px 32px 32px' }}>
            <Text style={fineprint}>
              This list stops arriving as soon as your tenants are paid up.
            </Text>
          </Section>
        </Container>
        <Text style={footer}>© {new Date().getFullYear()} {SITE_NAME}</Text>
      </Body>
    </Html>
  )
}

export const template = {
  component: AgentOverdueCallDrive,
  subject: (d: Record<string, any>) => {
    const n = Number(d?.tenants_behind) || (Array.isArray(d?.tenants) ? d.tenants.length : 0)
    return `Call ${n} tenant${n === 1 ? '' : 's'} now — ${fmt(d?.arrears_total)} overdue`
  },
  displayName: 'Agent overdue tenant call drive',
  previewData: {
    agent_name: 'Sarah',
    tenants_behind: 2,
    arrears_total: 180000,
    tenants: [
      { name: 'James Okello', phone: '+256700000001', arrears: 120000, days_behind: 6 },
      { name: 'Grace Nabwire', phone: '+256700000002', arrears: 60000, days_behind: 3 },
    ],
  },
} satisfies TemplateEntry

const BRAND = '#dc2626'
const INK = '#0f172a'
const BODY = '#475569'
const SUB = '#64748b'
const BORDER = '#e2e8f0'

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", margin: 0, padding: '24px 12px' }
const container: React.CSSProperties = { maxWidth: '580px', margin: '0 auto', backgroundColor: '#ffffff', border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' }
const accentBar: React.CSSProperties = { height: '6px', backgroundColor: BRAND }
const h1: React.CSSProperties = { margin: '0 0 6px 0', color: INK, fontSize: '24px', fontWeight: 800 }
const body: React.CSSProperties = { margin: '0 0 16px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const sectionTitle: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.6px' }
const amountCard: React.CSSProperties = { backgroundColor: '#fef2f2', border: `1px solid ${BORDER}`, borderRadius: '12px', padding: '24px', textAlign: 'center' as const }
const amountLabel: React.CSSProperties = { margin: '0 0 6px 0', color: SUB, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.5px' }
const amountValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '34px', fontWeight: 800, letterSpacing: '-0.5px' }
const amountSub: React.CSSProperties = { margin: '8px 0 0 0', color: BODY, fontSize: '13px' }
const metaCard: React.CSSProperties = { padding: '4px 16px', border: `1px solid ${BORDER}`, borderRadius: '12px' }
const rowKey: React.CSSProperties = { color: INK, fontSize: '13px', fontWeight: 700, padding: '12px 0', verticalAlign: 'top' as const }
const rowVal: React.CSSProperties = { color: INK, fontSize: '13px', fontWeight: 700, padding: '12px 0', verticalAlign: 'top' as const }
const phoneLink: React.CSSProperties = { color: BRAND, fontSize: '15px', fontWeight: 800, textDecoration: 'underline' }
const ctaBtn: React.CSSProperties = { backgroundColor: BRAND, color: '#ffffff', padding: '14px 24px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, textDecoration: 'none', display: 'inline-block' }
const fineprint: React.CSSProperties = { color: SUB, fontSize: '12px', lineHeight: '18px', margin: 0 }
const footer: React.CSSProperties = { textAlign: 'center' as const, color: SUB, fontSize: '12px', marginTop: '16px' }
