/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface CashDepositWalletConfirmationProps {
  amountUgx?: number
  newBalanceUgx?: number | null
  depositorName?: string
  receiptCode?: string
  creditedAt?: string
}

const ugx = (amount: number | null | undefined): string =>
  typeof amount === 'number' && Number.isFinite(amount)
    ? `UGX ${Math.round(amount).toLocaleString('en-UG')}`
    : 'Not available'

export function CashDepositWalletConfirmationEmail({
  amountUgx = 0,
  newBalanceUgx = null,
  depositorName = 'there',
  receiptCode = '',
  creditedAt = new Date().toISOString(),
}: CashDepositWalletConfirmationProps) {
  const creditedWhen = new Date(creditedAt).toLocaleString('en-UG', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{ugx(amountUgx)} is now in your Welile Wallet</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={brandHeader}>
            <Img src="https://welileapp.com/welile-logo.png" width="132" alt="Welile" style={logo} />
          </Section>

          <Section style={content}>
            <Text style={eyebrow}>DEPOSIT CONFIRMED</Text>
            <Heading style={heading}>Money added to your Welile Wallet</Heading>
            <Text style={text}>Hi {depositorName},</Text>
            <Text style={text}>
              Your cash deposit was confirmed successfully. <strong>{ugx(amountUgx)}</strong> is now
              in your Welile Wallet.
            </Text>

            <Section style={amountPanel}>
              <Text style={amountLabel}>AMOUNT CREDITED</Text>
              <Text style={amountValue}>{ugx(amountUgx)}</Text>
            </Section>

            <Hr style={divider} />
            {newBalanceUgx !== null ? (
              <>
                <Text style={detailLabel}>AVAILABLE WALLET BALANCE</Text>
                <Text style={detailValue}>{ugx(newBalanceUgx)}</Text>
              </>
            ) : null}
            {receiptCode ? (
              <>
                <Text style={detailLabel}>RECEIPT CODE</Text>
                <Text style={detailValue}>{receiptCode}</Text>
              </>
            ) : null}
            <Text style={detailLabel}>CONFIRMED</Text>
            <Text style={detailValue}>{creditedWhen} EAT</Text>

            <Hr style={divider} />
            <Text style={muted}>
              You can sign in to Welile to view your updated Wallet balance and transaction history.
              If you did not make this deposit, contact Welile support immediately.
            </Text>
          </Section>

          <Section style={footer}>
            <Text style={footerTitle}>WELILE TECHNOLOGIES LTD</Text>
            <Text style={footerText}>Turning rent into an asset.</Text>
            <Text style={footerLink}>welileapp.com</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: '#ffffff',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
  margin: 0,
  padding: '32px 12px',
}
const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '12px',
  margin: '0 auto',
  maxWidth: '560px',
  overflow: 'hidden',
}
const brandHeader: React.CSSProperties = {
  borderTop: '6px solid #7b19d4',
  borderBottom: '1px solid #e2e8f0',
  padding: '24px 32px',
}
const logo: React.CSSProperties = { display: 'block', height: 'auto', maxWidth: '132px' }
const content: React.CSSProperties = { padding: '32px' }
const eyebrow: React.CSSProperties = {
  color: '#7b19d4',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  margin: '0 0 8px',
}
const heading: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '25px',
  fontWeight: 700,
  lineHeight: '32px',
  margin: '0 0 18px',
}
const text: React.CSSProperties = { color: '#334155', fontSize: '15px', lineHeight: '24px', margin: '0 0 14px' }
const amountPanel: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  margin: '22px 0',
  padding: '22px',
  textAlign: 'center' as const,
}
const amountLabel: React.CSSProperties = { color: '#64748b', fontSize: '11px', fontWeight: 700, margin: '0 0 6px' }
const amountValue: React.CSSProperties = { color: '#0f172a', fontSize: '30px', fontWeight: 700, margin: 0 }
const divider: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0' }
const detailLabel: React.CSSProperties = { color: '#94a3b8', fontSize: '11px', fontWeight: 700, margin: '0 0 3px' }
const detailValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 14px' }
const muted: React.CSSProperties = { color: '#64748b', fontSize: '13px', lineHeight: '20px', margin: 0 }
const footer: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderTop: '1px solid #e2e8f0',
  padding: '22px 32px',
  textAlign: 'center' as const,
}
const footerTitle: React.CSSProperties = { color: '#475569', fontSize: '11px', fontWeight: 700, margin: '0 0 5px' }
const footerText: React.CSSProperties = { color: '#64748b', fontSize: '12px', margin: '0 0 5px' }
const footerLink: React.CSSProperties = { color: '#7b19d4', fontSize: '12px', fontWeight: 600, margin: 0 }

export const template = {
  component: CashDepositWalletConfirmationEmail,
  subject: (data: Record<string, unknown>) =>
    `${ugx(Number(data?.amountUgx ?? 0))} is now in your Welile Wallet`,
  displayName: 'Cash deposit wallet confirmation',
  previewData: {
    amountUgx: 5000000,
    newBalanceUgx: 5125000,
    depositorName: 'Benjamin',
    receiptCode: '4821',
    creditedAt: new Date().toISOString(),
  },
} satisfies TemplateEntry