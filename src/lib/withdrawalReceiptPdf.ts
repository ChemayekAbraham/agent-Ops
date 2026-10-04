// Generates a single-page PDF receipt for a confirmed withdrawal request.
// Uses jsPDF dynamically to keep it out of the initial bundle.
import { format } from 'date-fns';
import { savePdfWithVault } from '@/lib/pdfVault';

/**
 * Supported language codes for the receipt PDF. Mirrors the union in
 * `src/i18n/translations.ts` but kept local so this module doesn't pull
 * in the full app translation bundle (the PDF only needs a handful of
 * labels). Languages whose scripts aren't covered by jsPDF's built-in
 * helvetica font (e.g. Amharic, Arabic, CJK, Hindi, Bengali, Thai) fall
 * back to English labels so we never render unreadable box glyphs.
 */
export type ReceiptLanguage =
  | 'en' | 'sw' | 'fr' | 'am' | 'ar' | 'hi' | 'pt' | 'es' | 'zh' | 'ru'
  | 'de' | 'ja' | 'ko' | 'id' | 'tr' | 'vi' | 'th' | 'bn';

interface ReceiptLabels {
  title: string;
  subtitle: string;
  grossAmount: string;
  feeBreakdown: string;
  withdrawalAmount: string;
  platformServiceFee: string;
  transactionExpenses: string;
  netAmountPayable: string;
  reference: string;
  status: string;
  statusDefault: string;
  processed: string;
  method: string;
  recipient: string;
  footer: string;
}

const EN_LABELS: ReceiptLabels = {
  title: 'Withdrawal Receipt',
  subtitle: 'Welile — server-confirmed',
  grossAmount: 'Gross Amount',
  feeBreakdown: 'Fee Breakdown',
  withdrawalAmount: 'Withdrawal amount',
  platformServiceFee: 'Platform service fee',
  transactionExpenses: 'Transaction expenses',
  netAmountPayable: 'Net amount payable',
  reference: 'Reference',
  status: 'Status',
  statusDefault: 'Pending disbursement',
  processed: 'Processed',
  method: 'Method',
  recipient: 'Recipient',
  footer:
    'This receipt confirms the withdrawal request was accepted by Welile. Funds are released after Financial Ops approval.',
};

