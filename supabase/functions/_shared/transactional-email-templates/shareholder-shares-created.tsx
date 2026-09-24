import * as React from 'npm:react@18.3.1'
import { Body, Container, Head, Heading, Html, Link, Preview, Section, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  shareholder_name?: string
  pool_name?: string
  shares_allocated?: number | string
  currency?: string
  investment_amount?: number | string
  ownership_percentage?: string
  share_reference?: string
  allocation_date?: string
  fill_details_url?: string
  link_expiry_days?: number
}

const fmt = (v: number | string | undefined) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '0').replace(/,/g, ''))
  return Number.isNaN(n) ? String(v) : n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

export function ShareholderSharesCreated({
  shareholder_name = 'Shareholder',
  pool_name = 'Welile Early Angel Pool',
  shares_allocated = 0,
  currency = 'UGX',
  investment_amount = 0,
  ownership_percentage = '0',
  share_reference = '',
  allocation_date = '',
  fill_details_url = 'https://welileapp.com',
  link_expiry_days = 7,
}: Props) {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Your Welile shares have been created — signature required</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={hero}>
            <Text style={badge}>Share Allocation</Text>
            <Heading style={h1}>Your Shares Have Been Created!</Heading>
            <Text style={heroSub}>Early Angel Pool • Welile Technologies Limited</Text>
          </Section>

          <Section style={content}>
            <Text style={p}>Dear {shareholder_name},</Text>
            <Text style={p}>
              We are delighted to confirm that your share allocation in the Welile Early Angel Pool has been
              successfully created in our system. You are now officially part of our early angel shareholder
              community turning rent into an asset.
            </Text>
            <Text style={p}>
              To finalize your shareholding record, please review the Early Angel Pool Shareholders Agreement and
              provide your name and signature.
            </Text>

            <Section style={card}>
              <Text style={cardTitle}>Allocation Summary</Text>
              <Text style={cardPool}>{pool_name} <span style={pending}>● Signature Pending</span></Text>
              <table width="100%" cellPadding={0} cellSpacing={0} role="presentation">
                <tbody>
                  <tr>
                    <td style={statCell}><Text style={statLabel}>Shares Allocated</Text><Text style={statValue}>{fmt(shares_allocated)}</Text></td>
                    <td style={statCell}><Text style={statLabel}>Total Value</Text><Text style={statValue}>{currency} {fmt(investment_amount)}</Text></td>
                    <td style={statCell}><Text style={statLabel}>Ownership</Text><Text style={statValue}>{ownership_percentage}%</Text></td>
                  </tr>
                </tbody>
              </table>
              <Text style={meta}>Share Reference ID: <strong>{share_reference}</strong></Text>
              <Text style={meta}>Allocation Date: <strong>{allocation_date}</strong></Text>
              <Text style={meta}>Total Pool Equity: <strong>8.0% of Welile Technologies (U) Ltd</strong></Text>
            </Section>

            <Text style={stepsTitle}>Required to complete (Takes ~1 minute):</Text>
            <Text style={step}><strong>1. Confirm Participant Name</strong> — verify your full legal name as it appears on the agreement.</Text>
            <Text style={step}><strong>2. Sign and Date the Agreement</strong> — provide your signature and signing date to execute the agreement.</Text>

            <Section style={{ textAlign: 'center', margin: '28px 0 12px' }}>
              <Link href={fill_details_url} style={button}>Review &amp; Sign Agreement →</Link>
            </Section>
            <Text style={small}>
              Having trouble with the button above? Tap here: <Link href={fill_details_url} style={link}>{fill_details_url}</Link>
            </Text>
            <Text style={notice}>
              <strong>Secure Link:</strong> This signing link is unique to your shareholder record and will expire in {link_expiry_days} days.
              You will be asked to sign in to your Welile account.
            </Text>
            <Text style={p}>
              If you have any questions, please contact our Partnership relations team at{' '}
              <Link href="mailto:partnership@welile.com" style={link}>partnership@welile.com</Link> or call +256 744475573.
            </Text>
            <Text style={p}>Warm regards,<br />Partnership Relations<br />Welile Technologies Limited</Text>
          </Section>

          <Section style={footer}>
            <Text style={footerText}>WELILE TECHNOLOGIES LIMITED</Text>
            <Text style={footerText}>Palm Lane, Kabaale – Entebbe • P.O. Box 167564, Kampala – Uganda</Text>
            <Text style={footerText}>
              You are receiving this communication because shares have been allocated to you in the Welile Early Angel Pool.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: ShareholderSharesCreated,
  subject: 'Your Welile Shares Have Been Created - Signature Required',
  displayName: 'Shareholder shares created',
  previewData: {
    shareholder_name: 'Jane Doe', shares_allocated: 50, investment_amount: 1000000,
    ownership_percentage: '0.0160', share_reference: 'ANG2609241234', allocation_date: '24 September 2026',
    fill_details_url: 'https://welileapp.com/shares/x/sign?token=y', link_expiry_days: 7,
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, Helvetica, sans-serif', margin: 0, padding: 0 }
const container = { maxWidth: '600px', margin: '0 auto', border: '1px solid #e2e8f0', borderRadius: '14px', overflow: 'hidden' }
const hero = { backgroundColor: '#7b19d4', padding: '32px 28px', textAlign: 'center' as const }
const badge = { display: 'inline-block', backgroundColor: '#f3e8ff', color: '#6b21a8', fontSize: '12px', fontWeight: 700, padding: '4px 12px', borderRadius: '999px', margin: '0 0 12px' }
const h1 = { color: '#ffffff', fontSize: '24px', margin: '0 0 6px' }
const heroSub = { color: '#f3e8ff', fontSize: '13px', margin: 0 }
const content = { padding: '28px' }
const p = { color: '#475569', fontSize: '15px', lineHeight: '24px', margin: '0 0 14px' }
const card = { backgroundColor: '#fafaf9', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '18px', margin: '18px 0' }
const cardTitle = { color: '#64748b', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 6px' }
const cardPool = { color: '#0f172a', fontSize: '16px', fontWeight: 700, margin: '0 0 12px' }
const pending = { color: '#b45309', fontSize: '12px', fontWeight: 600 }
const statCell = { verticalAlign: 'top' as const, padding: '4px' }
const statLabel = { color: '#94a3b8', fontSize: '11px', margin: '0 0 2px' }
const statValue = { color: '#0f172a', fontSize: '16px', fontWeight: 700, margin: 0 }
const meta = { color: '#64748b', fontSize: '13px', margin: '6px 0 0' }
const stepsTitle = { color: '#0f172a', fontSize: '14px', fontWeight: 700, margin: '20px 0 8px' }
const step = { color: '#475569', fontSize: '14px', lineHeight: '22px', margin: '0 0 8px' }
const button = { backgroundColor: '#7b19d4', color: '#ffffff', padding: '14px 28px', borderRadius: '10px', fontWeight: 700, fontSize: '15px', textDecoration: 'none', display: 'inline-block' }
const small = { color: '#94a3b8', fontSize: '12px', lineHeight: '18px', margin: '0 0 14px', wordBreak: 'break-all' as const }
const link = { color: '#7b19d4' }
const notice = { backgroundColor: '#f1f5f9', color: '#475569', fontSize: '13px', lineHeight: '20px', padding: '12px 14px', borderRadius: '8px', margin: '0 0 16px' }
const footer = { backgroundColor: '#f4f7f9', padding: '20px 28px', textAlign: 'center' as const }
const footerText = { color: '#94a3b8', fontSize: '11px', lineHeight: '16px', margin: '0 0 4px' }
