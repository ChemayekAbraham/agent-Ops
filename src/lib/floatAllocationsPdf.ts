import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export type AllocationStatus = 'active' | 'reversed';

export interface FloatAllocationRow {
  date: string;          // exact date & time of allocation
  amount: number;        // amount allocated by the agent
  status: AllocationStatus;
  reason?: string | null; // free-text note (e.g. reversal reason)
}

export interface FloatAllocationsPdfData {
  aiId: string;
  tenantName: string;
  phone: string;
  agentName: string;
  generatedAt?: Date;
  rows: FloatAllocationRow[];      // already filtered to what the agent is viewing
  periodFrom?: string | null;
  periodTo?: string | null;
  statusFilter: 'all' | AllocationStatus;
  caption?: string | null;          // optional WhatsApp note / message from the agent
}

async function loadLogoAsBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-UG', { year: 'numeric', month: 'short', day: 'numeric' });
}

const statusLabel = (s: 'all' | AllocationStatus): string =>
  s === 'all' ? 'All allocations' : s === 'active' ? 'Active only' : 'Reversed only';

export async function generateFloatAllocationsPdf(data: FloatAllocationsPdfData): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const cw = pw - margin * 2;
  let y = 14;

  const ensureSpace = (need: number) => {
    if (y > ph - need) { pdf.addPage(); y = 16; }
  };

  // ─── Branded header ───
  const logoBase64 = await loadLogoAsBase64();
  if (logoBase64) pdf.addImage(logoBase64, 'PNG', margin, y - 4, 14, 14);
  const textX = margin + 18;
  pdf.setFontSize(15);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('Welile Technologies Limited', textX, y + 2);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text('P.O. Box 167564, Palm Lane, Kabaale, Entebbe — Uganda', textX, y + 7);
  pdf.text('info@welile.com  |  www.welile.com', textX, y + 11);
  y += 20;

  pdf.setDrawColor(67, 56, 202);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, pw - margin, y);
  y += 6;

  pdf.setFontSize(13);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('AGENT FLOAT ALLOCATIONS', margin, y);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text(`Generated: ${(data.generatedAt ?? new Date()).toLocaleString('en-UG')}`, pw - margin, y, { align: 'right' });
  y += 8;

  // ─── Filter banner ───
  const periodText =
    data.periodFrom || data.periodTo
      ? `${fmtDate(data.periodFrom)} — ${fmtDate(data.periodTo)}`
      : 'All time';
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(67, 56, 202);
  pdf.text(`Date range: ${periodText}    •    Status: ${statusLabel(data.statusFilter)}`, margin, y);
  y += 7;

  // ─── Optional agent caption ───
  if (data.caption) {
    const captionLines = pdf.splitTextToSize(data.caption, cw - 6);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'italic');
    pdf.setTextColor(67, 56, 202);
    pdf.text(captionLines, margin + 3, y);
    y += captionLines.length * 3.8 + 3;
  }

  // ─── Tenant / agent identity ───
  const idRow = (label: string, value: string, x: number) => {
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, x, y);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(30, 41, 59);
    pdf.text(value, x, y + 4);
  };
  idRow('TENANT', data.tenantName, margin);
  idRow('PHONE', data.phone || '—', margin + 70);
  idRow('AI ID', data.aiId, margin + 130);
  y += 9;
  idRow('MANAGING AGENT', data.agentName || '—', margin);
  idRow('ALLOCATIONS', String(data.rows.length), margin + 130);
  y += 11;

  // ─── Allocations table ───
  pdf.setFillColor(238, 242, 255);
  pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(67, 56, 202);
  pdf.text('FLOAT ALLOCATIONS BY AGENT', margin + 3, y + 1);
  y += 9;

  if (data.rows.length === 0) {
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text('No float allocations match the selected filters.', margin + 3, y);
    y += 6;
  } else {
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 116, 139);
    pdf.text('#', margin + 3, y);
    pdf.text('Date & time of allocation', margin + 12, y);
    pdf.text('Status', margin + 110, y);
    pdf.text('Amount allocated', pw - margin - 3, y, { align: 'right' });
    y += 2;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 4;

    let activeTotal = 0;
    let reversedTotal = 0;
    data.rows.forEach((a, i) => {
      ensureSpace(16);
      const isReversed = a.status === 'reversed';
      if (isReversed) reversedTotal += Number(a.amount || 0);
      else activeTotal += Number(a.amount || 0);

      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(30, 41, 59);
      pdf.text(String(i + 1), margin + 3, y);
      pdf.text(new Date(a.date).toLocaleString('en-UG'), margin + 12, y);
      if (isReversed) pdf.setTextColor(239, 68, 68); else pdf.setTextColor(34, 197, 94);
      pdf.setFont('helvetica', 'bold');
      pdf.text(isReversed ? 'Reversed' : 'Active', margin + 110, y);
      pdf.setTextColor(isReversed ? 148 : 67, isReversed ? 163 : 56, isReversed ? 184 : 202);
      pdf.text(formatUGX(a.amount), pw - margin - 3, y, { align: 'right' });
      y += 5;

      if (a.reason) {
        ensureSpace(10);
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'italic');
        pdf.setTextColor(148, 163, 184);
        const reason = pdf.splitTextToSize(a.reason, cw - 18);
        pdf.text(reason, margin + 12, y);
        y += reason.length * 3.5 + 1;
      }
    });

    // ─── Totals ───
    ensureSpace(24);
    y += 1;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 5;

    const totRow = (label: string, value: string, color: [number, number, number]) => {
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(100, 116, 139);
      pdf.text(label, margin + 3, y);
      pdf.setTextColor(...color);
      pdf.text(value, pw - margin - 3, y, { align: 'right' });
      y += 6;
    };

    const activeCount = data.rows.filter((a) => a.status === 'active').length;
    const reversedCount = data.rows.length - activeCount;
    if (data.statusFilter !== 'reversed') {
      totRow(`Active allocated (${activeCount})`, formatUGX(activeTotal), [34, 197, 94]);
    }
    if (data.statusFilter !== 'active' && reversedCount > 0) {
      totRow(`Reversed (${reversedCount})`, formatUGX(reversedTotal), [239, 68, 68]);
    }
    totRow(`Net allocated`, formatUGX(activeTotal), [67, 56, 202]);
  }

  // ─── Footer on every page ───
  const pageCount = pdf.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    const footerY = ph - 10;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, footerY - 4, pw - margin, footerY - 4);
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(148, 163, 184);
    pdf.text('Welile Technologies Limited — Confidential. For authorized use only.', margin, footerY);
    pdf.text(`Page ${i} of ${pageCount}`, pw - margin, footerY, { align: 'right' });
  }

  return pdf.output('blob');
}

