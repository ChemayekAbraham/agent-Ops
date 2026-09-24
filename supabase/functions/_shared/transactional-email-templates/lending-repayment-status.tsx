import * as React from 'npm:react@18.3.1'
import { Body, Container, Head, Heading, Html, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  borrowerName?: string
  status?: 'overdue' | 'deducted'
  amount?: number
  remainingBalance?: number
  overdueDates?: string[]
}

const money = (value = 0) => `UGX ${Math.max(0, Math.round(value)).toLocaleString('en-US')}`

export function LendingRepaymentStatus({
  borrowerName = 'there', status = 'overdue', amount = 0, remainingBalance = 0, overdueDates = [],
}: Props) {
  const paid = status === 'deducted'
  const title = paid ? `${money(amount)} repayment recovered` : 'Your repayment is overdue'
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{title}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={accent} />
          <Section style={content}>
            <Heading style={heading}>{title}</Heading>
            <Text style={body}>Hello {borrowerName},</Text>
            <Text style={body}>
              {paid
                ? `${money(amount)} was recovered from your available Welile wallet balance. Your remaining balance is ${money(remainingBalance)}.`
                : 'Keep money in your Welile wallet so the overdue repayment can be recovered automatically.'}
            </Text>
            {overdueDates.length > 0 && (
              <Section style={notice}>
                <Text style={label}>OVERDUE DATES</Text>
                <Text style={dates}>{overdueDates.join(', ')}</Text>
              </Section>
            )}
            <Text style={body}>
              Consistent repayments from a funded wallet can improve your eligibility for future access, up to UGX 30,000,000. Eligibility is assessed and is not guaranteed.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: LendingRepaymentStatus,
  subject: (data: Record<string, any>) => data?.status === 'deducted'
    ? `${money(Number(data?.amount) || 0)} repayment recovered`
    : 'Your Welile repayment is overdue',
  displayName: 'Lending repayment status',
  previewData: { borrowerName: 'Enock', status: 'overdue', remainingBalance: 2091200, overdueDates: ['2026-09-21', '2026-09-22'] },
} satisfies TemplateEntry

const main: React.CSSProperties = { backgroundColor: '#ffffff', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", margin: 0, padding: '24px 12px' }
const container: React.CSSProperties = { maxWidth: '580px', margin: '0 auto', border: '1px solid #e2e8f0', borderRadius: '10px', overflow: 'hidden' }
const accent: React.CSSProperties = { height: '6px', backgroundColor: '#15803d' }
const content: React.CSSProperties = { padding: '28px 32px' }
const heading: React.CSSProperties = { color: '#0f172a', fontSize: '24px', margin: '0 0 16px' }
const body: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '23px' }
const notice: React.CSSProperties = { backgroundColor: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '8px', padding: '14px 16px', margin: '18px 0' }
const label: React.CSSProperties = { color: '#9a3412', fontSize: '11px', fontWeight: 700, margin: '0 0 6px' }
const dates: React.CSSProperties = { color: '#7c2d12', fontSize: '14px', lineHeight: '22px', margin: 0 }