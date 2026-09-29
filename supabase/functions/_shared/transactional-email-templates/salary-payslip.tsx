import * as React from 'npm:react@18.3.1'
import {
  Body,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface PayLine {
  name: string
  amount: number | string
}

interface SalaryPayslipProps {
  first_name?: string
  period_label?: string
  net_pay?: number | string
  currency?: string
  staff_ref?: string
  position?: string
  department?: string
  paid_on?: string
  earnings?: PayLine[]
  gross_pay?: number | string
  deductions?: PayLine[]
  total_deductions?: number | string
  employer_nssf?: number | string
  payslip_url?: string
  logo_url?: string
}

const toNum = (v: number | string | undefined | null) => {
  if (v === undefined || v === null || v === '') return 0
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}
const fmt = (v: number | string | undefined | null) =>
  toNum(v).toLocaleString('en-US', { maximumFractionDigits: 0 })

export function SalaryPayslip({
  first_name = 'Team Member',
  period_label = '',
  net_pay = 0,
  currency = 'UGX',
  staff_ref = '',
  position = '',
  department = '',
  paid_on = '',
  earnings = [],
  gross_pay = 0,
  deductions = [],
  total_deductions = 0,
  employer_nssf = 0,
  payslip_url = 'https://welileapp.com/my-pay',
  logo_url = 'https://wirntoujqoyjobfhyelc.supabase.co/storage/v1/object/public/email-assets/welile-logo.png',
}: SalaryPayslipProps) {
  const year = new Date().getFullYear()
  const details: Array<[string, string]> = [
    ['Staff ref', staff_ref],
    ['Position', position],
    ['Department', department],
    ['Paid on', paid_on],
  ]
  const shownDetails = details.filter(([, v]) => v)
  const employerNssfNum = toNum(employer_nssf)

  const row = (label: string, amount: number | string, opts: { bold?: boolean; last?: boolean } = {}) => (
    <tr key={label + String(amount)}>
      <td style={{ ...cellLabel, fontWeight: opts.bold ? 700 : 500, borderBottom: opts.last ? 'none' : `1px solid ${HAIRLINE}` }}>
        {label}
      </td>
      <td align="right" style={{ ...cellAmount, fontWeight: opts.bold ? 800 : 600, borderBottom: opts.last ? 'none' : `1px solid ${HAIRLINE}` }}>
        {fmt(amount)}
      </td>
    </tr>
  )

  return (
    <Html>
      <Head />
      <Preview>
        Your salary for {period_label} has been paid — net pay {currency} {fmt(net_pay)}
      </Preview>
      <Body style={main}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ backgroundColor: PAGE_BG }}>
          <tbody><tr><td align="center" style={{ padding: '32px 10px' }}>
            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" style={card}>
              <tbody>
                <tr><td height={6} style={accentBar}></td></tr>
                <tr>
                  <td style={{ padding: '28px 32px 8px 32px' }}>
                    <Img src={logo_url} alt="Welile" width="120" style={{ display: 'block' }} />
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: '16px 32px 0 32px' }}>
                    <Heading style={h1}>Your payslip — {period_label}</Heading>
                    <Text style={p}>Hi {first_name},</Text>
                    <Text style={p}>
                      Your salary for {period_label} has been paid to your Welile wallet. Here is your payslip.
                    </Text>
                  </td>
                </tr>

                {/* Net pay */}
                <tr>
                  <td style={{ padding: '8px 32px 0 32px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={netBox}>
                      <tbody><tr><td align="center" style={{ padding: '24px 16px' }}>
                        <Text style={netLabel}>Net pay</Text>
                        <Text style={netValue}>{currency} {fmt(net_pay)}</Text>
                      </td></tr></tbody>
                    </table>
                  </td>
                </tr>

                {/* Staff details */}
                {shownDetails.length > 0 ? (
                  <tr>
                    <td style={{ padding: '16px 32px 0 32px' }}>
                      <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation">
                        <tbody>
                          {shownDetails.map(([k, v]) => (
                            <tr key={k}>
                              <td style={detailKey}>{k}</td>
                              <td align="right" style={detailVal}>{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}

                {/* Earnings */}
                <tr>
                  <td style={{ padding: '24px 32px 0 32px' }}>
                    <Text style={sectionHead}>Earnings</Text>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={tableBox}>
                      <tbody>
                        {earnings.map((l) => row(l.name, l.amount))}
                        {row('Gross pay', gross_pay, { bold: true, last: true })}
                      </tbody>
                    </table>
                  </td>
                </tr>

                {/* Deductions */}
                <tr>
                  <td style={{ padding: '24px 32px 0 32px' }}>
                    <Text style={sectionHead}>Deductions</Text>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={tableBox}>
                      <tbody>
                        {deductions.map((l) => row(l.name, l.amount))}
                        {row('Total deductions', total_deductions, { bold: true, last: true })}
                      </tbody>
                    </table>
                  </td>
                </tr>

                {/* Net pay line */}
                <tr>
                  <td style={{ padding: '16px 32px 0 32px' }}>
                    <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ ...tableBox, backgroundColor: ACCENT_BG }}>
                      <tbody>{row('Net pay', net_pay, { bold: true, last: true })}</tbody>
                    </table>
                  </td>
                </tr>

                {employerNssfNum > 0 ? (
                  <tr>
                    <td style={{ padding: '20px 32px 0 32px' }}>
                      <Text style={note}>
                        Welile also contributed {currency} {fmt(employerNssfNum)} to your NSSF account this month.
                        It is paid by the company and is not deducted from your salary.
                      </Text>
                    </td>
                  </tr>
                ) : null}

                {/* CTA */}
                <tr>
                  <td align="center" style={{ padding: '28px 32px 8px 32px' }}>
                    <Link href={payslip_url} style={button}>View your payslip</Link>
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: '16px 32px 32px 32px' }}>
                    <Text style={{ ...note, textAlign: 'center' as const }}>
                      Keep this email for your records. If anything on your payslip looks wrong, contact HR.
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>

            <table width={600} border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ marginTop: '24px' }}>
              <tbody><tr><td align="center" style={{ padding: '0 20px' }}>
                <Text style={footerText}>WELILE TECHNOLOGIES LTD · Palm Lane Kabaale, Entebbe</Text>
                <Text style={footerText}>
                  This is an automated message containing your personal pay details. Please do not forward it.
                </Text>
                <Text style={footerText}>© {year} Welile. All rights reserved.</Text>
              </td></tr></tbody>
            </table>
          </td></tr></tbody>
        </table>
      </Body>
    </Html>
  )
}

