import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PortfolioRenewalDaysRemainingProps {
  partner_name?: string
  days_remaining?: number | string
  days_remaining_label?: string
  effective_date?: string
  company_name?: string
  portfolio_name?: string
}

const resolveDays = (value: number | string | undefined) => {
  if (value === undefined || value === null || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

const labelFor = (days: number, custom?: string) => {
  if (custom?.trim()) return custom.trim()
  if (days <= 0) return 'Renews today'
  if (days === 1) return 'Renews tomorrow'
  return `Renews in ${days} days`
}

export function PortfolioRenewalDaysRemaining({
  partner_name = 'Partner',
  days_remaining = 0,
  days_remaining_label,
  effective_date,
  company_name = 'Welile',
  portfolio_name,
}: PortfolioRenewalDaysRemainingProps) {
  const days = resolveDays(days_remaining)
  const label = labelFor(days, days_remaining_label)
  const preview = effective_date
    ? `Your partnership portfolio renews on ${effective_date}.`
    : `Your partnership portfolio ${label.toLowerCase()}.`

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={brand}>{company_name} · Partnership Team</Text>
          <Heading style={heading}>Upcoming portfolio renewal</Heading>
          <Text style={greeting}>Dear {partner_name},</Text>
          <Text style={body}>
            This is a courtesy notice that your partnership portfolio
            {portfolio_name ? <> — <strong>{portfolio_name}</strong> — </> : ' '}
            is scheduled for automatic renewal.
          </Text>
          <Section style={detailCard}>
            <Text style={detailRow}>
              <span style={detailLabel}>Status</span>
              <span style={detailValue}>{label}</span>
            </Text>
            {effective_date && (
              <Text style={detailRow}>
                <span style={detailLabel}>Effective date</span>
                <span style={detailValue}>{effective_date}</span>
              </Text>
            )}
          </Section>
          <Text style={body}>
            No action is required on your part. Your principal and accrued
            returns will be carried forward under the same terms once the
            renewal takes effect. Should you wish to withdraw instead, please
            reply to this email before the effective date.
          </Text>
          <Text style={signOff}>
            Kind regards,<br />
            Partnership Team<br />
            {company_name}
          </Text>
          <Text style={footer}>
            This is an automated notification. For assistance, contact Welile
            Support on 0748747134.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  margin: 0,
  padding: 0,
  backgroundColor: '#f6f7fb',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
}

const container: React.CSSProperties = {
  margin: '0 auto',
  maxWidth: '560px',
  padding: '40px 28px',
  backgroundColor: '#ffffff',
  borderRadius: '14px',
}

const brand: React.CSSProperties = {
  margin: '0 0 14px',
  color: '#5a129e',
  fontSize: '13px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

const heading: React.CSSProperties = {
  margin: '0 0 20px',
  color: '#111827',
  fontSize: '22px',
  fontWeight: 700,
  letterSpacing: '-0.01em',
}

const greeting: React.CSSProperties = {
  margin: '0 0 16px',
  color: '#334155',
  fontSize: '15px',
  lineHeight: '24px',
}

const body: React.CSSProperties = {
  margin: '0 0 18px',
  color: '#334155',
  fontSize: '15px',
  lineHeight: '24px',
}

const detailCard: React.CSSProperties = {
  margin: '0 0 22px',
  padding: '18px 20px',
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '10px',
}

const detailRow: React.CSSProperties = {
  margin: '0 0 8px',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  fontSize: '14px',
  lineHeight: '22px',
}

const detailLabel: React.CSSProperties = {
  color: '#64748b',
  fontWeight: 500,
}

const detailValue: React.CSSProperties = {
  color: '#0f172a',
  fontWeight: 600,
}

const signOff: React.CSSProperties = {
  margin: '24px 0 0',
  color: '#334155',
  fontSize: '15px',
  lineHeight: '22px',
}

const footer: React.CSSProperties = {
  margin: '28px 0 0',
  paddingTop: '18px',
  borderTop: '1px solid #e2e8f0',
  color: '#94a3b8',
  fontSize: '12px',
  lineHeight: '18px',
}

export const template = {
  component: PortfolioRenewalDaysRemaining,
  subject: (data: Record<string, any>) => {
    const days = resolveDays(data?.days_remaining)
    const label = labelFor(days, data?.days_remaining_label)
    return `Portfolio renewal notice — ${label}`
  },
  displayName: 'Portfolio Renewal Notice',
  previewData: {
    partner_name: 'SSENKAALI PIUS',
    days_remaining: 7,
    days_remaining_label: 'Renews in 7 days',
    effective_date: '29 July 2026',
    company_name: 'Welile',
    portfolio_name: 'Test Growth Portfolio',
  },
} satisfies TemplateEntry