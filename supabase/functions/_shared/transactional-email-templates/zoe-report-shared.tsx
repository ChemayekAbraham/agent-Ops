import * as React from 'npm:react@18.3.1'
import {
  Body,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

export interface ZoeReportSharedProps {
  recipient_name?: string
  recipient_email?: string
  sender_name?: string
  sender_email?: string
  subject?: string
  message?: string
  report_title?: string
  source?: string
  period_label?: string
  generated_at?: string
  row_count?: number
  how_counted?: string
  attachment_filename?: string
  sign_in_only?: boolean
  sign_in_url?: string
  logo_url?: string
}

const PAGE_BG = '#F6F3FB'
const CARD_BG = '#FFFFFF'
const BRAND_PURPLE = '#6C21C4'
const BRAND_DARK = '#4C1696'
const GOLD_ACCENT = '#EFB02E'
const INK = '#0F172A'
const MUTED = '#64748B'
const HAIRLINE = '#E2E8F0'
const CALLOUT_BG = '#F5F3FF'

export function ZoeReportSharedEmail({
  recipient_name = 'Colleague',
  sender_name = 'Welile Staff Member',
  sender_email = '',
  message = 'Please find the attached official Welile report shared from Zoe.',
  report_title = 'Zoe Staff Operations Report',
  source = 'Official Welile Read-Only Report',
  period_label = 'Current Period',
  generated_at = '',
  row_count = 0,
  how_counted = 'Counted directly from official read-only server records.',
  attachment_filename = 'Welile-Zoe-Report.pdf',
  sign_in_only = false,
  sign_in_url = 'https://welilereceipts.com/me/zoe',
  logo_url = 'https://byrzshwlentqvktcksem.supabase.co/storage/v1/object/public/email-assets/welile-logo.png',
}: ZoeReportSharedProps) {
  return (
    <Html>
      <Head />
      <Preview>
        Report shared from Zoe: {report_title} ({period_label})
      </Preview>
      <Body style={{ margin: 0, padding: 0, backgroundColor: PAGE_BG, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <table width="100%" border={0} cellPadding={0} cellSpacing={0} role="presentation" style={{ backgroundColor: PAGE_BG }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: '28px 12px' }}>
                <table
                  width={600}
                  border={0}
                  cellPadding={0}
                  cellSpacing={0}
                  role="presentation"
                  style={{
                    backgroundColor: CARD_BG,
                    borderRadius: '12px',
                    border: `1px solid ${HAIRLINE}`,
                    overflow: 'hidden',
                  }}
                >
                  <tbody>
                    {/* Branded Purple Header Banner */}
                    <tr>
                      <td
                        style={{
                          backgroundColor: BRAND_DARK,
                          borderBottom: `3px solid ${GOLD_ACCENT}`,
                          padding: '22px 28px',
                        }}
                      >
                        <Img
                          src={logo_url}
                          alt="Welile"
                          width="112"
                          style={{
                            display: 'block',
                            backgroundColor: '#FFFFFF',
                            padding: '4px 8px',
                            borderRadius: '6px',
                          }}
                        />
                        <Heading
                          style={{
                            color: '#FFFFFF',
                            fontSize: '20px',
                            fontWeight: 700,
                            margin: '14px 0 4px 0',
                          }}
                        >
                          Report shared from Zoe
                        </Heading>
                        <Text
                          style={{
                            color: '#E9D5FF',
                            fontSize: '13px',
                            margin: 0,
                          }}
                        >
                          {report_title} · {period_label}
                        </Text>
                      </td>
                    </tr>

                    {/* Greeting & Sender Note */}
                    <tr>
                      <td style={{ padding: '24px 28px 8px 28px' }}>
                        <Text style={{ color: INK, fontSize: '14px', margin: '0 0 10px 0' }}>
                          Hi {recipient_name},
                        </Text>
                        <Text style={{ color: INK, fontSize: '14px', lineHeight: '21px', margin: '0 0 14px 0' }}>
                          <strong>{sender_name}</strong>
                          {sender_email ? ` (${sender_email})` : ''} shared an official Welile report with you from{' '}
                          <strong>Zoe (My Space Staff Assistant)</strong>.{' '}
                          {sign_in_only ? (
                            <>
                              Because this report requires two-step verification (MFA), no figures are included in this email. Please sign in to My Space to view or re-confirm this report.
                            </>
                          ) : (
                            <>
                              The full PDF report (<code>{attachment_filename}</code>) is attached to this email. For security, report figures and rows are never rendered inline in the email body.
                            </>
                          )}
                        </Text>

                        {message ? (
                          <div
                            style={{
                              backgroundColor: CALLOUT_BG,
                              borderLeft: `4px solid ${BRAND_PURPLE}`,
                              borderRadius: '6px',
                              padding: '12px 14px',
                              marginBottom: '16px',
                            }}
                          >
                            <Text style={{ color: INK, fontSize: '13px', lineHeight: '19px', margin: 0 }}>
                              {message}
                            </Text>
                          </div>
                        ) : null}

                        {sign_in_only ? (
                          <div style={{ margin: '16px 0 8px 0' }}>
                            <a
                              href={sign_in_url}
                              style={{
                                display: 'inline-block',
                                backgroundColor: BRAND_PURPLE,
                                color: '#FFFFFF',
                                fontWeight: 600,
                                fontSize: '13px',
                                padding: '10px 18px',
                                borderRadius: '8px',
                                textDecoration: 'none',
                              }}
                            >
                              Open Zoe in My Space
                            </a>
                          </div>
                        ) : null}
                      </td>
                    </tr>

                    {/* Report Metadata Box */}
                    <tr>
                      <td style={{ padding: '0 28px 16px 28px' }}>
                        <table
                          width="100%"
                          border={0}
                          cellPadding={0}
                          cellSpacing={0}
                          role="presentation"
                          style={{
                            border: `1px solid ${HAIRLINE}`,
                            borderRadius: '8px',
                            backgroundColor: '#F8FAFC',
                            padding: '12px 16px',
                          }}
                        >
                          <tbody>
                            <tr>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: MUTED, width: '36%' }}>
                                Report Title
                              </td>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: INK, fontWeight: 600 }}>
                                {report_title}
                              </td>
                            </tr>
                            <tr>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: MUTED }}>
                                Dates / Period
                              </td>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: INK, fontWeight: 600 }}>
                                {period_label}
                              </td>
                            </tr>
                            <tr>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: MUTED }}>
                                Official Source
                              </td>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: INK, fontWeight: 600 }}>
                                {source}
                              </td>
                            </tr>
                            {!sign_in_only ? (
                              <tr>
                                <td style={{ padding: '4px 0', fontSize: '12px', color: MUTED }}>
                                  Row Count
                                </td>
                                <td style={{ padding: '4px 0', fontSize: '12px', color: INK, fontWeight: 600 }}>
                                  {row_count} {row_count === 1 ? 'row' : 'rows'}
                                </td>
                              </tr>
                            ) : null}
                            {generated_at ? (
                              <tr>
                                <td style={{ padding: '4px 0', fontSize: '12px', color: MUTED }}>
                                  Generated Time
                                </td>
                                <td style={{ padding: '4px 0', fontSize: '12px', color: INK, fontWeight: 600 }}>
                                  {generated_at}
                                </td>
                              </tr>
                            ) : null}
                            <tr>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: MUTED }}>
                                How This Was Counted
                              </td>
                              <td style={{ padding: '4px 0', fontSize: '12px', color: INK }}>
                                {how_counted}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>

                    {/* Footer */}
                    <tr>
                      <td
                        style={{
                          borderTop: `1px solid ${HAIRLINE}`,
                          padding: '16px 28px',
                          backgroundColor: '#F8FAFC',
                        }}
                      >
                        <Text style={{ color: MUTED, fontSize: '11px', margin: 0 }}>
                          Welile Technologies Limited · Report shared from Zoe (My Space Staff Assistant) · Sent only to verified active Welile staff emails.
                        </Text>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </Body>
    </Html>
  )
}

export const template: TemplateEntry = {
  component: ZoeReportSharedEmail,
  displayName: 'Report shared from Zoe',
  subject: (data) =>
    data?.subject
      ? String(data.subject)
      : `Report shared from Zoe: ${data?.report_title || 'Welile Staff Report'}`,
  previewData: {
    recipient_name: 'Janehephzibar Gimono',
    sender_name: 'Winfred Asiimwe',
    sender_email: 'winnie@welile.com',
    report_title: 'Tenant Ops Repayments & Collection Rate Report',
    source: 'get_tenant_ops_repayments',
    period_label: '2026-10-01 to 2026-10-26',
    generated_at: '26 Oct 2026, 06:45 EAT',
    row_count: 18,
    how_counted:
      'Counted via official server RPC get_tenant_ops_repayments comparing scheduled daily charges against posted collections.',
    attachment_filename: 'welile-zoe-tenant-ops-repayments-2026-10-26.pdf',
  },
}
