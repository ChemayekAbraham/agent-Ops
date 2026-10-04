import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Link, Preview, Text, Section, Button,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  recipient_name?: string
  parent_name?: string
  accept_url?: string
  invite_message?: string
}

const SITE_NAME = 'Welile'

export function SubAgentInvite({
  recipient_name = 'there',
  parent_name = 'A Welile agent',
  accept_url = 'https://welileapp.com/sub-agent-invite',
  invite_message = '',
}: Props) {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{parent_name} invited you to be their sub-agent on {SITE_NAME}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accentBar} />
          <Section style={{ padding: '32px 32px 8px 32px' }}>
            <Heading style={h1}>You've been invited as a sub-agent</Heading>
            <Text style={lead}>Hi {recipient_name},</Text>
            <Text style={body}>
              <strong>{parent_name}</strong> has invited you to join their team as a
              sub-agent on {SITE_NAME}. Accept the invitation to start earning and
              tracking your activity.
            </Text>
            {invite_message ? (
              <Text style={quote}>
                "{invite_message}"
              </Text>
            ) : null}
          </Section>
          <Section style={{ padding: '8px 32px 8px 32px', textAlign: 'center' as const }}>
            <Button href={accept_url} style={ctaBtn}>Accept invitation</Button>
          </Section>
          <Section style={{ padding: '16px 32px 32px 32px' }}>
            <Text style={fineprint}>
              Or open this link: <Link href={accept_url} style={link}>{accept_url}</Link>
            </Text>
            <Text style={fineprint}>
              If you weren't expecting this, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
        <Text style={footer}>© {new Date().getFullYear()} {SITE_NAME}. All rights reserved.</Text>
      </Body>
    </Html>
  )
}

export const template = {
  component: SubAgentInvite,
  subject: (d: Record<string, any>) =>
    `${d?.parent_name || 'A Welile agent'} invited you to be their sub-agent`,
  displayName: 'Sub-agent invite',
  previewData: { recipient_name: 'Jane', parent_name: 'John Doe', accept_url: 'https://welileapp.com/sub-agent-invite?token=abc' },
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
const body: React.CSSProperties = { margin: '0 0 16px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const quote: React.CSSProperties = { margin: '0 0 16px 0', padding: '12px 16px', color: INK, fontSize: '15px', lineHeight: '22px', fontStyle: 'italic', backgroundColor: '#f8f5ff', borderLeft: `3px solid ${BRAND}`, borderRadius: '6px' }
const ctaBtn: React.CSSProperties = { backgroundColor: BRAND, color: '#ffffff', padding: '14px 28px', borderRadius: '10px', fontSize: '15px', fontWeight: 700, textDecoration: 'none', display: 'inline-block' }
const fineprint: React.CSSProperties = { margin: '0 0 8px 0', color: SUB, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }
const link: React.CSSProperties = { color: BRAND, textDecoration: 'none', fontWeight: 700, wordBreak: 'break-all' as const }
const footer: React.CSSProperties = { margin: '16px 0 0 0', color: '#94a3b8', fontSize: '11px', textAlign: 'center' as const }
