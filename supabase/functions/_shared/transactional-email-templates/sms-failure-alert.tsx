import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface TopRef {
  reference?: string
  source?: string
  failed_count?: number
  sample_error?: string
  sample_phone?: string
}

interface SmsFailureAlertProps {
  failedCount?: number
  totalCount?: number
  failureRatePct?: number
  severity?: string
  windowStart?: string
  windowEnd?: string
  topFailedReferences?: TopRef[]
}

export function SmsFailureAlertEmail({
  failedCount = 0,
  totalCount = 0,
  failureRatePct = 0,
  severity = 'warning',
  windowStart = '',
  windowEnd = '',
  topFailedReferences = [],
}: SmsFailureAlertProps) {
  const isCritical = severity === 'critical'
  return (
    <Html>
      <Head />
      <Preview>{`SMS failures crossed threshold: ${failedCount} failed of ${totalCount}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>
            {isCritical ? '🚨' : '⚠️'} SMS Delivery Failure Alert
          </Heading>
          <Text style={text}>
            SMS failures have crossed the configured threshold in the last 24 hours.
          </Text>
          <Section style={isCritical ? infoBoxCritical : infoBox}>
            <Text style={infoLabel}>Severity</Text>
            <Text style={infoValue}>{severity.toUpperCase()}</Text>
            <Text style={infoLabel}>Failed / Total</Text>
            <Text style={infoValue}>{failedCount} failed of {totalCount} sends</Text>
            <Text style={infoLabel}>Failure rate</Text>
            <Text style={infoValue}>{failureRatePct}%</Text>
            <Text style={infoLabel}>Window</Text>
            <Text style={infoValue}>{windowStart} → {windowEnd}</Text>
          </Section>

          {topFailedReferences.length > 0 && (
            <Section>
              <Heading as="h2" style={h2}>Top failed references</Heading>
              {topFailedReferences.map((r, i) => (
                <Section key={i} style={refRow}>
                  <Text style={refTitle}>
                    {i + 1}. {r.reference || '(no reference)'} · {r.failed_count} failed
                  </Text>
                  <Text style={refMeta}>
                    Source: {r.source || '(unknown)'}
                    {r.sample_phone ? ` · ${r.sample_phone}` : ''}
                  </Text>
                  {r.sample_error && <Text style={refError}>⚠ {r.sample_error}</Text>}
                </Section>
              ))}
            </Section>
          )}

          <Hr style={hr} />
          <Text style={footer}>
            Welile · Open the CFO dashboard → SMS tab to review and acknowledge this alert.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const h2: React.CSSProperties = { color: '#0f172a', fontSize: '15px', fontWeight: 700, margin: '20px 0 8px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' }
const infoBox: React.CSSProperties = { backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const infoBoxCritical: React.CSSProperties = { backgroundColor: '#fef2f2', borderRadius: '8px', padding: '16px', margin: '20px 0', border: '1px solid #fecaca' }
const infoLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 2px', fontWeight: 600 }
const infoValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
const refRow: React.CSSProperties = { borderBottom: '1px solid #e2e8f0', padding: '8px 0' }
const refTitle: React.CSSProperties = { color: '#0f172a', fontSize: '13px', fontWeight: 600, margin: '0 0 2px' }
const refMeta: React.CSSProperties = { color: '#64748b', fontSize: '12px', margin: '0 0 2px' }
const refError: React.CSSProperties = { color: '#dc2626', fontSize: '12px', margin: 0 }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }

export const template = {
  component: SmsFailureAlertEmail,
  subject: (d: Record<string, any>) =>
    `${d?.severity === 'critical' ? '🚨' : '⚠️'} SMS failure alert — ${d?.failedCount ?? 0} failed (${d?.failureRatePct ?? 0}%)`,
  displayName: 'SMS Failure Alert',
  previewData: {
    failedCount: 18,
    totalCount: 60,
    failureRatePct: 30,
    severity: 'warning',
    windowStart: new Date(Date.now() - 86400000).toISOString(),
    windowEnd: new Date().toISOString(),
    topFailedReferences: [
      { reference: 'COL-2031', source: 'send-collection-sms', failed_count: 9, sample_error: 'InvalidPhoneNumber', sample_phone: '+256700000000' },
      { reference: 'TID148353', source: 'withdrawal', failed_count: 5, sample_error: 'InsufficientBalance', sample_phone: '+256780000000' },
    ],
  },
} satisfies TemplateEntry