// Only languages whose glyphs render correctly with jsPDF's built-in
// helvetica (WinAnsi-compatible Latin scripts) get full translations.
// Everything else falls back to English to avoid box glyphs.
const LABELS: Partial<Record<ReceiptLanguage, ReceiptLabels>> = {
  en: EN_LABELS,
  sw: {
    title: 'Risiti ya Utoaji',
    subtitle: 'Welile — imethibitishwa na seva',
    grossAmount: 'Kiasi Kamili',
    feeBreakdown: 'Mchanganuo wa Ada',
    withdrawalAmount: 'Kiasi cha utoaji',
    platformServiceFee: 'Ada ya huduma ya jukwaa',
    transactionExpenses: 'Gharama za muamala',
    netAmountPayable: 'Kiasi halisi cha kulipwa',
    reference: 'Kumbukumbu',
    status: 'Hali',
    statusDefault: 'Inasubiri kulipwa',
    processed: 'Imechakatwa',
    method: 'Njia',
    recipient: 'Mpokeaji',
    footer:
      'Risiti hii inathibitisha ombi la utoaji limepokelewa na Welile. Fedha hutolewa baada ya idhini ya Financial Ops.',
  },
  fr: {
    title: 'Reçu de Retrait',
    subtitle: 'Welile — confirmé par le serveur',
    grossAmount: 'Montant Brut',
    feeBreakdown: 'Détail des Frais',
    withdrawalAmount: 'Montant du retrait',
    platformServiceFee: 'Frais de service de la plateforme',
    transactionExpenses: 'Frais de transaction',
    netAmountPayable: 'Montant net à payer',
    reference: 'Référence',
    status: 'Statut',
    statusDefault: 'En attente de décaissement',
    processed: 'Traité',
    method: 'Méthode',
    recipient: 'Destinataire',
    footer:
      "Ce reçu confirme que la demande de retrait a été acceptée par Welile. Les fonds sont versés après approbation par Financial Ops.",
  },
  pt: {
    title: 'Recibo de Levantamento',
    subtitle: 'Welile — confirmado pelo servidor',
    grossAmount: 'Valor Bruto',
    feeBreakdown: 'Detalhe de Taxas',
    withdrawalAmount: 'Valor do levantamento',
    platformServiceFee: 'Taxa de serviço da plataforma',
    transactionExpenses: 'Despesas de transação',
    netAmountPayable: 'Valor líquido a pagar',
    reference: 'Referência',
    status: 'Estado',
    statusDefault: 'Aguardando desembolso',
    processed: 'Processado',
    method: 'Método',
    recipient: 'Destinatário',
    footer:
      'Este recibo confirma que o pedido de levantamento foi aceite pela Welile. Os fundos são libertados após aprovação da Financial Ops.',
  },
  es: {
    title: 'Recibo de Retiro',
    subtitle: 'Welile — confirmado por el servidor',
    grossAmount: 'Importe Bruto',
    feeBreakdown: 'Desglose de Comisiones',
    withdrawalAmount: 'Importe del retiro',
    platformServiceFee: 'Comisión de servicio de la plataforma',
    transactionExpenses: 'Gastos de transacción',
    netAmountPayable: 'Importe neto a pagar',
    reference: 'Referencia',
    status: 'Estado',
    statusDefault: 'Pendiente de desembolso',
    processed: 'Procesado',
    method: 'Método',
    recipient: 'Destinatario',
    footer:
      'Este recibo confirma que la solicitud de retiro fue aceptada por Welile. Los fondos se liberan tras la aprobación de Financial Ops.',
  },
  de: {
    title: 'Auszahlungsbeleg',
    subtitle: 'Welile — serverseitig bestätigt',
    grossAmount: 'Bruttobetrag',
    feeBreakdown: 'Gebührenaufstellung',
    withdrawalAmount: 'Auszahlungsbetrag',
    platformServiceFee: 'Plattform-Servicegebühr',
    transactionExpenses: 'Transaktionskosten',
    netAmountPayable: 'Auszahlbarer Nettobetrag',
    reference: 'Referenz',
    status: 'Status',
    statusDefault: 'Auszahlung ausstehend',
    processed: 'Verarbeitet',
    method: 'Methode',
    recipient: 'Empfänger',
    footer:
      'Dieser Beleg bestätigt, dass die Auszahlungsanfrage von Welile angenommen wurde. Die Auszahlung erfolgt nach Freigabe durch Financial Ops.',
  },
  id: {
    title: 'Bukti Penarikan',
    subtitle: 'Welile — dikonfirmasi server',
    grossAmount: 'Jumlah Kotor',
    feeBreakdown: 'Rincian Biaya',
    withdrawalAmount: 'Jumlah penarikan',
    platformServiceFee: 'Biaya layanan platform',
    transactionExpenses: 'Biaya transaksi',
    netAmountPayable: 'Jumlah bersih yang dibayar',
    reference: 'Referensi',
    status: 'Status',
    statusDefault: 'Menunggu pencairan',
    processed: 'Diproses',
    method: 'Metode',
    recipient: 'Penerima',
    footer:
      'Bukti ini mengonfirmasi permintaan penarikan telah diterima oleh Welile. Dana dicairkan setelah persetujuan Financial Ops.',
  },
  tr: {
    title: 'Para Çekme Makbuzu',
    subtitle: 'Welile — sunucu tarafından onaylandı',
    grossAmount: 'Brüt Tutar',
    feeBreakdown: 'Ücret Dökümü',
    withdrawalAmount: 'Çekim tutarı',
    platformServiceFee: 'Platform hizmet ücreti',
    transactionExpenses: 'İşlem giderleri',
    netAmountPayable: 'Ödenecek net tutar',
    reference: 'Referans',
    status: 'Durum',
    statusDefault: 'Ödeme bekleniyor',
    processed: 'İşlendi',
    method: 'Yöntem',
    recipient: 'Alıcı',
    footer:
      'Bu makbuz, çekim talebinin Welile tarafından kabul edildiğini doğrular. Tutar Financial Ops onayından sonra serbest bırakılır.',
  },
};

function resolveLabels(language?: ReceiptLanguage): ReceiptLabels {
  if (!language) return EN_LABELS;
  return LABELS[language] ?? EN_LABELS;
}

export interface WithdrawalReceiptData {
  reference: string;
  amount: number;
  currency: string;
  recipient: string;
  method: string;
  date: Date;
  status?: string;
  /**
   * User's preferred UI language. When provided and supported, all
   * labels on the PDF (header, fee panel, detail rows, footer) are
   * rendered in that language. Unsupported scripts fall back to English
   * so the PDF never shows unreadable glyphs.
   */
  language?: ReceiptLanguage;
  /**
   * Itemised fee/expense lines that apply to this withdrawal. Each entry
   * shows as its own row in the breakdown panel. Use a negative `amount`
   * for charges (deductions) and a positive amount for adjustments that
   * increase the payout (rare). Leave undefined/empty when no fees apply
   * — the panel will show a single "Zero platform fees" line instead.
   */
  feeBreakdown?: Array<{ label: string; amount: number }>;
}

function safeRefOf(data: WithdrawalReceiptData): string {
  return (data.reference || 'receipt').replace(/[^A-Za-z0-9_-]/g, '_');
}

export function withdrawalReceiptFilename(data: WithdrawalReceiptData): string {
  return `withdrawal_${safeRefOf(data)}.pdf`;
}

/** Build the PDF in-memory and return a Blob (used for sharing). */
export async function buildWithdrawalReceiptPdfBlob(data: WithdrawalReceiptData): Promise<Blob> {
  const doc = await renderWithdrawalReceiptPdf(data);
  return doc.output('blob') as Blob;
}

