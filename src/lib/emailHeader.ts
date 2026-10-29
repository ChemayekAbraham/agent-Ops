// Official Welile Technologies Limited email letterhead (browser copy).
// Mirrors supabase/functions/_shared/emailHeader.ts — keep the two in sync so
// previews match exactly what the dispatcher sends.

export const WELILE_EMAIL_HEADER_MARKER = 'data-welile-email-header="1"'

export const WELILE_EMAIL_BRAND_INFO = {
  legalName: 'Welile Technologies Limited',
  hqStreetAddress: 'Palm Lane, Kabaale, Entebbe, Uganda',
  poBox: 'P.O. Box 1675664',
  fullPostalAddress: 'Palm Lane, Kabaale, Entebbe, Uganda | P.O. Box 1675664',
  officialEmail: 'info@welile.com',
  supportEmail: 'support@welile.com',
  websiteDomain: 'welile.com',
  websiteUrl: 'https://welile.com',
  appDomain: 'welileapp.com',
  appUrl: 'https://welileapp.com',
  customerCareNumber: '+256 748 747 134',
  customerCareTel: 'tel:+256748747134',
  logoUrl: 'https://welileapp.com/welile-logo.png',
} as const

export const WELILE_EMAIL_BRAND_HEADER_HTML = `<table ${WELILE_EMAIL_HEADER_MARKER} width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#ffffff;border-bottom:2px solid #7b19d4;">
  <tr>
    <td align="center" style="padding:18px 16px 14px 16px;">
      <table width="600" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;">
        <tr>
          <td align="left" valign="middle" width="120" style="padding-right:14px;">
            <img src="${WELILE_EMAIL_BRAND_INFO.logoUrl}" alt="${WELILE_EMAIL_BRAND_INFO.legalName}" width="110" style="display:block;max-width:110px;height:auto;border:0;" />
          </td>
          <td align="left" valign="middle" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <div style="font-size:16px;font-weight:800;color:#0f172a;letter-spacing:0.2px;">${WELILE_EMAIL_BRAND_INFO.legalName}</div>
            <div style="font-size:11px;color:#64748b;line-height:16px;padding-top:3px;">${WELILE_EMAIL_BRAND_INFO.fullPostalAddress}</div>
            <div style="font-size:11px;color:#64748b;line-height:16px;">
              Customer Care: <a href="${WELILE_EMAIL_BRAND_INFO.customerCareTel}" style="color:#7b19d4;text-decoration:none;">${WELILE_EMAIL_BRAND_INFO.customerCareNumber}</a>
              &nbsp;|&nbsp;Email: <a href="mailto:${WELILE_EMAIL_BRAND_INFO.officialEmail}" style="color:#7b19d4;text-decoration:none;">${WELILE_EMAIL_BRAND_INFO.officialEmail}</a>
            </div>
            <div style="font-size:11px;color:#64748b;line-height:16px;">
              Website: <a href="${WELILE_EMAIL_BRAND_INFO.websiteUrl}" style="color:#7b19d4;text-decoration:none;">${WELILE_EMAIL_BRAND_INFO.websiteDomain}</a>
              &nbsp;|&nbsp;App: <a href="${WELILE_EMAIL_BRAND_INFO.appUrl}" style="color:#7b19d4;text-decoration:none;">${WELILE_EMAIL_BRAND_INFO.appDomain}</a>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`

export const WELILE_EMAIL_BRAND_HEADER_TEXT = [
  WELILE_EMAIL_BRAND_INFO.legalName.toUpperCase(),
  WELILE_EMAIL_BRAND_INFO.fullPostalAddress,
  `Customer Care: ${WELILE_EMAIL_BRAND_INFO.customerCareNumber} | Email: ${WELILE_EMAIL_BRAND_INFO.officialEmail}`,
  `Website: ${WELILE_EMAIL_BRAND_INFO.websiteDomain} | App: ${WELILE_EMAIL_BRAND_INFO.appDomain}`,
  '',
  '---',
  '',
].join('\n')

/**
 * Idempotently inject the official header right after `<body...>` (or at the
 * very top when there is no body tag). Already-stamped HTML is returned
 * unchanged.
 */
export function ensureWelileEmailHeader(html: string): string {
  if (!html || typeof html !== 'string') return html
  if (html.includes('data-welile-email-header')) return html
  const bodyMatch = /<body[^>]*>/i.exec(html)
  if (bodyMatch) {
    const at = bodyMatch.index + bodyMatch[0].length
    return `${html.slice(0, at)}\n${WELILE_EMAIL_BRAND_HEADER_HTML}\n${html.slice(at)}`
  }
  return `${WELILE_EMAIL_BRAND_HEADER_HTML}\n${html}`
}

/**
 * Idempotently prepend the plain-text letterhead. Already-stamped text is
 * returned unchanged.
 */
export function ensureWelileEmailTextHeader(text: string): string {
  if (!text || typeof text !== 'string') return text
  if (text.includes(WELILE_EMAIL_BRAND_INFO.legalName.toUpperCase())) return text
  return `${WELILE_EMAIL_BRAND_HEADER_TEXT}${text}`
}