const BRAND = '#7b19d4'
const ACCENT_BG = '#fcf9ff'
const INK = '#0f172a'
const BODY = '#475569'
const SUB = '#64748b'
const MUTED = '#94a3b8'
const BORDER = '#e2e8f0'
const HAIRLINE = '#f1f5f9'
const PAGE_BG = '#f4f7f9'
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const main: React.CSSProperties = { margin: 0, padding: 0, backgroundColor: PAGE_BG, fontFamily: FONT_STACK }
const card: React.CSSProperties = { backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', maxWidth: '100%' }
const accentBar: React.CSSProperties = { backgroundColor: BRAND, backgroundImage: `linear-gradient(90deg, ${BRAND} 0%, #a855f7 100%)` }
const h1: React.CSSProperties = { margin: '0 0 12px 0', color: INK, fontSize: '24px', fontWeight: 800 }
const p: React.CSSProperties = { margin: '0 0 12px 0', color: BODY, fontSize: '15px', lineHeight: '24px' }
const netBox: React.CSSProperties = { backgroundColor: ACCENT_BG, border: `1px solid ${BORDER}`, borderRadius: '12px' }
const netLabel: React.CSSProperties = { margin: '0 0 6px 0', color: SUB, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }
const netValue: React.CSSProperties = { margin: 0, color: BRAND, fontSize: '34px', fontWeight: 800 }
const detailKey: React.CSSProperties = { padding: '5px 0', color: SUB, fontSize: '13px', fontWeight: 600 }
const detailVal: React.CSSProperties = { padding: '5px 0', color: INK, fontSize: '13px', fontWeight: 600 }
const sectionHead: React.CSSProperties = { margin: '0 0 8px 0', color: INK, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1.5px' }
const tableBox: React.CSSProperties = { border: `1px solid ${BORDER}`, borderRadius: '8px' }
const cellLabel: React.CSSProperties = { padding: '10px 14px', color: INK, fontSize: '14px' }
const cellAmount: React.CSSProperties = { padding: '10px 14px', color: INK, fontSize: '14px', fontVariantNumeric: 'tabular-nums' }
const note: React.CSSProperties = { margin: 0, color: SUB, fontSize: '13px', lineHeight: '20px' }
const button: React.CSSProperties = { display: 'inline-block', backgroundColor: BRAND, color: '#ffffff', fontSize: '15px', fontWeight: 700, textDecoration: 'none', padding: '13px 28px', borderRadius: '8px' }
const footerText: React.CSSProperties = { margin: '0 0 8px 0', color: MUTED, fontSize: '12px', lineHeight: '18px', textAlign: 'center' as const }

export const template = {
  component: SalaryPayslip,
  subject: (data: Record<string, any>) => `Your payslip for ${data?.period_label ?? 'this month'}`,
  displayName: 'Salary Payslip',
  previewData: {
    first_name: 'Jane',
    period_label: 'September 2026',
    net_pay: 748000,
    currency: 'UGX',
    staff_ref: 'WLE-0042',
    position: 'Finance Officer',
    department: 'Finance',
    paid_on: '30 September 2026',
    earnings: [
      { name: 'Basic salary', amount: 1000000 },
      { name: 'Transport allowance', amount: 100000 },
    ],
    gross_pay: 1100000,
    deductions: [
      { name: 'PAYE', amount: 297000 },
      { name: 'NSSF (your 5%)', amount: 55000 },
    ],
    total_deductions: 352000,
    employer_nssf: 100000,
    payslip_url: 'https://welileapp.com/my-pay',
  },
} satisfies TemplateEntry
