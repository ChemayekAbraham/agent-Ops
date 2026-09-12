/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface CashDepositWalletConfirmationProps {
  amountUgx?: number
  newBalanceUgx?: number | null
  depositorName?: string
  maskedDepositCode?: string
  depositedAt?: string
  referenceNumber?: string
  supportPhone?: string
  supportWhatsapp?: string
  helpLink?: string
  receiptDownloadUrl?: string | null
  facilitatedRentVolume?: number | null
  platformServiceFees?: number | null
  transactionExpenses?: number | null
  codeExpiredAt?: string | null
}

const ugx = (amount: number | null | undefined): string =>
  typeof amount === 'number' && Number.isFinite(amount)
    ? `UGX ${Math.round(amount).toLocaleString('en-UG')}`
    : 'Not available'

export function CashDepositWalletConfirmationEmail({
  amountUgx = 0,
  newBalanceUgx = null,
  depositorName = 'there',
  maskedDepositCode = '',
  depositedAt = new Date().toISOString(),
  referenceNumber = '',
  supportPhone = '+256 708 257 899',
  supportWhatsapp = '+256708257899',
  helpLink = 'https://welileapp.com/help',
  receiptDownloadUrl = null,
  facilitatedRentVolume = null,
  platformServiceFees = null,
  transactionExpenses = null,
  codeExpiredAt = null,
}: CashDepositWalletConfirmationProps) {
  const depositedWhen = new Date(depositedAt).toLocaleString('en-UG', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const codeExpiry = codeExpiredAt
    ? new Date(codeExpiredAt).toLocaleString('en-UG', {
        timeZone: 'Africa/Kampala',
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

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

            <Section style={breakdownPanel}>
              <Text style={breakdownTitle}>RECORDED BREAKDOWN</Text>
              <Text style={breakdownRow}>Facilitated rent volume <strong>{ugx(facilitatedRentVolume)}</strong></Text>
              <Text style={breakdownRow}>Platform service fees <strong>{ugx(platformServiceFees)}</strong></Text>
              <Text style={breakdownRow}>Transaction expenses <strong>{ugx(transactionExpenses)}</strong></Text>
              <Text style={breakdownNote}>Values appear only when recorded against this deposit.</Text>
            </Section>

            <Hr style={divider} />
            {referenceNumber ? (
              <>
                <Text style={detailLabel}>REFERENCE NUMBER</Text>
                <Text style={detailValue}>{referenceNumber}</Text>
              </>
            ) : null}
            <Text style={detailLabel}>TRANSACTION DATE &amp; TIME</Text>
            <Text style={detailValue}>{depositedWhen} EAT</Text>
            {newBalanceUgx !== null ? (
              <>
                <Text style={detailLabel}>AVAILABLE WALLET BALANCE</Text>
                <Text style={detailValue}>{ugx(newBalanceUgx)}</Text>
              </>
            ) : null}
            {maskedDepositCode ? (
              <>
                <Text style={detailLabel}>DEPOSIT CODE</Text>
                <Text style={detailValue}>{maskedDepositCode}</Text>
              </>
            ) : null}
            {codeExpiry ? (
              <Text style={codeUsedNote}>
                This code was valid until {codeExpiry} EAT (Kampala time). It has already been used and no longer works.
              </Text>
            ) : null}
            {receiptDownloadUrl ? (
              <Section style={receiptAction}>
                <Button href={receiptDownloadUrl} style={receiptButton}>Download PDF receipt</Button>
                <Text style={receiptHint}>This secure receipt link is available for 30 days.</Text>
              </Section>
            ) : null}
            <Hr style={divider} />
            <Text style={muted}>
              You can sign in to Welile to view your updated Wallet balance and transaction history.
              If you did not make this deposit, contact Welile support immediately.
            </Text>
          </Section>

          <Section style={helpSection}>
            <Text style={helpTitle}>Need help?</Text>
            <Text style={helpText}>
              If you have questions about this deposit, message us on{' '}
              <Link href={`https://wa.me/${supportWhatsapp.replace(/\D/g, '')}`} style={helpLinkStyle}>
                WhatsApp
              </Link>{' '}
              or call <strong>{supportPhone}</strong>.
            </Text>
            <Text style={helpText}>
              Visit our <Link href={helpLink} style={helpLinkStyle}>help center</Link> for quick answers.
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
const breakdownPanel: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  margin: '0 0 22px',
  padding: '18px 20px',
}
const breakdownTitle: React.CSSProperties = { color: '#7b19d4', fontSize: '11px', fontWeight: 700, margin: '0 0 12px' }
const breakdownRow: React.CSSProperties = { color: '#334155', fontSize: '14px', lineHeight: '22px', margin: '0 0 5px' }
const breakdownNote: React.CSSProperties = { color: '#64748b', fontSize: '12px', lineHeight: '18px', margin: '10px 0 0' }
const divider: React.CSSProperties = { borderColor: '#e2e8f0', margin: '20px 0' }
const detailLabel: React.CSSProperties = { color: '#94a3b8', fontSize: '11px', fontWeight: 700, margin: '0 0 3px' }
const detailValue: React.CSSProperties = { color: '#0f172a', fontSize: '14px', margin: '0 0 14px' }
const muted: React.CSSProperties = { color: '#64748b', fontSize: '13px', lineHeight: '20px', margin: 0 }
const codeUsedNote: React.CSSProperties = { color: '#64748b', fontSize: '12px', lineHeight: '19px', margin: '2px 0 18px' }
const receiptAction: React.CSSProperties = { margin: '24px 0 4px', textAlign: 'center' as const }
const receiptButton: React.CSSProperties = {
  backgroundColor: '#7b19d4',
  borderRadius: '6px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '14px',
  fontWeight: 700,
  padding: '12px 22px',
  textDecoration: 'none',
}
const receiptHint: React.CSSProperties = { color: '#64748b', fontSize: '12px', margin: '10px 0 0' }
const footer: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderTop: '1px solid #e2e8f0',
  padding: '22px 32px',
  textAlign: 'center' as const,
}
const footerTitle: React.CSSProperties = { color: '#475569', fontSize: '11px', fontWeight: 700, margin: '0 0 5px' }
const footerText: React.CSSProperties = { color: '#64748b', fontSize: '12px', margin: '0 0 5px' }
const footerLink: React.CSSProperties = { color: '#7b19d4', fontSize: '12px', fontWeight: 600, margin: 0 }
const helpSection: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  borderTop: '1px solid #e2e8f0',
  padding: '22px 32px',
}
const helpTitle: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '14px',
  fontWeight: 700,
  margin: '0 0 8px',
}
const helpText: React.CSSProperties = {
  color: '#475569',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0 0 6px',
}
const helpLinkStyle: React.CSSProperties = {
  color: '#7b19d4',
  fontWeight: 600,
  textDecoration: 'underline',
}

export const template = {
  component: CashDepositWalletConfirmationEmail,
  subject: (data: Record<string, unknown>) =>
    `${ugx(Number(data?.amountUgx ?? 0))} is now in your Welile Wallet`,
  displayName: 'Cash deposit wallet confirmation',
  previewData: {
    amountUgx: 5000000,
    newBalanceUgx: 5125000,
    depositorName: 'Benjamin',
    maskedDepositCode: '••21',
    depositedAt: new Date().toISOString(),
    referenceNumber: 'DEP-5A7C91E2',
    receiptDownloadUrl: 'https://welileapp.com',
    facilitatedRentVolume: 4500000,
    platformServiceFees: 350000,
    transactionExpenses: 150000,
    codeExpiredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  },
} satisfies TemplateEntry