/**
 * Audit-grade PDF export of one person's identity verification history:
 * every submission (front of ID, back of ID, selfie), what each photo read
 * produced, and every Financial Ops decision with its rejection reason.
 *
 * Purely presentational — it renders data already fetched for the screen and
 * never writes any state.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';

const PRIMARY: [number, number, number] = [21, 94, 117]; // cyan-800

export interface IdentityPdfPhoto {
  label: string;
  path: string | null;
  savedAt: string | null;
  /** data URL, when the image could be inlined (best-effort). */
  dataUrl?: string | null;
}

export interface IdentityPdfSubmission {
  submittedAt: string | null;
  photos: IdentityPdfPhoto[];
}

export interface IdentityPdfRead {
  side: string;
  readAt: string | null;
  nameRead: string | null;
  idNumberRead: string | null;
  readable: boolean | null;
  isNationalId: boolean | null;
  nameMatched: boolean | null;
  idNumberMatched: boolean | null;
  failureReason: string | null;
}

export interface IdentityPdfDecision {
  destination: string;
  status: string;
  decisionReason: string | null;
  nationalId: string | null;
  nationalIdName: string | null;
  accountName: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
}

export interface IdentityVerificationPdfInput {
  personName: string | null;
  personPhone: string | null;
  userId: string;
  submissions: IdentityPdfSubmission[];
  reads: IdentityPdfRead[];
  decisions: IdentityPdfDecision[];
}

const stamp = (v?: string | null) => (v ? format(new Date(v), 'dd MMM yyyy HH:mm') : '—');
const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? '—' : v ? 'Yes' : 'No');

export function generateIdentityVerificationHistoryPdf(
  input: IdentityVerificationPdfInput,
): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Welile · Identity Verification History', margin, 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, margin, 16.5);

  doc.setTextColor(35, 35, 35);
  let y = 30;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(input.personName || 'Name not recorded', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  y += 5;
  doc.text(
    [input.personPhone || 'No phone on file', `Account: ${input.userId}`].join('   |   '),
    margin,
    y,
  );
  y += 7;

  // Photos submitted — one block per submission, with inlined images when available.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Photos submitted', margin, y);
  y += 4;

  if (input.submissions.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('No identity photos have been submitted.', margin, y + 3);
    y += 10;
  } else {
    for (const sub of input.submissions) {
      if (y > 235) {
        doc.addPage();
        y = 20;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(`Submitted ${stamp(sub.submittedAt)}`, margin, y);
      y += 3;

      const boxW = (pageWidth - margin * 2 - 8) / 3;
      const boxH = 30;
      sub.photos.slice(0, 3).forEach((p, i) => {
        const x = margin + i * (boxW + 4);
        doc.setDrawColor(200, 200, 200);
        doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5);
        if (p.dataUrl) {
          try {
            doc.addImage(p.dataUrl, x + 1, y + 1, boxW - 2, boxH - 2, undefined, 'FAST');
          } catch {
            /* unreadable image: leave the empty frame */
          }
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(140, 140, 140);
          doc.text(p.path ? 'Photo not available' : 'Not saved', x + 3, y + boxH / 2);
          doc.setTextColor(35, 35, 35);
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.text(p.label, x, y + boxH + 4);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(110, 110, 110);
        doc.text(p.path ? stamp(p.savedAt) : 'Missing', x, y + boxH + 7.5);
        doc.setTextColor(35, 35, 35);
      });
      y += boxH + 13;
    }
  }

  // What each photo read produced.
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Side', 'Read at', 'Name read', 'ID number', 'Readable', 'Is ID', 'Name match', 'ID match', 'Failure']],
    body:
      input.reads.length > 0
        ? input.reads.map((r) => [
            r.side === 'back' ? 'Back of ID' : 'Front of ID',
            stamp(r.readAt),
            r.nameRead || '—',
            r.idNumberRead || '—',
            yesNo(r.readable),
            yesNo(r.isNationalId),
            yesNo(r.nameMatched),
            yesNo(r.idNumberMatched),
            r.failureReason || '—',
          ])
        : [['—', '—', 'No photo reads recorded', '—', '—', '—', '—', '—', '—']],
    styles: { fontSize: 7, cellPadding: 1.4, overflow: 'linebreak' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7 },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = ((doc as any).lastAutoTable?.finalY ?? y) + 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  if (y > 250) {
    doc.addPage();
    y = 20;
  }
  doc.text('Financial Ops decisions', margin, y);

  autoTable(doc, {
    startY: y + 3,
    margin: { left: margin, right: margin },
    head: [['Payout destination', 'Status', 'ID number', 'Name on ID', 'Account name', 'ID sent', 'Decided', 'Reason']],
    body:
      input.decisions.length > 0
        ? input.decisions.map((d) => [
            d.destination,
            d.status,
            d.nationalId || '—',
            d.nationalIdName || '—',
            d.accountName || '—',
            stamp(d.submittedAt),
            stamp(d.decidedAt),
            d.decisionReason || '—',
          ])
        : [['—', '—', '—', '—', 'No decisions recorded', '—', '—', '—']],
    styles: { fontSize: 7, cellPadding: 1.4, overflow: 'linebreak' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7 },
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(130, 130, 130);
    doc.text(
      `Welile identity verification audit · page ${p} of ${pages} · confidential`,
      margin,
      doc.internal.pageSize.getHeight() - 8,
    );
  }

  return doc;
}
