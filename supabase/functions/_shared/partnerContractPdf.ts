// Shared server-side Tenant Partnership Agreement PDF renderer (pdf-lib, Deno-safe).
// Used as the authoritative fallback when the client-side html2canvas render
// fails or times out during /funder-onboarding, so no partner ever receives a
// contract email without the filled agreement attached.
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1'

const ONES = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen']
const TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety']
const SCALES = ['','Thousand','Million','Billion','Trillion']
function threeDigits(n: number): string {
  const out: string[] = []
  const h = Math.floor(n/100), r = n%100
  if (h>0) out.push(`${ONES[h]} Hundred`)
  if (r>0) {
    if (r<20) out.push(ONES[r])
    else { const t=Math.floor(r/10), o=r%10; out.push(o>0?`${TENS[t]}-${ONES[o]}`:TENS[t]) }
  }
  return out.join(' ')
}
export function numberToWords(v: number): string {
  const n = Math.floor(Math.abs(v||0))
  if (n===0) return 'Zero'
  const g:number[]=[]; let r=n; while(r>0){g.push(r%1000); r=Math.floor(r/1000)}
  const words:string[]=[]
  for (let i=g.length-1;i>=0;i--){ if(g[i]===0) continue; const c=threeDigits(g[i]); const s=SCALES[i]; words.push(s?`${c} ${s}`:c) }
  return words.join(' ').replace(/\s+/g,' ').trim()
}

