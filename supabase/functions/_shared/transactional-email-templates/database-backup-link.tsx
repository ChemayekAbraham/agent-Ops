import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Hr, Html, Preview, Section, Text, Link,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface DatabaseBackupLinkProps {
  downloadUrl?: string
  fileName?: string
  sizeMb?: string
  generatedAt?: string
  expiresInHours?: number
  note?: string
}

export function DatabaseBackupLinkEmail({
  downloadUrl = '#',
  fileName = 'welile_export.sql',
  sizeMb = '0.00',
  generatedAt = new Date().toISOString(),
  expiresInHours = 168,
  note,
}: DatabaseBackupLinkProps) {
  return (
    <Html>
      <Head />
      <Preview>Your Welile file is ready</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={text}>Hi,</Text>
          <Text style={text}>
            Here is the secure link you requested for the Welile internal data file{' '}
            <strong>{fileName}</strong> ({sizeMb} MB), generated on {generatedAt}.
          </Text>
          <Section style={{ margin: '20px 0' }}>
            <Link href={downloadUrl} style={linkStyle}>{downloadUrl}</Link>
          </Section>
          <Text style={text}>
            The link is valid for {expiresInHours} hours.
          </Text>
          {note && (
            <Text style={text}>
              <em>Note:</em> {note}
            </Text>
          )}
          <Hr style={hr} />
          <Text style={footer}>
            Welile Technologies — internal operations message.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
const container: React.CSSProperties = { margin: '0 auto', padding: '24px', maxWidth: '560px' }
const text: React.CSSProperties = { color: '#0f172a', fontSize: '14px', lineHeight: '22px', margin: '0 0 12px' }
const linkStyle: React.CSSProperties = { color: '#1d4ed8', fontSize: '13px', wordBreak: 'break-all' }
const hr: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0 12px' }
const footer: React.CSSProperties = { color: '#94a3b8', fontSize: '12px', margin: 0 }

export const template = {
  component: DatabaseBackupLinkEmail,
  subject: 'Your requested Welile file link',
  displayName: 'Database Backup Link (resend)',
  previewData: {
    downloadUrl: 'https://example.com/signed',
    fileName: 'welile_export_2026-05-05.sql',
    sizeMb: '12.34',
    generatedAt: new Date().toISOString(),
    expiresInHours: 168,
    note: 'Re-sent after a delivery issue was reported.',
  },
} satisfies TemplateEntry