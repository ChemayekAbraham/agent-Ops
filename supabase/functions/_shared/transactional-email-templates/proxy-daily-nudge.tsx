import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface ProxyDailyNudgeProps {
  recipient_name?: string
  slot_label?: string
  notes_today?: number
  daily_min?: number
  notes_month?: number
  monthly_note_target?: number
  available_income?: number
  app_url?: string
}

const ugx = (n: number) => `UGX ${Math.round(n || 0).toLocaleString('en-US')}`

export function ProxyDailyNudgeEmail({
  recipient_name = 'there',
  slot_label = 'Morning',
  notes_today = 0,
  daily_min = 10,
  notes_month = 0,
  monthly_note_target = 1200,
  available_income = 2000000,
  app_url = 'https://welileapp.com/agent/proxy-agents',
}: ProxyDailyNudgeProps) {
  const remaining = Math.max(daily_min - notes_today, 0)
  return (
    <Html>
      <Head />
      <Preview>{`${slot_label}: ${remaining} more promissory notes to hit today's minimum`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{slot_label} push — record a promissory note</Heading>
          <Text style={text}>Dear {recipient_name},</Text>
          <Text style={text}>
            Somewhere near you right now there is someone willing to support a tenant who needs rent.
            Your job today is to find that person and record their commitment as a{' '}
            <strong>promissory note</strong> — a written promise from someone who wants to become a Welile partner.
          </Text>

          <Section style={infoBox}>
            <Text style={infoLabel}>Why they will say yes</Text>
            <Text style={bullet}>• They earn 15% of the rent they contribute, every month.</Text>
            <Text style={bullet}>• Their money supports a real tenant in a real house, not an idea.</Text>
            <Text style={bullet}>• A promissory note costs them nothing today — it is a commitment, not a payment.</Text>
          </Section>

          <Section style={statBox}>
            <Text style={infoLabel}>Where you stand</Text>
            <Text style={bullet}>• Notes recorded today: <strong>{notes_today}</strong> of a {daily_min}-note daily minimum</Text>
            <Text style={bullet}>• This month: <strong>{notes_month}</strong> of {monthly_note_target}</Text>
            <Text style={bullet}>• Income available to you this month: <strong>{ugx(available_income)}</strong></Text>
            {remaining > 0
              ? <Text style={bullet}>• {remaining} more note{remaining === 1 ? '' : 's'} clears today's minimum.</Text>
              : <Text style={bullet}>• Today's minimum is cleared — every extra note grows your reward.</Text>}
          </Section>

          <Button href={app_url} style={button}>Record a promissory note</Button>

          <Text style={small}>
            Your target resets on the 1st of every month, so notes recorded today count for this month only.
          </Text>

          <Hr style={hr} />
          <Text style={footer}>Welile · You receive this because you accepted Target Mode as a Proxy Agent.</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#f8fafc', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' }
const infoBox: React.CSSProperties = { backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const statBox: React.CSSProperties = { backgroundColor: '#ecfdf5', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const infoLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px', fontWeight: 600 }
const bullet: React.CSSProperties = { color: '#0f172a', fontSize: '14px', lineHeight: '22px', margin: '0 0 6px' }
const button: React.CSSProperties = { backgroundColor: '#16a34a', color: '#ffffff', borderRadius: '8px', padding: '12px 20px', fontSize: '14px', fontWeight: 600, textDecoration: 'none', display: 'inline-block' }
const small: React.CSSProperties = { color: '#64748b', fontSize: '12px', lineHeight: '20px', margin: '18px 0 0' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }

export const template: TemplateEntry = {
  component: ProxyDailyNudgeEmail,
  subject: (d: Record<string, any>) =>
    `${d?.slot_label ?? 'Daily'} push: record a promissory note today`,
  displayName: 'Proxy Agent Daily Nudge',
  previewData: {
    recipient_name: 'Timothy Kalyango',
    slot_label: 'Morning',
    notes_today: 3,
    daily_min: 10,
    notes_month: 84,
    monthly_note_target: 1200,
    available_income: 1780000,
    app_url: 'https://welileapp.com/agent/proxy-agents',
  },
}
