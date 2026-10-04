import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface FailingPath {
  path?: string
  firstStatus?: number | null
  finalStatus?: number | null
  location?: string | null
  error?: string
}

interface RedirectMonitorAlertProps {
  alertType?: string
  oldDomain?: string
  newDomain?: string
  checkedAt?: string
  consecutiveFailures?: number
  failingPaths?: FailingPath[]
}

export function RedirectMonitorAlertEmail({
  alertType = 'redirect_down',
  oldDomain = '',
  newDomain = '',
  checkedAt = '',
  consecutiveFailures = 0,
  failingPaths = [],
}: RedirectMonitorAlertProps) {
  const isDown = alertType === 'redirect_down'
  return (
    <Html>
      <Head />
      <Preview>
        {isDown
          ? `Redirect DOWN: ${oldDomain} no longer 301s to ${newDomain}`
          : `Redirect RESTORED: ${oldDomain} → ${newDomain} is healthy again`}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>
            {isDown ? '🚨 Redirect Down' : '✅ Redirect Restored'}
          </Heading>
          <Text style={text}>
            {isDown
              ? `The 301 redirect from ${oldDomain} to ${newDomain} is no longer returning the expected response. Search Console consolidation and SEO equity are at risk until it is fixed.`
              : `The 301 redirect from ${oldDomain} to ${newDomain} is healthy again. All monitored URLs return a clean permanent redirect.`}
          </Text>
          <Section style={isDown ? infoBoxCritical : infoBox}>
            <Text style={infoLabel}>Redirect</Text>
            <Text style={infoValue}>{oldDomain} → {newDomain}</Text>
            <Text style={infoLabel}>Checked at</Text>
            <Text style={infoValue}>{checkedAt}</Text>
            {isDown && (
              <>
                <Text style={infoLabel}>Consecutive failed checks</Text>
                <Text style={infoValue}>{consecutiveFailures}</Text>
              </>
            )}
          </Section>

          {isDown && failingPaths.length > 0 && (
            <Section>
              <Heading as="h2" style={h2}>Failing URLs</Heading>
              {failingPaths.map((p, i) => (
                <Section key={i} style={refRow}>
                  <Text style={refTitle}>{i + 1}. {p.path || '(root)'}</Text>
                  <Text style={refMeta}>
                    First hop: {p.firstStatus ?? '—'} · Final: {p.finalStatus ?? '—'}
                    {p.location ? ` · Location: ${p.location}` : ''}
                  </Text>
                  {p.error && <Text style={refError}>⚠ {p.error}</Text>}
                </Section>
              ))}
            </Section>
          )}

          <Hr style={hr} />
          <Text style={footer}>
            Welile · Open the CTO dashboard → Change of Address panel to review the redirect chain.
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
  component: RedirectMonitorAlertEmail,
  subject: (data: Record<string, any>) =>
    data?.alertType === 'redirect_restored'
      ? `✅ Redirect restored: ${data?.oldDomain || ''} → ${data?.newDomain || ''}`
      : `🚨 Redirect DOWN: ${data?.oldDomain || ''} → ${data?.newDomain || ''}`,
  displayName: 'Redirect Monitor Alert',
  previewData: {
    alertType: 'redirect_down',
    oldDomain: 'welilereceipts.com',
    newDomain: 'welileapp.com',
    checkedAt: new Date().toISOString(),
    consecutiveFailures: 2,
    failingPaths: [
      { path: '/', firstStatus: 200, finalStatus: 200, location: null },
      { path: '/opportunities', firstStatus: 404, finalStatus: 404, location: null },
    ],
  },
} satisfies TemplateEntry