async function renderWithdrawalReceiptPdf(data: WithdrawalReceiptData) {
  const { default: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });

  const L = resolveLabels(data.language);

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 48;
  let y = 64;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(L.title, marginX, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  y += 18;
  doc.text(L.subtitle, marginX, y);
  doc.setTextColor(0);

  // Amount block
  y += 36;
  doc.setDrawColor(220);
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(marginX, y, pageWidth - marginX * 2, 70, 8, 8, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(L.grossAmount, marginX + 16, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(20);
  doc.text(`${data.currency} ${Math.round(data.amount).toLocaleString()}`, marginX + 16, y + 52);
  y += 70;

  // ── Fee / expense breakdown ───────────────────────────────────────
  // Always render a small breakdown panel so the user can audit what
  // was (or wasn't) deducted. When `feeBreakdown` is empty we show a
  // single reassurance line — Welile charges no platform withdrawal
  // fees today, but third-party operator charges can be itemised here
  // when the caller knows them.
  const fees = (data.feeBreakdown ?? []).filter((f) => Number.isFinite(f.amount));
  const totalFees = fees.reduce((sum, f) => sum + Math.round(f.amount), 0);
  const netAmount = Math.max(0, Math.round(data.amount) - totalFees);

  y += 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(L.feeBreakdown, marginX, y);
  y += 10;
  doc.setDrawColor(230);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);

  const drawLine = (label: string, valueText: string, opts?: { bold?: boolean; muted?: boolean }) => {
    doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    doc.setTextColor(opts?.muted ? 130 : 30);
    doc.text(label, marginX, y);
    const valueWidth = doc.getTextWidth(valueText);
    doc.text(valueText, pageWidth - marginX - valueWidth, y);
    y += 16;
  };

  drawLine(L.withdrawalAmount, `${data.currency} ${Math.round(data.amount).toLocaleString()}`);

  if (fees.length === 0) {
    drawLine(L.platformServiceFee, `${data.currency} 0`, { muted: true });
    drawLine(L.transactionExpenses, `${data.currency} 0`, { muted: true });
  } else {
    fees.forEach((f) => {
      const amt = Math.round(f.amount);
      const sign = amt < 0 ? '+' : amt > 0 ? '−' : '';
      drawLine(f.label, `${sign}${data.currency} ${Math.abs(amt).toLocaleString()}`);
    });
  }

  y += 4;
  doc.setDrawColor(210);
  doc.line(marginX, y - 8, pageWidth - marginX, y - 8);
  drawLine(L.netAmountPayable, `${data.currency} ${netAmount.toLocaleString()}`, { bold: true });

  // Details
  const rows: Array<[string, string]> = [
    [L.reference, data.reference],
    [L.status, data.status ?? L.statusDefault],
    [L.processed, format(data.date, 'MMM d, yyyy HH:mm')],
    [L.method, data.method],
    [L.recipient, data.recipient],
  ];

  y += 24;
  doc.setFontSize(11);
  rows.forEach(([label, value]) => {
    doc.setTextColor(110);
    doc.setFont('helvetica', 'normal');
    doc.text(label, marginX, y);
    doc.setTextColor(20);
    doc.setFont('helvetica', 'bold');
    const valueLines = doc.splitTextToSize(String(value ?? '-'), pageWidth - marginX * 2 - 120);
    doc.text(valueLines, marginX + 120, y);
    y += 16 * Math.max(1, valueLines.length) + 6;
    doc.setDrawColor(235);
    doc.line(marginX, y - 4, pageWidth - marginX, y - 4);
  });

  // Footer
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    L.footer,
    marginX,
    doc.internal.pageSize.getHeight() - 48,
    { maxWidth: pageWidth - marginX * 2 },
  );
  return doc;
}

export async function downloadWithdrawalReceiptPdf(data: WithdrawalReceiptData): Promise<void> {
  const doc = await renderWithdrawalReceiptPdf(data);
  const filename = withdrawalReceiptFilename(data);
  savePdfWithVault(doc, filename, {
    label: `Withdrawal Receipt · ${(data as any).amount ? `UGX ${Number((data as any).amount).toLocaleString()}` : filename}`,
    category: 'withdrawal-receipt',
  });
}

/**
 * Share the receipt PDF via the device share sheet (Web Share Level 2).
 * Returns `true` when the share sheet was opened (or share completed) and
 * `false` when the platform cannot share files — caller should fall back
 * to `downloadWithdrawalReceiptPdf`.
 */
export async function shareWithdrawalReceiptPdf(data: WithdrawalReceiptData): Promise<boolean> {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  const blob = await buildWithdrawalReceiptPdfBlob(data);
  const filename = withdrawalReceiptFilename(data);

  if (nav && typeof nav.canShare === 'function' && typeof nav.share === 'function') {
    try {
      const file = new File([blob], filename, { type: 'application/pdf' });
      const payload = {
        files: [file],
        title: 'Withdrawal Receipt',
        text: `Withdrawal receipt ${data.reference} — ${data.currency} ${Math.round(data.amount).toLocaleString()}`,
      };
      if (nav.canShare(payload)) {
        await nav.share(payload);
        return true;
      }
    } catch (e: any) {
      // AbortError = user dismissed; treat as handled (no fallback download).
      if (e?.name === 'AbortError') return true;
      console.warn('[withdrawalReceiptPdf] share failed', e);
    }
  }
  return false;
}
