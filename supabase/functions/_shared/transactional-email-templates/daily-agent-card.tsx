import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

type BadgeTone = 'gold' | 'green' | 'blue' | 'amber'

interface CardBadge {
  icon: string
  label: string
  tone: BadgeTone
}

interface DailyAgentCardProps {
  agentName?: string
  dateLabel?: string
  paidTodayLabel?: string
  expectedDailyLabel?: string
  pct?: number
  remainingLabel?: string
  tenantCount?: number
  remainingSlots?: number
  headroomLabel?: string
  perTenantMaxLabel?: string
  paidYesterdayLabel?: string
  diffLabel?: string
  canPost?: boolean
  badges?: CardBadge[]
}

const BADGE_HEX: Record<BadgeTone, { bg: string; fg: string }> = {
  gold: { bg: '#fef3c7', fg: '#92400e' },
  green: { bg: '#d1fae5', fg: '#047857' },
  blue: { bg: '#dbeafe', fg: '#1d4ed8' },
  amber: { bg: '#fef3c7', fg: '#b45309' },
}

export function DailyAgentCard({
  agentName = 'Agent',
  dateLabel = '',
  paidTodayLabel = 'UGX 0',
  expectedDailyLabel = 'UGX 0',
  pct = 0,
  remainingLabel = '',
  tenantCount = 0,
  remainingSlots = 0,
  headroomLabel = 'UGX 0',
  perTenantMaxLabel = 'UGX 0',
  paidYesterdayLabel = 'UGX 0',
  diffLabel = '',
  canPost = false,
  badges = [],
}: DailyAgentCardProps) {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0))
  const barColor = safePct >= 50 ? '#10b981' : safePct >= 20 ? '#f59e0b' : '#ef4444'

  return (
    <Html>
      <Head />
      <Preview>
        Your Welile capacity today: {paidTodayLabel} of {expectedDailyLabel} collected
      </Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section style={headerRow}>
            <Img
              src="https://welileapp.com/welile-logo.png"
              alt="Welile"
              height={36}
              style={{ objectFit: 'contain' }}
            />
            <Text style={dateText}>{dateLabel}</Text>
          </Section>

          <Text style={eyebrow}>TODAY&apos;S RENT-REQUEST CAPACITY</Text>
          <Heading style={name}>{agentName}</Heading>

          {/* Badges */}
          {badges.length > 0 && (
            <Section style={{ marginBottom: '20px' }}>
              {badges.map((b, i) => {
                const bc = BADGE_HEX[b.tone] || BADGE_HEX.blue
                return (
                  <span
                    key={i}
                    style={{
                      display: 'inline-block',
                      background: bc.bg,
                      color: bc.fg,
                      borderRadius: '999px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 800,
                      marginRight: '8px',
                      marginBottom: '8px',
                    }}
                  >
                    {b.icon} {b.label}
                  </span>
                )
              })}
            </Section>
          )}

          {/* Collected today vs target */}
          <Section style={tile}>
            <Text style={tileLabel}>COLLECTED TODAY VS TARGET</Text>
            <Text style={bigStat}>
              {paidTodayLabel}
              <span style={bigStatSub}> / {expectedDailyLabel}</span>
            </Text>
            <div style={barTrack}>
              <div style={{ ...barFill, width: `${safePct}%`, background: barColor }} />
            </div>
            <Text style={tileSub}>
              {safePct}% of today&apos;s target{remainingLabel ? ` · ${remainingLabel} still to go` : ''}
            </Text>
          </Section>

          {/* Two stat tiles */}
          <Section>
            <table width="100%" cellPadding={0} cellSpacing={0} role="presentation">
              <tr>
                <td style={{ width: '50%', verticalAlign: 'top', paddingRight: '8px' }}>
                  <div style={smallTile}>
                    <Text style={tileLabel}>ACTIVE TENANTS</Text>
                    <Text style={midStat}>{tenantCount}</Text>
                    <Text style={tileSub}>houses on book</Text>
                  </div>
                </td>
                <td style={{ width: '50%', verticalAlign: 'top', paddingLeft: '8px' }}>
                  <div style={smallTile}>
                    <Text style={tileLabel}>REMAINING SLOTS</Text>
                    <Text style={midStat}>{remainingSlots}</Text>
                    <Text style={tileSub}>{canPost ? `${headroomLabel} headroom` : 'Locked'}</Text>
                  </div>
                </td>
              </tr>
            </table>
          </Section>

          {/* Vs yesterday */}
          <Text style={yesterdayLine}>
            Yesterday: {paidYesterdayLabel}
            {diffLabel ? ` · ${diffLabel} today` : ''}
          </Text>

          {/* Verdict */}
          <Section
            style={{
              ...verdict,
              background: canPost ? '#ecfdf5' : '#fef2f2',
              color: canPost ? '#047857' : '#b91c1c',
            }}
          >
            <Text style={{ margin: 0, fontWeight: 700, fontSize: '14px', color: 'inherit' }}>
              {canPost
                ? `✓ Can allocate today · up to ${perTenantMaxLabel} per tenant`
                : '✗ Locked — reach your daily target to unlock allocations'}
            </Text>
          </Section>

          <Text style={footer}>Powered by Welile · welileapp.com</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: '#ffffff',
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
}
const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '28px 28px 24px',
  maxWidth: '540px',
  backgroundColor: '#ffffff',
}
const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '20px',
}
const dateText: React.CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
  fontWeight: 600,
  margin: 0,
  textAlign: 'right',
}
const eyebrow: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 700,
  letterSpacing: '1px',
  color: '#0f3d2e',
  margin: '0 0 4px',
}
const name: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: 800,
  color: '#111827',
  margin: '0 0 18px',
}
const tile: React.CSSProperties = {
  background: '#f3f4f6',
  border: '1px solid #e5e7eb',
  borderRadius: '16px',
  padding: '20px',
  marginBottom: '16px',
}
const smallTile: React.CSSProperties = {
  background: '#f3f4f6',
  border: '1px solid #e5e7eb',
  borderRadius: '16px',
  padding: '16px',
}
const tileLabel: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: '#6b7280',
  margin: '0 0 6px',
}
const bigStat: React.CSSProperties = {
  fontSize: '28px',
  fontWeight: 900,
  color: '#111827',
  margin: '0 0 12px',
}
const bigStatSub: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: '#6b7280',
}
const midStat: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 800,
  color: '#111827',
  margin: '4px 0',
}
const tileSub: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: '#374151',
  margin: 0,
}
const barTrack: React.CSSProperties = {
  height: '12px',
  borderRadius: '999px',
  background: '#e5e7eb',
  overflow: 'hidden',
  margin: '0 0 8px',
}
const barFill: React.CSSProperties = {
  height: '12px',
  borderRadius: '999px',
}
const yesterdayLine: React.CSSProperties = {
  fontSize: '13px',
  color: '#374151',
  fontWeight: 600,
  margin: '4px 0 16px',
}
const verdict: React.CSSProperties = {
  borderRadius: '14px',
  padding: '14px 18px',
}
const footer: React.CSSProperties = {
  textAlign: 'center',
  fontSize: '11px',
  color: '#6b7280',
  letterSpacing: '0.5px',
  margin: '20px 0 0',
}

export const template = {
  component: DailyAgentCard,
  subject: (d: Record<string, any>) =>
    `Your Welile capacity today — ${d?.paidTodayLabel ?? 'UGX 0'} collected`,
  displayName: 'Daily Agent Capacity Card',
  previewData: {
    agentName: 'John Agent',
    dateLabel: 'Sat, 30 May 2026',
    paidTodayLabel: 'UGX 320,000',
    expectedDailyLabel: 'UGX 500,000',
    pct: 64,
    remainingLabel: 'UGX 180,000',
    tenantCount: 18,
    remainingSlots: 6,
    headroomLabel: 'UGX 64,000,000',
    perTenantMaxLabel: 'UGX 6,000,000',
    paidYesterdayLabel: 'UGX 280,000',
    diffLabel: '+UGX 40,000',
    canPost: true,
    badges: [
      { icon: '🏆', label: 'Big Book', tone: 'gold' },
      { icon: '🔥', label: 'Daily Collector', tone: 'green' },
    ],
  },
} satisfies TemplateEntry