/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Hr, Html, Preview, Section, Text, Heading,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface MemoSection {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
}

interface BoardTechnologyMemoProps {
  memoTitle?: string
  memoDate?: string
  preparedBy?: string
  classification?: string
  summary?: string
  sections?: MemoSection[]
  closingNote?: string
}

export function BoardTechnologyMemoEmail({
  memoTitle = 'Technology Memo',
  memoDate = '',
  preparedBy = 'Technology Office, Welile',
  classification = 'Confidential — Board of Directors',
  summary = '',
  sections = [],
  closingNote = '',
}: BoardTechnologyMemoProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Board of Directors — ${memoTitle}${memoDate ? ` · ${memoDate}` : ''}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={brand}>WELILE</Text>
            <Text style={brandSub}>Board of Directors — Technology Memo</Text>
          </Section>

          <Section style={card}>
            <Heading style={h1}>{memoTitle}</Heading>
            <Text style={meta}>{classification}</Text>
            {memoDate ? <Text style={meta}>Date: {memoDate}</Text> : null}
            <Text style={meta}>Prepared by: {preparedBy}</Text>

            {summary ? (
              <Section style={summaryBox}>
                <Text style={summaryLabel}>EXECUTIVE SUMMARY</Text>
                <Text style={text}>{summary}</Text>
              </Section>
            ) : null}

            {sections.map((s) => (
              <Section key={s.heading} style={{ marginTop: '18px' }}>
                <Text style={sectionTitle}>{s.heading}</Text>
                {(s.paragraphs || []).map((p, i) => (
                  <Text key={i} style={text}>{p}</Text>
                ))}
                {(s.bullets || []).map((b, i) => (
                  <Text key={i} style={bullet}>•&nbsp;&nbsp;{b}</Text>
                ))}
              </Section>
            ))}

            {closingNote ? <Text style={{ ...text, marginTop: '18px' }}>{closingNote}</Text> : null}

            <Hr style={hr} />
            <Text style={footer}>
              This memorandum is confidential and intended solely for the Welile Board of Directors.
              Please do not forward or distribute outside the Board.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const PURPLE = '#6B00CC'
const main: React.CSSProperties = { backgroundColor: '#F5F3F8', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", padding: '24px 0' }
const container: React.CSSProperties = { margin: '0 auto', maxWidth: '620px', width: '100%' }
const header: React.CSSProperties = { backgroundColor: PURPLE, padding: '18px 24px', borderRadius: '10px 10px 0 0' }
const brand: React.CSSProperties = { color: '#ffffff', fontSize: '18px', fontWeight: 700, margin: 0, letterSpacing: '1px' }
const brandSub: React.CSSProperties = { color: '#E4D3F7', fontSize: '12px', margin: '2px 0 0' }
const card: React.CSSProperties = { backgroundColor: '#ffffff', padding: '24px', borderRadius: '0 0 10px 10px' }
const h1: React.CSSProperties = { color: '#0F172A', fontSize: '20px', margin: '0 0 6px' }
const meta: React.CSSProperties = { color: '#64748B', fontSize: '12px', margin: '0 0 2px' }
const summaryBox: React.CSSProperties = { backgroundColor: '#F4EDFB', border: '1px solid #D9C2F0', borderRadius: '8px', padding: '14px 16px', margin: '16px 0 4px' }
const summaryLabel: React.CSSProperties = { color: PURPLE, fontSize: '11px', fontWeight: 700, letterSpacing: '1px', margin: '0 0 8px' }
const text: React.CSSProperties = { color: '#0F172A', fontSize: '14px', lineHeight: '22px', margin: '0 0 12px' }
const sectionTitle: React.CSSProperties = { color: PURPLE, fontSize: '13px', fontWeight: 700, margin: '0 0 8px' }
const bullet: React.CSSProperties = { color: '#0F172A', fontSize: '14px', lineHeight: '22px', margin: '0 0 6px', paddingLeft: '6px' }
const hr: React.CSSProperties = { borderColor: '#E2E8F0', margin: '20px 0 12px' }
const footer: React.CSSProperties = { color: '#94A3B8', fontSize: '11px', margin: 0 }

export const template = {
  component: BoardTechnologyMemoEmail,
  subject: (d: Record<string, any>) =>
    `Board of Directors — Technology Memo${d?.memoDate ? ` · ${d.memoDate}` : ''}`,
  displayName: 'Board Technology Memo',
  previewData: {
    memoTitle: 'Technology Memo',
    memoDate: 'August 2026',
    summary: 'Platform technology update for the Board of Directors.',
    sections: [
      { heading: 'Platform status', paragraphs: ['Systems operating normally.'] },
    ],
  },
} satisfies TemplateEntry