export async function shareOrDownloadFloatAllocations(data: FloatAllocationsPdfData): Promise<void> {
  const blob = await generateFloatAllocationsPdf(data);
  const file = new File(
    [blob],
    `Float_Allocations_${data.tenantName.replace(/\s+/g, '_')}.pdf`,
    { type: 'application/pdf' },
  );

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        title: `Float Allocations — ${data.tenantName}`,
        text: `Welile float allocations for ${data.tenantName}`,
        files: [file],
      });
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Share the float-allocations PDF straight to WhatsApp.
 *
 * On mobile (where WhatsApp is installed) the native share sheet accepts the
 * PDF file directly, so the agent just taps "WhatsApp" and picks a contact.
 * Where file sharing is unsupported (most desktops), we download the PDF and
 * open WhatsApp with a ready-made caption so the agent only has to attach the
 * file they just saved.
 */
export async function shareFloatAllocationsWhatsApp(data: FloatAllocationsPdfData): Promise<void> {
  const blob = await generateFloatAllocationsPdf(data);
  const filename = `Float_Allocations_${data.tenantName.replace(/\s+/g, '_')}.pdf`;
  const file = new File([blob], filename, { type: 'application/pdf' });
  const caption = (data.caption?.trim() || `Welile float allocations for ${data.tenantName}`);

  // Best path: native share sheet with the file attached (lets the agent pick WhatsApp).
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: `Float Allocations — ${data.tenantName}`, text: caption, files: [file] });
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
    }
  }

  // Fallback: download the PDF, then open WhatsApp with a prefilled caption.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  window.open(`https://wa.me/?text=${encodeURIComponent(caption)}`, '_blank');
}
