import welileLogoUrl from '@/assets/welile-logo.png';

export interface PartnerStatementSection {
  name: string;
  headers: string[];
  rows: string[][];
  /** Column indices to right-align (money columns). */
  rightAlign?: number[];
}

export interface PartnerFinancialStatementInput {
  partner: string;
  profile: [string, string][];
  agreement?: [string, string][];
  totals: [string, string][];
  sections: PartnerStatementSection[];
  generatedAt?: Date;
}

const THEME_PRIMARY: [number, number, number] = [12, 74, 110];
const THEME_STRIPE: [number, number, number] = [237, 245, 250];
const COMPANY_NAME = 'Welile Technologies Limited';
const COMPANY_CONTACT = 'info@welile.com  |  www.welile.com';

/** Replaces machine underscores with spaces everywhere in the statement. */
export const humanize = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return s.replace(/_/g, ' ').trim() || '—';
};

/**
 * Same humanising for data-table cells, but empty values stay blank so the
 * statement never prints placeholder dashes for data that does not exist.
 */
const humanizeCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  const cleaned = s.replace(/_/g, ' ').trim();
  return cleaned === '—' ? '' : cleaned;
};

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function generatePartnerFinancialStatementPdf(
  input: PartnerFinancialStatementInput,
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const generatedAt = input.generatedAt || new Date();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logoBase64 = await loadLogoBase64();

  const drawFooter = () => {
    const h = doc.internal.pageSize.getHeight();
    doc.setFontSize(7.5);
    doc.setTextColor(130, 130, 130);
    doc.text(
      'Confidential — partner portfolio financial statement issued by Welile Technologies Limited. Amounts in Ugandan Shillings (UGX).',
      margin,
      h - 7,
    );
    doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, h - 7, { align: 'right' });
  };

  // Header band
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 26, 'F');
  if (logoBase64) {
    try { doc.addImage(logoBase64, 'PNG', margin, 4, 17, 17); } catch { /* ignore */ }
  }
  const headX = logoBase64 ? margin + 22 : margin;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Partner Portfolio Financial Statement', headX, 11);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`${COMPANY_NAME}  |  ${COMPANY_CONTACT}`, headX, 17);
  doc.text(`Generated: ${generatedAt.toLocaleString('en-GB')}`, headX, 22);

  let y = 34;
  doc.setTextColor(...THEME_PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(humanize(input.partner), margin, y);
  y += 6;

  const pairTable = (title: string, body: [string, string][], startY: number) => {
    autoTable(doc, {
      startY,
      margin: { left: margin, right: margin },
      head: [[title, '']],
      body: body.map(([k, v]) => [humanize(k), humanize(v)]),
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2, overflow: 'linebreak', textColor: [40, 40, 40] },
      headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
      columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
      didDrawPage: drawFooter,
    });
    return (doc as any).lastAutoTable.finalY + 7;
  };

  y = pairTable('Partner profile', input.profile, y);
  y = pairTable('Portfolio position summary', input.totals, y);
  if (input.agreement?.length) y = pairTable('Partnership agreement', input.agreement, y);

  for (const section of input.sections) {
    if (!section.rows.length) continue;
    doc.addPage();
    doc.setTextColor(...THEME_PRIMARY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(`${humanize(section.name)} (${section.rows.length})`, margin, 18);

    const columnStyles: Record<number, any> = {};
    (section.rightAlign || []).forEach((i) => { columnStyles[i] = { halign: 'right' }; });

    autoTable(doc, {
      startY: 23,
      margin: { left: margin, right: margin },
      head: [section.headers.map(humanize)],
      body: section.rows.map((r) => r.map(humanizeCell)),
      styles: { fontSize: 7.6, cellPadding: 1.6, overflow: 'linebreak', textColor: [40, 40, 40] },
      headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.8 },
      alternateRowStyles: { fillColor: THEME_STRIPE },
      columnStyles,
      didDrawPage: drawFooter,
    });
  }

  drawFooter();
  return doc.output('blob');
}
