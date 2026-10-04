import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface DatabaseBackupReadyProps {
  downloadUrl?: string
  fileName?: string
  sizeMb?: string
  tableCount?: number
  rowCount?: number
  generatedAt?: string
  expiresInHours?: number
  actorName?: string
  actorTimestamp?: string
  actorUserAgent?: string
}

export function DatabaseBackupReadyEmail({
  downloadUrl = '#',
  fileName = 'welile_export.sql',
  sizeMb = '0.00',
  tableCount = 0,
  rowCount = 0,
  generatedAt = new Date().toISOString(),
  expiresInHours = 168,
  actorName = 'System (scheduled cron)',
  actorTimestamp = new Date().toISOString(),
  actorUserAgent = 'n/a',
}: DatabaseBackupReadyProps) {
  return (
    <Html>
      <Head />
      <Preview>Welile weekly database backup is ready</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>🗄️ Weekly Database Backup</Heading>
          <Text style={text}>
            The scheduled Welile database backup completed successfully. Use the
            secure link below to download the SQL dump.
          </Text>
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button href={downloadUrl} style={btn}>Download backup</Button>
          </Section>
          <Section style={infoBox}>
            <Text style={infoLabel}>File</Text>
            <Text style={infoValue}>{fileName}</Text>
            <Text style={infoLabel}>Size</Text>
            <Text style={infoValue}>{sizeMb} MB</Text>
            <Text style={infoLabel}>Tables / Rows</Text>
            <Text style={infoValue}>{tableCount} tables · {rowCount.toLocaleString()} rows</Text>
            <Text style={infoLabel}>Generated</Text>
            <Text style={infoValue}>{generatedAt}</Text>
            <Text style={infoLabel}>Link expires in</Text>
            <Text style={infoValue}>{expiresInHours} hours</Text>
            <Text style={infoLabel}>Triggered by</Text>
            <Text style={infoValue}>{actorName}</Text>
            <Text style={infoLabel}>Triggered at</Text>
            <Text style={infoValue}>{actorTimestamp}</Text>
            <Text style={infoLabel}>User agent</Text>
            <Text style={infoValue}>{actorUserAgent}</Text>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>
            Welile · Retained backups in Lovable Cloud Storage. Older runs are kept indefinitely.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '32px 24px', maxWidth: '560px', backgroundColor: '#ffffff', borderRadius: '12px' }
const h1: React.CSSProperties = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 12px' }
const btn: React.CSSProperties = { backgroundColor: '#0f172a', color: '#ffffff', padding: '12px 24px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }
const infoBox: React.CSSProperties = { backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const infoLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 2px', fontWeight: 600 }
const infoValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }

export const template = {
  component: DatabaseBackupReadyEmail,
  subject: '🗄️ Welile weekly database backup is ready',
  displayName: 'Database Backup Ready',
  previewData: {
    downloadUrl: 'https://example.com/signed',
    fileName: 'welile_export_2026-05-05.sql',
    sizeMb: '12.34',
    tableCount: 90,
    rowCount: 123456,
    generatedAt: new Date().toISOString(),
    expiresInHours: 168,
  },
} satisfies TemplateEntry