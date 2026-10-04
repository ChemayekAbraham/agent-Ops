import welileLogo from '@/assets/welile-logo.png';
import { formatDynamic as fmtUGX } from '@/lib/currencyFormat';

export interface WalletStatementEntry {
  transaction_date: string;
  label: string;
  reason?: string | null;
  description?: string | null;
  direction: 'cash_in' | 'cash_out';
  amount: number;
}

export interface WalletStatementInput {
  bucketTitle: string;        // "Yours to keep" | "Tenant collections"
  bucketSubtitle: string;     // helper line
  ownerName: string;
  ownerPhone?: string | null;
  balance: number;
  totalIn: number;
  totalOut: number;
  entries: WalletStatementEntry[];
  activeTab?: 'all' | 'in' | 'out';
  categoryFilter?: 'all' | string;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-UG', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatFilterSummary(
  activeTab: 'all' | 'in' | 'out' = 'all',
  categoryFilter: 'all' | string = 'all',
): string {
  const direction = activeTab === 'in' ? 'Cash In' : activeTab === 'out' ? 'Cash Out' : 'All directions';
  const category = categoryFilter && categoryFilter !== 'all' ? categoryFilter : 'All categories';
  return `Filters: ${direction} · ${category}`;
}

async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch(welileLogo);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Generate a wallet statement PDF. Logo is placed in the top-left of every
 * page. Layout is portrait A4, mobile-friendly text sizes, designed to be
 * shared on WhatsApp directly.
 */
export async function generateWalletStatementPdf(
  input: WalletStatementInput,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const logo = await loadLogo();

  const drawHeader = (pageNo: number) => {
    // Top band
    pdf.setFillColor(146, 52, 234);
    pdf.rect(0, 0, pw, 26, 'F');
    // Logo top-left (in a white rounded badge so the colored logo reads on the band)
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(margin, 5, 16, 16, 2, 2, 'F');
    if (logo) {
      try { pdf.addImage(logo, 'PNG', margin + 1.5, 6.5, 13, 13, undefined, 'FAST'); } catch { /* ignore */ }
    }
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text('Welile Wallet Statement', margin + 22, 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(
      `Generated ${new Date().toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' })}`,
      margin + 22, 19,
    );
    // Page number top-right
    pdf.setFontSize(8);
    pdf.text(`Page ${pageNo}`, pw - margin, 19, { align: 'right' });
  };

  const drawFooter = () => {
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text('welile.com  ·  Wallet statement  ·  Confidential', pw / 2, ph - 6, { align: 'center' });
  };

  let pageNo = 1;
  drawHeader(pageNo);
  let y = 34;

  // ── Owner block ──
  pdf.setTextColor(20, 20, 20);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(input.ownerName, margin, y);
  if (input.ownerPhone) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(input.ownerPhone, margin, y + 5);
  }
  y += 12;

  // ── Headline card ──
  const hasFilters = input.activeTab !== undefined || (input.categoryFilter !== undefined && input.categoryFilter !== 'all');
  const cardH = hasFilters ? 38 : 30;
  pdf.setFillColor(245, 240, 255);
  pdf.roundedRect(margin, y, pw - margin * 2, cardH, 3, 3, 'F');
  pdf.setTextColor(90, 90, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text(input.bucketTitle.toUpperCase(), margin + 5, y + 7);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(22);
  pdf.text(fmtUGX(input.balance), margin + 5, y + 18);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90, 90, 90);
  pdf.text(input.bucketSubtitle, margin + 5, y + 25);
  if (hasFilters) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 100, 100);
    pdf.text(formatFilterSummary(input.activeTab, input.categoryFilter), margin + 5, y + 33);
  }
  y += cardH + 6;

  // ── In / Out summary ──
  const colW = (pw - margin * 2 - 4) / 2;
  pdf.setFillColor(232, 250, 240);
  pdf.roundedRect(margin, y, colW, 16, 2, 2, 'F');
  pdf.setFillColor(245, 245, 245);
  pdf.roundedRect(margin + colW + 4, y, colW, 16, 2, 2, 'F');
  pdf.setTextColor(40, 130, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('MONEY IN', margin + 4, y + 6);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(12);
  pdf.text(fmtUGX(input.totalIn), margin + 4, y + 13);
  pdf.setTextColor(110, 110, 110);
  pdf.setFontSize(8);
  pdf.text('MONEY OUT', margin + colW + 8, y + 6);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(12);
  pdf.text(fmtUGX(input.totalOut), margin + colW + 8, y + 13);
  y += 22;

  // ── Activity ──
  pdf.setTextColor(60, 60, 60);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(`Activity (${input.entries.length})`, margin, y);
  y += 5;

  const ensure = (need: number) => {
    if (y + need > ph - 14) {
      drawFooter();
      pdf.addPage();
      pageNo += 1;
      drawHeader(pageNo);
      y = 32;
    }
  };

  if (input.entries.length === 0) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(9);
    pdf.setTextColor(120, 120, 120);
    pdf.text('No activity yet.', margin, y + 5);
  } else {
    for (const e of input.entries) {
      const reasonLines = e.reason ? pdf.splitTextToSize(e.reason, pw - margin * 2 - 38) : [];
      const noteLines = e.description ? pdf.splitTextToSize(`Note: ${e.description}`, pw - margin * 2 - 38) : [];
      const rowH = 11 + reasonLines.length * 3.6 + noteLines.length * 3.4;
      ensure(rowH + 2);

      // Row separator line
      pdf.setDrawColor(230, 230, 230);
      pdf.line(margin, y, pw - margin, y);
      y += 4;

      pdf.setTextColor(20, 20, 20);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(e.label, margin, y);

      const sign = e.direction === 'cash_in' ? '+' : '-';
      if (e.direction === 'cash_in') pdf.setTextColor(35, 130, 80);
      else pdf.setTextColor(20, 20, 20);
      pdf.text(`${sign}${fmtUGX(Number(e.amount || 0))}`, pw - margin, y, { align: 'right' });

      y += 4;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 100, 100);
      pdf.text(fmtDateTime(e.transaction_date), margin, y);
      y += 3.5;

      if (reasonLines.length) {
        pdf.setTextColor(60, 60, 60);
        pdf.text(reasonLines, margin, y);
        y += reasonLines.length * 3.6;
      }
      if (noteLines.length) {
        pdf.setTextColor(130, 130, 130);
        pdf.text(noteLines, margin, y);
        y += noteLines.length * 3.4;
      }
      y += 2;
    }
  }

  drawFooter();
  return pdf.output('blob');
}

/**
 * Trigger a native share sheet (best for WhatsApp on mobile). Falls back to
 * downloading the file + opening WhatsApp web with a short text.
 */
export async function shareWalletStatementPdf(
  blob: Blob,
  filename: string,
  caption: string,
) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename, text: caption });
      return;
    } catch (err) {
      // user cancelled or share failed → fall through to download
      if ((err as DOMException)?.name === 'AbortError') return;
    }
  }
  // Fallback: download the file, then open WhatsApp with caption.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  window.open(`https://wa.me/?text=${encodeURIComponent(caption)}`, '_blank');
}