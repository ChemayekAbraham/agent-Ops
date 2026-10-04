import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface BackupPart {
  fileName: string
  url: string
  rows: number
  sizeMb: string
}

interface GeneralLedgerBackupReadyProps {
  parts?: BackupPart[]
  manifestUrl?: string
  exportedRows?: number
  snapshotRows?: number
  sizeMb?: string
  generatedAt?: string
  durationSec?: number
  expiresInHours?: number
  status?: string
  actorName?: string
}

export function GeneralLedgerBackupReadyEmail({
  parts = [],
  manifestUrl = '#',
  exportedRows = 0,
  snapshotRows = 0,
  sizeMb = '0.00',
  generatedAt = new Date().toISOString(),
  durationSec = 0,
  expiresInHours = 168,
  status = 'success',
  actorName = 'System (scheduled cron)',
}: GeneralLedgerBackupReadyProps) {
  const complete = status === 'success'
  return (
    <Html>
      <Head />
      <Preview>General ledger backup: {exportedRows.toLocaleString()} rows</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>General Ledger Backup</Heading>
          <Text style={complete ? okBanner : warnBanner}>
            {complete
              ? `Complete: ${exportedRows.toLocaleString()} rows exported (${snapshotRows.toLocaleString()} counted at start).`
              : `INCOMPLETE: only ${exportedRows.toLocaleString()} of ${snapshotRows.toLocaleString()} rows were exported. Do not rely on this backup.`}
          </Text>
          <Text style={text}>
            The full general_ledger table as CSV, ordered by id and split into {parts.length} part
            {parts.length === 1 ? '' : 's'}. Each part has its own header row. Restore each one with{' '}
            <code>\copy public.general_ledger FROM 'part.csv' WITH (FORMAT csv, HEADER true)</code>.
          </Text>
          <Section style={infoBox}>
            {parts.map((p) => (
              <Text key={p.fileName} style={partRow}>
                <Link href={p.url} style={link}>{p.fileName}</Link>
                {'  ·  '}{p.rows.toLocaleString()} rows · {p.sizeMb} MB
              </Text>
            ))}
            <Text style={partRow}>
              <Link href={manifestUrl} style={link}>manifest.json</Link>
            </Text>
          </Section>
          <Section style={infoBox}>
            <Text style={infoLabel}>Total size</Text>
            <Text style={infoValue}>{sizeMb} MB</Text>
            <Text style={infoLabel}>Generated</Text>
            <Text style={infoValue}>{generatedAt} ({durationSec}s)</Text>
            <Text style={infoLabel}>Links expire in</Text>
            <Text style={infoValue}>{expiresInHours} hours (files stay in the db-backups bucket)</Text>
            <Text style={infoLabel}>Triggered by</Text>
            <Text style={infoValue}>{actorName}</Text>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>Welile · general-ledger-backup</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '600px', backgroundColor: '#ffffff' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '14px', lineHeight: '22px', margin: '0 0 12px' }
const okBanner: React.CSSProperties = { backgroundColor: '#dcfce7', color: '#14532d', padding: '10px 12px', borderRadius: '6px', fontSize: '14px', fontWeight: 600 }
const warnBanner: React.CSSProperties = { backgroundColor: '#fee2e2', color: '#7f1d1d', padding: '10px 12px', borderRadius: '6px', fontSize: '14px', fontWeight: 600 }
const infoBox: React.CSSProperties = { backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '16px', margin: '16px 0' }
const partRow: React.CSSProperties = { color: '#0f172a', fontSize: '13px', margin: '0 0 6px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
const link: React.CSSProperties = { color: '#1d4ed8' }
const infoLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 2px', fontWeight: 600 }
const infoValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }

export const template = {
  component: GeneralLedgerBackupReadyEmail,
  subject: (d: Record<string, any>) =>
    d.status === 'success'
      ? `Welile general ledger backup — ${Number(d.exportedRows || 0).toLocaleString()} rows`
      : `⚠️ INCOMPLETE Welile general ledger backup — ${Number(d.exportedRows || 0).toLocaleString()} of ${Number(d.snapshotRows || 0).toLocaleString()} rows`,
  displayName: 'General Ledger Backup Ready',
  // The ledger backup only ever goes to Josh, whoever calls the sender.
  to: 'joshwanda17@gmail.com',
  previewData: {
    parts: [{ fileName: 'general_ledger_part01.csv', url: 'https://example.com/p1', rows: 120000, sizeMb: '40.10' }],
    manifestUrl: 'https://example.com/manifest',
    exportedRows: 120000,
    snapshotRows: 120000,
    sizeMb: '40.10',
    generatedAt: new Date().toISOString(),
    durationSec: 30,
    expiresInHours: 168,
    status: 'success',
  },
} satisfies TemplateEntry
