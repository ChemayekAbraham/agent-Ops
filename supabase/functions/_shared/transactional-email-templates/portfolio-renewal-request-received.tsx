import * as React from 'npm:react@18.3.1'
import { Body, Head, Heading, Html, Img, Link, Preview, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  portfolio_value?: number | string
  maturity_date?: string
  request_reference?: string
  submitted_at?: string
  currency?: string
  logo_url?: string
}

const fmt = (a: Props['portfolio_value'], c: string) => {
  const n = typeof a === 'number' ? a : Number(String(a ?? 0).replace(/,/g, ''))
  return `${c} ${Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a}`
}

const Step = ({ n, title, body, active }: { n: string; title: string; body: string; active?: boolean }) => (
  <tr>
    <td width={44} valign="top" style={{ paddingBottom: 16 }}>
      <div style={{
        width: 30, height: 30, borderRadius: 15, textAlign: 'center' as const, lineHeight: '30px', fontWeight: 800, fontSize: 14,
        background: active ? '#7b19d4' : '#f1f5f9', color: active ? '#ffffff' : '#64748b',
      }}>{n}</div>
    </td>
    <td valign="top" style={{ paddingBottom: 16 }}>
      <Text style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{title}</Text>
      <Text style={{ margin: '2px 0 0', fontSize: 14, color: '#475569', lineHeight: '20px' }}>{body}</Text>
    </td>
  </tr>
)

export function PortfolioRenewalRequestReceived({
  partner_name = 'Partner', portfolio_name = 'Partnership Portfolio', portfolio_id = '', portfolio_value = 0,
  maturity_date = '', request_reference = '', submitted_at = '', currency = 'UGX',
  logo_url = 'https://welileapp.com/welile-logo.png',
}: Props) {
  return (
    <Html>
      <Head />
      <Preview>{`We've received your renewal request for ${portfolio_id || portfolio_name}`}</Preview>
      <Body style={{ backgroundColor: '#f4f7f9', fontFamily: "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif", margin: 0, padding: '30px 10px' }}>
        <div style={{ maxWidth: 580, margin: '0 auto', background: '#ffffff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 4px 15px rgba(0,0,0,0.05)' }}>
          <div style={{ height: 6, background: 'linear-gradient(90deg, #7b19d4 0%, #a855f7 100%)' }} />
          <div style={{ padding: '28px 36px 8px' }}>
            <Img src={logo_url} alt="Welile" width="130" />
            <Text style={{ margin: '24px 0 4px', color: '#7b19d4', fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>
              Renewal request received
            </Text>
            <Heading style={{ margin: 0, fontSize: 24, color: '#0f172a', fontWeight: 800 }}>Your growth journey continues</Heading>
          </div>
          <div style={{ padding: '8px 36px 0' }}>
            <Text style={{ fontSize: 16, color: '#0f172a', fontWeight: 600 }}>Dear {partner_name},</Text>
            <Text style={{ fontSize: 15, color: '#475569', lineHeight: '24px' }}>
              Thank you for choosing to renew <strong>{portfolio_name}</strong>{portfolio_id ? <> (#{portfolio_id})</> : null}.
              Your request is with our Partner Ops team. Here is what happens next.
            </Text>
          </div>

          <div style={{ margin: '8px 36px 20px', border: '1px solid #e2e8f0', borderRadius: 12, background: '#fafaf9', padding: '18px 24px' }}>
            <table width="100%" role="presentation" cellPadding={0} cellSpacing={0}><tbody>
              <tr>
                <td width="50%" valign="top" style={{ paddingBottom: 12 }}>
                  <Text style={lbl}>Portfolio value</Text><Text style={val}>{fmt(portfolio_value, currency)}</Text>
                </td>
                <td width="50%" valign="top" style={{ paddingBottom: 12 }}>
                  <Text style={lbl}>Maturity date</Text><Text style={val}>{maturity_date || '—'}</Text>
                </td>
              </tr>
              <tr>
                <td width="50%" valign="top"><Text style={lbl}>Reference</Text><Text style={{ ...val, color: '#7b19d4' }}>{request_reference || '—'}</Text></td>
                <td width="50%" valign="top"><Text style={lbl}>Submitted</Text><Text style={val}>{submitted_at || '—'}</Text></td>
              </tr>
            </tbody></table>
          </div>

          <div style={{ padding: '0 36px 8px' }}>
            <table width="100%" role="presentation" cellPadding={0} cellSpacing={0}><tbody>
              <Step n="1" active title="Request received" body="We have your renewal request on record." />
              <Step n="2" title="Partner Ops review" body="Our team confirms your portfolio details and your final-cycle Returns." />
              <Step n="3" title="Renewal applied" body="On maturity, your final Returns are paid and a fresh term starts. We'll email you at each step." />
            </tbody></table>
          </div>

          <div style={{ padding: '0 36px 28px' }}>
            <Text style={{ fontSize: 14, color: '#475569', lineHeight: '22px', margin: 0 }}>
              No further action is needed from you. Questions? Simply reply to this email.
            </Text>
            <Text style={{ fontSize: 15, color: '#0f172a', fontWeight: 600, margin: '20px 0 0' }}>
              Warm regards,<br /><span style={{ color: '#475569' }}>Partnership Team</span>
            </Text>
          </div>
          <div style={{ padding: '16px 36px', borderTop: '1px solid #e5e7eb', textAlign: 'center' as const }}>
            <Text style={{ margin: 0, color: '#94a3b8', fontSize: 12 }}>
              <em>"Welile is turning rent into an asset."</em> ·{' '}
              <Link href="https://welileapp.com/partners-terms" style={{ color: '#94a3b8' }}>Terms</Link>
            </Text>
          </div>
        </div>
      </Body>
    </Html>
  )
}

const lbl: React.CSSProperties = { margin: '0 0 4px', color: '#94a3b8', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }
const val: React.CSSProperties = { margin: 0, color: '#0f172a', fontSize: 15, fontWeight: 700 }

export const template = {
  component: PortfolioRenewalRequestReceived,
  subject: (d: Record<string, any>) => `Renewal request received — ${d?.portfolio_id || ''}`.trim(),
  displayName: 'Renewal request received',
  previewData: {
    partner_name: 'Sarah Nakato', portfolio_name: 'Welile Growth Partnership', portfolio_id: 'WPF-1234',
    portfolio_value: 1800000, maturity_date: '28 October 2026', request_reference: 'REQ-1A2B3C4D',
    submitted_at: '23 October 2026', currency: 'UGX',
  },
} satisfies TemplateEntry
