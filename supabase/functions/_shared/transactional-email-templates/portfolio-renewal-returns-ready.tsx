import * as React from 'npm:react@18.3.1'
import { Body, Head, Heading, Html, Img, Link, Preview, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  partner_name?: string
  portfolio_name?: string
  portfolio_id?: string
  amount?: number | string | null
  paid_date?: string
  renewal_date?: string
  new_maturity_date?: string
  currency?: string
  logo_url?: string
}

const fmt = (a: Props['amount'], c: string) => {
  if (a === null || a === undefined || a === '') return null
  const n = typeof a === 'number' ? a : Number(String(a).replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return `${c} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function PortfolioRenewalReturnsReady({
  partner_name = 'Partner', portfolio_name = 'Partnership Portfolio', portfolio_id = '',
  amount = null, paid_date = '', renewal_date = '', new_maturity_date = '',
  currency = 'UGX', logo_url = 'https://welileapp.com/welile-logo.png',
}: Props) {
  const amt = fmt(amount, currency)
  return (
    <Html>
      <Head />
      <Preview>{amt ? `Your final-cycle Returns of ${amt} are ready` : 'Your final-cycle Returns are ready'}</Preview>
      <Body style={{ backgroundColor: '#f4f7f9', fontFamily: "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif", margin: 0, padding: '30px 10px' }}>
        <div style={{ maxWidth: 580, margin: '0 auto', background: '#ffffff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 4px 15px rgba(0,0,0,0.05)' }}>
          <div style={{ height: 6, background: 'linear-gradient(90deg, #7b19d4 0%, #a855f7 100%)' }} />
          <div style={{ padding: '28px 36px 8px' }}>
            <Img src={logo_url} alt="Welile" width="130" />
            <Text style={{ margin: '24px 0 4px', color: '#7b19d4', fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>
              Renewal complete · Returns ready
            </Text>
            <Heading style={{ margin: 0, fontSize: 24, color: '#0f172a', fontWeight: 800 }}>Your Returns are ready</Heading>
          </div>

          <div style={{ padding: '8px 36px 0' }}>
            <Text style={{ fontSize: 16, color: '#0f172a', fontWeight: 600 }}>Dear {partner_name},</Text>
            <Text style={{ fontSize: 15, color: '#475569', lineHeight: '24px' }}>
              Your portfolio <strong>{portfolio_name}</strong>{portfolio_id ? <> (#{portfolio_id})</> : null} has finished its term
              and has been renewed{renewal_date ? ` on ${renewal_date}` : ''}. The Returns for its final cycle have been paid
              out{paid_date ? ` on ${paid_date}` : ''} and are ready for you to use or withdraw.
            </Text>
          </div>

          <div style={{ margin: '8px 36px 24px', border: '1px solid #e2e8f0', borderRadius: 12, background: '#faf5ff', padding: '22px 26px', textAlign: 'center' as const }}>
            <Text style={{ margin: '0 0 6px', color: '#64748b', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
              Final-cycle Returns
            </Text>
            <Text style={{ margin: 0, color: '#7b19d4', fontSize: 28, fontWeight: 800 }}>{amt ?? 'Paid to your wallet'}</Text>
            {new_maturity_date ? (
              <Text style={{ margin: '10px 0 0', color: '#475569', fontSize: 14 }}>
                Your renewed portfolio now runs until <strong>{new_maturity_date}</strong>.
              </Text>
            ) : null}
          </div>

          <div style={{ padding: '0 36px 28px' }}>
            <Text style={{ fontSize: 14, color: '#475569', lineHeight: '22px', margin: 0 }}>
              ✓ Final cycle Returns paid &nbsp;&nbsp; ✓ Portfolio renewed &nbsp;&nbsp; → New cycle started
            </Text>
            <Text style={{ fontSize: 14, color: '#475569', lineHeight: '22px' }}>
              If a Proxy Agent manages your payouts, they will deliver this money to you. A separate email confirms your
              renewed portfolio details.
            </Text>
            <Text style={{ fontSize: 15, color: '#0f172a', fontWeight: 600, margin: '20px 0 0' }}>
              Thank you for growing with Welile,<br /><span style={{ color: '#475569' }}>Partnership Team</span>
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

export const template = {
  component: PortfolioRenewalReturnsReady,
  subject: (d: Record<string, any>) => {
    const a = fmt(d?.amount, d?.currency || 'UGX')
    return `Your Returns are ready${a ? ` — ${a}` : ''} · ${d?.portfolio_id || 'portfolio'} renewed`
  },
  displayName: 'Renewal — Returns ready',
  previewData: {
    partner_name: 'Sarah Nakato', portfolio_name: 'Welile Growth Partnership', portfolio_id: 'WPF-1234',
    amount: 270000, paid_date: '23 October 2026', renewal_date: '23 October 2026',
    new_maturity_date: '23 October 2027', currency: 'UGX',
  },
} satisfies TemplateEntry
