/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Hr, Html, Preview, Section, Text, Link, Row, Column, Heading,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Kpi { label: string; value: string }
interface ScoreRow { kpi: string; weight: string; achievement: string; score: string }

interface PerformanceAssessmentReportProps {
  reportTitle?: string
  periodLabel?: string
  roleLabel?: string
  headline?: string
  summary?: string
  kpis?: Kpi[]
  rows?: ScoreRow[]
  notes?: string[]
  pdfUrl?: string
  pdfName?: string
}

export function PerformanceAssessmentReportEmail({
  reportTitle = 'Monthly Performance Assessment',
  periodLabel = 'July 2026',
  roleLabel = 'Software Engineer — Landlord Agents Growth',
  headline = '93.1%',
  summary = 'Final confirmed performance for the period.',
  kpis = [],
  rows = [],
  notes = [],
  pdfUrl = '#',
  pdfName = 'report.pdf',
}: PerformanceAssessmentReportProps) {
  return (
    <Html>
      <Head />
      <Preview>{`${reportTitle} — ${periodLabel} · ${headline}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={brand}>WELILE</Text>
            <Text style={brandSub}>Performance &amp; Growth Report</Text>
          </Section>

          <Section style={card}>
            <Heading style={h1}>{reportTitle}</Heading>
            <Text style={meta}>{roleLabel}</Text>
            <Text style={meta}>Period: {periodLabel} · Confidential — Internal</Text>

            <Section style={scoreBox}>
              <Text style={scoreValue}>{headline}</Text>
              <Text style={scoreLabel}>FINAL CONFIRMED PERFORMANCE</Text>
            </Section>

            <Text style={text}>{summary}</Text>

            {kpis.length > 0 && (
              <Section style={{ marginTop: '8px' }}>
                <Row>
                  {kpis.map((k) => (
                    <Column key={k.label} style={kpiCell}>
                      <Text style={kpiValue}>{k.value}</Text>
                      <Text style={kpiLabel}>{k.label}</Text>
                    </Column>
                  ))}
                </Row>
              </Section>
            )}

            {rows.length > 0 && (
              <Section style={{ marginTop: '20px' }}>
                <Text style={sectionTitle}>Scorecard summary</Text>
                <Row style={theadRow}>
                  <Column style={{ ...th, width: '38%' }}>KPI</Column>
                  <Column style={{ ...th, width: '14%' }}>Weight</Column>
                  <Column style={{ ...th, width: '30%' }}>Achievement</Column>
                  <Column style={{ ...th, width: '18%' }}>Score</Column>
                </Row>
                {rows.map((r) => (
                  <Row key={r.kpi} style={tr}>
                    <Column style={{ ...td, width: '38%' }}>{r.kpi}</Column>
                    <Column style={{ ...td, width: '14%' }}>{r.weight}</Column>
                    <Column style={{ ...td, width: '30%' }}>{r.achievement}</Column>
                    <Column style={{ ...tdStrong, width: '18%' }}>{r.score}</Column>
                  </Row>
                ))}
              </Section>
            )}

            {notes.length > 0 && (
              <Section style={{ marginTop: '18px' }}>
                <Text style={sectionTitle}>Key notes</Text>
                {notes.map((n, i) => (
                  <Text key={i} style={noteText}>• {n}</Text>
                ))}
              </Section>
            )}

            <Section style={ctaWrap}>
              <Text style={text}>
                The full report is attached as a PDF ({pdfName}). If your mail client does not
                show the attachment, download it here:
              </Text>
              <Link href={pdfUrl} style={button}>Download the PDF report</Link>
              <Text style={smallLink}>{pdfUrl}</Text>
            </Section>

            <Hr style={hr} />
            <Text style={footer}>
              Welile Technologies · Kampala, Uganda — internal operations report.
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
const scoreBox: React.CSSProperties = { backgroundColor: '#F4EDFB', border: '1px solid #D9C2F0', borderRadius: '8px', padding: '16px', textAlign: 'center', margin: '18px 0' }
const scoreValue: React.CSSProperties = { color: PURPLE, fontSize: '32px', fontWeight: 700, margin: 0, lineHeight: '36px' }
const scoreLabel: React.CSSProperties = { color: '#64748B', fontSize: '11px', letterSpacing: '1px', margin: '4px 0 0' }
const text: React.CSSProperties = { color: '#0F172A', fontSize: '14px', lineHeight: '22px', margin: '0 0 12px' }
const sectionTitle: React.CSSProperties = { color: PURPLE, fontSize: '13px', fontWeight: 700, margin: '0 0 8px' }
const kpiCell: React.CSSProperties = { backgroundColor: '#FAFAFC', border: '1px solid #ECE7F3', padding: '10px 6px', textAlign: 'center' }
const kpiValue: React.CSSProperties = { color: PURPLE, fontSize: '16px', fontWeight: 700, margin: 0 }
const kpiLabel: React.CSSProperties = { color: '#64748B', fontSize: '10px', margin: '2px 0 0' }
const theadRow: React.CSSProperties = { backgroundColor: PURPLE }
const th: React.CSSProperties = { color: '#ffffff', fontSize: '11px', fontWeight: 700, padding: '8px 10px' }
const tr: React.CSSProperties = { borderBottom: '1px solid #E2E8F0' }
const td: React.CSSProperties = { color: '#0F172A', fontSize: '12px', padding: '8px 10px' }
const tdStrong: React.CSSProperties = { ...td, fontWeight: 700, color: PURPLE }
const noteText: React.CSSProperties = { color: '#334155', fontSize: '13px', lineHeight: '20px', margin: '0 0 6px' }
const ctaWrap: React.CSSProperties = { marginTop: '22px' }
const button: React.CSSProperties = { backgroundColor: PURPLE, color: '#ffffff', fontSize: '14px', fontWeight: 700, padding: '12px 20px', borderRadius: '8px', textDecoration: 'none', display: 'inline-block' }
const smallLink: React.CSSProperties = { color: '#94A3B8', fontSize: '11px', wordBreak: 'break-all', margin: '10px 0 0' }
const hr: React.CSSProperties = { borderColor: '#E2E8F0', margin: '20px 0 12px' }
const footer: React.CSSProperties = { color: '#94A3B8', fontSize: '11px', margin: 0 }

export const template = {
  component: PerformanceAssessmentReportEmail,
  subject: 'Monthly Performance Assessment — July 2026',
  displayName: 'Performance Assessment Report',
  previewData: {
    reportTitle: 'Monthly Performance Assessment',
    periodLabel: 'July 2026',
    roleLabel: 'Software Engineer — Landlord Agents Growth',
    headline: '93.1%',
    summary: 'Revised issue — supersedes the earlier 48.2% draft. Every KPI is backed by verifiable platform evidence.',
    kpis: [
      { label: 'ACTIVE AGENTS', value: '568' },
      { label: 'OF 200 TARGET', value: '284%' },
      { label: 'RETENTION', value: '80.7%' },
    ],
    rows: [
      { kpi: 'Active Landlord Agents', weight: '60%', achievement: '568 / 200 (capped)', score: '60.0%' },
      { kpi: 'Existing Agent Retention', weight: '15%', achievement: '46 / 57 = 80.7%', score: '12.1%' },
      { kpi: 'Product Delivery', weight: '15%', achievement: '87%', score: '13.0%' },
      { kpi: 'Platform Reliability', weight: '10%', achievement: '80%', score: '8.0%' },
    ],
    notes: [
      '568 unique qualifying active agents against a target of 200.',
      'Seven product deliverables shipped; six high-severity issues resolved.',
    ],
    pdfUrl: 'https://example.com/report.pdf',
    pdfName: 'Welile_Performance_Assessment_July_2026.pdf',
  },
} satisfies TemplateEntry