// ── Agreement date resolution ──────────────────────────────────────────────
// partner_agreements holds ONE row per partner, created the first time that
// partner ever started a contract. Its created_at is therefore the date of the
// partner's FIRST agreement, not the one being issued now — using it stamps
// old dates onto later contracts. Resolve the date the agreement was actually
// executed instead, most specific source first.
export function resolveAgreementDate(
  row: {
    countersigned_at?: string | null
    agreement_date?: string | null
    created_at?: string | null
  },
  portfolioCreatedAt?: string | null,
): Date {
  const candidates = [
    portfolioCreatedAt,
    row?.countersigned_at,
    row?.agreement_date,
    row?.created_at,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    // A bare date ("2026-08-03") parses as UTC midnight, which is what we want
    // for a date-only stamp — no timezone shift back a day.
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(candidate) ? `${candidate}T12:00:00Z` : candidate)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

// ── Server-side PDF renderer ───────────────────────────────────────────────
// Text-only, 4-page A4 contract using pdf-lib standard fonts (Helvetica).
// No third-party fonts, no HTML — safe on Deno edge runtime.
export interface RenderInput {
  partnerName: string
  partnerId: string
  partnerAddress: string
  partnerPhone: string
  partnerEmail: string
  partnershipAmount: number
  partnershipAmountWords: string
  monthlyReturnLabel: string
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
  momoProvider?: string
  momoNumber?: string
  payoutMode: 'bank' | 'momo'
  reference: string
  partnerSignaturePngBytes?: Uint8Array | null
  agreementDate: Date
}

export async function renderContractPdf(data: RenderInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic)

  const A4 = { w: 595.28, h: 841.89 }
  const MARGIN = 56
  const INK = rgb(0.06, 0.09, 0.16)
  const MUTED = rgb(0.30, 0.35, 0.42)

  let page = pdf.addPage([A4.w, A4.h])
  let y = A4.h - MARGIN

  const drawFooter = (pageNum: number, total: number) => {
    page.drawText('Confidential', {
      x: MARGIN, y: 28, size: 9, font, color: MUTED,
    })
    const label = `Page ${pageNum} of ${total}`
    const w = font.widthOfTextAtSize(label, 9)
    page.drawText(label, { x: A4.w - MARGIN - w, y: 28, size: 9, font, color: MUTED })
  }

  const newPage = () => {
    page = pdf.addPage([A4.w, A4.h])
    y = A4.h - MARGIN
  }

  const wrap = (text: string, size: number, f = font) => {
    const words = text.split(/\s+/)
    const maxW = A4.w - MARGIN * 2
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (f.widthOfTextAtSize(test, size) > maxW) {
        if (line) lines.push(line)
        line = w
      } else {
        line = test
      }
    }
    if (line) lines.push(line)
    return lines
  }

  const writeParagraph = (text: string, opts: { size?: number; f?: any; gap?: number; leading?: number } = {}) => {
    const size = opts.size ?? 11
    const f = opts.f ?? font
    const leading = opts.leading ?? size * 1.45
    const lines = wrap(text, size, f)
    for (const line of lines) {
      if (y < MARGIN + 50) {
        drawFooter(pdf.getPageCount(), 4)
        newPage()
      }
      page.drawText(line, { x: MARGIN, y, size, font: f, color: INK })
      y -= leading
    }
    y -= opts.gap ?? 6
  }

  const writeHeading = (text: string, size = 13) => {
    if (y < MARGIN + 80) { drawFooter(pdf.getPageCount(), 4); newPage() }
    y -= 4
    page.drawText(text, { x: MARGIN, y, size, font: bold, color: INK })
    y -= size * 1.6
  }

  const writeBullet = (text: string, size = 11) => {
    const bulletX = MARGIN
    const textX = MARGIN + 14
    const maxW = A4.w - textX - MARGIN
    const words = text.split(/\s+/)
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(test, size) > maxW) {
        if (line) lines.push(line); line = w
      } else line = test
    }
    if (line) lines.push(line)
    for (let i = 0; i < lines.length; i++) {
      if (y < MARGIN + 50) { drawFooter(pdf.getPageCount(), 4); newPage() }
      if (i === 0) page.drawText('•', { x: bulletX, y, size, font, color: INK })
      page.drawText(lines[i], { x: textX, y, size, font, color: INK })
      y -= size * 1.45
    }
    y -= 3
  }

  // ── PAGE 1: Title / cover ────────────────────────────────────────────────
  {
    y = A4.h - 200
    const title = 'TENANT PARTNERSHIP AGREEMENT'
    const tw = bold.widthOfTextAtSize(title, 20)
    page.drawText(title, { x: (A4.w - tw) / 2, y, size: 20, font: bold, color: INK })
    y -= 40
    const sub = 'Welile Technologies Limited'
    const sw = bold.widthOfTextAtSize(sub, 14)
    page.drawText(sub, { x: (A4.w - sw) / 2, y, size: 14, font: bold, color: INK })
    y -= 24
    const ref = `Reference: ${data.reference}`
    const rw = font.widthOfTextAtSize(ref, 12)
    page.drawText(ref, { x: (A4.w - rw) / 2, y, size: 12, font, color: MUTED })
    y -= 60
    const partiesTitle = 'BETWEEN'
    const ptw = bold.widthOfTextAtSize(partiesTitle, 12)
    page.drawText(partiesTitle, { x: (A4.w - ptw) / 2, y, size: 12, font: bold, color: INK })
    y -= 24
    const parties = [
      'Welile Technologies Limited',
      '(hereinafter "the Company")',
      '',
      'AND',
      '',
      data.partnerName,
      '(hereinafter "the Partner")',
    ]
    for (const p of parties) {
      const w = (p === data.partnerName || p === 'Welile Technologies Limited' || p === 'AND')
        ? bold.widthOfTextAtSize(p, 12) : font.widthOfTextAtSize(p, 11)
      const f = (p === data.partnerName || p === 'Welile Technologies Limited' || p === 'AND') ? bold : font
      const size = (p === 'AND') ? 12 : (p === data.partnerName || p === 'Welile Technologies Limited') ? 12 : 11
      page.drawText(p, { x: (A4.w - w) / 2, y, size, font: f, color: INK })
      y -= 18
    }
    y -= 40
    const dateStr = data.agreementDate.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    })
    const dw = font.widthOfTextAtSize(`Dated: ${dateStr}`, 12)
    page.drawText(`Dated: ${dateStr}`, { x: (A4.w - dw) / 2, y, size: 12, font, color: INK })
    drawFooter(1, 4)
  }

  // ── PAGE 2: Preamble + terms 1–4 ─────────────────────────────────────────
  newPage()
  const day = data.agreementDate.getDate()
  const monthName = data.agreementDate.toLocaleDateString('en-GB', { month: 'long' })
  writeParagraph(
    `THIS AGREEMENT is made this ${day} day of ${monthName}, ${data.agreementDate.getFullYear()} BETWEEN Welile Technologies Limited, a limited liability company incorporated in Uganda, with its Head Quarters in Hosanna Estate, Palm Road, Kabale–Entebbe, P.O. Box 167564, Kampala – Uganda, Tel: 0793750331, 0748747134 (hereinafter "the Company") of the one part;`,
    { size: 11 }
  )
  writeParagraph(
    `AND ${data.partnerName}, holder of National ID/Passport No. ${data.partnerId || '—'}, residing at ${data.partnerAddress || '—'} (hereinafter "the Partner") of the other part. The Company and the Partner shall individually be referred to as "the Party" and collectively as "the Parties."`,
    { size: 11 }
  )
  writeHeading('Background')
  writeParagraph(
    'WHEREAS, the Company operates as a technology platform that facilitates rent access for tenants by connecting them with Tenant Partners, who are financial contributors that provide the funds for rent payments in exchange for a return on their contribution.'
  )
  writeHeading('1. Platform Overview and Nature of Business')
  writeParagraph('The Company operates a digital platform that connects tenants seeking rent with individuals willing to support them in exchange for returns.')
  writeParagraph('The Company is not a deposit-taking institution or an insurance company. It is a technology platform that manages and facilitates all transactions between the Parties.')
  writeHeading("2. Partner's Role")
  writeParagraph(
    `The Partner agrees to contribute a total partnership amount of UGX ${data.partnershipAmount.toLocaleString('en-US')} (${data.partnershipAmountWords} Shillings Only).`
  )
  writeParagraph('The Partner will receive access to periodic reports or a dashboard to monitor the performance of their contribution and agrees to comply with all platform terms, policies, and partner guidelines.')
  writeHeading("3. Company's Responsibilities and Assurances")
  writeBullet('Conduct full due diligence on all tenants and landlords.')
  writeBullet('Facilitate and manage all rent payment transactions.')
  writeBullet('Guarantee the repayment of the full principal amount and expected returns.')
  writeBullet('Absorb any losses, delays, or defaults from tenants.')
  writeBullet('Provide a detailed individual financial report to the Partner upon request.')
  drawFooter(2, 4)

  // ── PAGE 3: Terms 4–12 ───────────────────────────────────────────────────
  newPage()
  writeHeading('4. Returns and Payouts')
  writeBullet(`The Partner will earn a monthly return of ${data.monthlyReturnLabel} on the principal partnership amount.`)
  writeBullet("The monthly returns will be paid to the Partner's provided bank account or mobile money details at the end of each month.")
  writeBullet("The Partner's earnings are not available for early withdrawal and can only be accessed on the agreed payout date.")
  writeHeading('5. Withdrawal of Principal')
  writeBullet('This agreement is in force for a period of one (1) year. A notice for renewal shall be given three (3) months before expiration by either Party.')
  writeBullet('To withdraw the principal amount, the Partner must notify the Company in writing at least ninety (90) days prior to the intended withdrawal date.')
  writeBullet('Upon receipt of a withdrawal request, the Company shall have a principal recovery period of ninety (90) days. During this period, no monthly interest shall accrue or be payable to the Partner.')
  writeHeading('6. Risk and Liability')
  writeBullet('The Company bears full liability for tenant defaults, delays, or losses.')
  writeBullet("The Partner's principal and expected returns are fully guaranteed by the Company.")
  writeBullet('The Company shall promptly communicate any payout delays caused by external factors and ensures all such issues are resolved within two to three business days.')
  writeHeading('7. Default and Termination')
  writeBullet('Default: If a Party fails to make a payment or comply with the terms of this agreement, the other Party reserves the right to take legal action for breach of contract. Both Parties have a right to settle any default within fourteen (14) days before the other Party takes action.')
  writeBullet('Termination: This Agreement may be terminated by the Partner with a ninety (90)-day written withdrawal notice, or by the Company in case of any breach, fraud, or misuse.')
  writeHeading('8. Dispute Resolution')
  writeBullet('The Parties shall resolve any matter through arbitration in accordance with the laws of Uganda. Where the Parties fail to agree under arbitration, the matter can be referred to the courts of Uganda with competent jurisdiction.')
  writeHeading('9. Entire Agreement')
  writeBullet('This document contains the full agreement between the Parties. There are no agreements collateral hereto, and no oral promises override this agreement.')
  writeHeading('10. Amendments')
  writeBullet('All amendments to this agreement shall be in writing and signed by all Parties.')
  writeHeading('11. Legal Fees')
  writeBullet('The legal fees for preparing this agreement shall be borne by the Company.')
  writeHeading('12. Approved Company Payment Channels')
  writeBullet('Airtel Money — Dial *185*9# — Merchant ID: 4380664')
  writeBullet('MTN MoMo — MoMo App or *165*3# — MoMo Code: 090777')
  writeBullet('Bank Transfer — Equity Bank — Account Name: Welile Technologies Limited — Account Number: 1046203375259 — SWIFT: EQBLUGKA')
  drawFooter(3, 4)

  // ── PAGE 4: Execution / signatures ───────────────────────────────────────
  newPage()
  {
    const t = 'IN WITNESS WHEREOF, the Parties have executed these presents the day and year first above written.'
    for (const line of wrap(t, 11, bold)) {
      const w = bold.widthOfTextAtSize(line, 11)
      page.drawText(line, { x: (A4.w - w) / 2, y, size: 11, font: bold, color: INK })
      y -= 16
    }
    y -= 18
  }

  const dateStr = data.agreementDate.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  // Welile block
  writeHeading('Signed for and on behalf of Welile Technologies Limited', 12)
  writeParagraph('Name: SSEMAKULA JOSEPH', { size: 11, gap: 2 })
  writeParagraph('Position: Chief Executive Officer', { size: 11, gap: 2 })
  writeParagraph('Contact: 0793750331', { size: 11, gap: 2 })
  writeParagraph(`Date: ${dateStr}`, { size: 11, gap: 10 })
  writeParagraph('Signature: __________________________ (Pending counter-signature)', { size: 11, f: italic, gap: 14 })

  // Partner block
  writeHeading('Signed by the said Tenant Partner', 12)
  writeParagraph(`Name: ${data.partnerName}`, { size: 11, gap: 2 })
  writeParagraph(`Residence: ${data.partnerAddress || '—'}`, { size: 11, gap: 2 })
  writeParagraph(`Contact (Telephone): ${data.partnerPhone || '—'}`, { size: 11, gap: 2 })
  writeParagraph(`Email: ${data.partnerEmail || '—'}`, { size: 11, gap: 2 })
  if (data.payoutMode === 'bank') {
    writeParagraph(`Bank Name: ${data.bankName || '—'}`, { size: 11, gap: 2 })
    writeParagraph(`Account Name: ${data.bankAccountName || data.partnerName}`, { size: 11, gap: 2 })
    writeParagraph(`Account Number: ${data.bankAccountNumber || '—'}`, { size: 11, gap: 2 })
  } else {
    writeParagraph(`Mobile Money Provider: ${data.momoProvider || '—'}`, { size: 11, gap: 2 })
    writeParagraph(`Mobile Money Number: ${data.momoNumber || '—'}`, { size: 11, gap: 2 })
  }
  writeParagraph(`Date: ${dateStr}`, { size: 11, gap: 8 })

  // Embed signature image if available
  if (data.partnerSignaturePngBytes && data.partnerSignaturePngBytes.length > 0) {
    try {
      const img = await pdf.embedPng(data.partnerSignaturePngBytes)
      const targetW = 180
      const scale = targetW / img.width
      const targetH = img.height * scale
      if (y < MARGIN + targetH + 20) { drawFooter(4, 4); newPage() }
      page.drawText('Signature:', { x: MARGIN, y, size: 11, font, color: INK })
      page.drawImage(img, { x: MARGIN + 70, y: y - targetH + 10, width: targetW, height: targetH })
      y -= targetH + 6
    } catch (e) {
      console.warn('failed to embed signature image; falling back to line', e)
      writeParagraph('Signature: __________________________', { size: 11, f: italic })
    }
  } else {
    writeParagraph('Signature: __________________________', { size: 11, f: italic })
  }
  drawFooter(4, 4)

  return await pdf.save()
}

export function decodeDataUrlToBytes(dataUrl: string | null | undefined): Uint8Array | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null
  const comma = dataUrl.indexOf(',')
  const b64 = dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}
