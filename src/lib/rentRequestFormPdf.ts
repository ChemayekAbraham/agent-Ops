import welileLogo from '@/assets/welile-logo.png';

/**
 * Generates a blank, printable "Rent Request Field Collection Form" — the list
 * of information an agent must gather in the field before posting a rent
 * request in the app. Agents can print it, fill it by hand while with the
 * tenant/landlord, then type it into the app later. Portrait A4.
 */

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

interface FieldFormInput {
  agentName?: string | null;
  agentPhone?: string | null;
}

interface Field {
  label: string;
  hint?: string;
  lines?: number; // number of blank write-lines (default 1)
}

interface Section {
  title: string;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    title: 'Tenant Details',
    fields: [
      { label: 'Full name' },
      { label: 'Phone number', hint: 'e.g. 0783 123 456' },
      { label: 'National ID (NIN)', hint: '14 characters' },
      { label: 'Preferred language' },
      { label: 'Has a smartphone?', hint: 'Yes / No' },
    ],
  },
  {
    title: 'Rent & Repayment',
    fields: [
      { label: 'Monthly rent amount (UGX)' },
      { label: 'Income type', hint: 'Daily / Weekly-Monthly / Outstanding' },
      { label: 'Rent duration', hint: '30 / 60 / 90 days' },
      { label: 'Repayment period', hint: '7 / 14 / 21 / 30 / 120 days' },
      { label: 'Outstanding balance (if any)' },
    ],
  },
  {
    title: 'Property Details',
    fields: [
      { label: 'House category', hint: 'Single room / 1-bed / 2-bed ...' },
      { label: 'Property address' },
      { label: 'City / Town' },
      { label: 'District' },
      { label: 'GPS / Landmark notes', lines: 2 },
    ],
  },
  {
    title: 'Landlord Details',
    fields: [
      { label: 'Landlord full name' },
      { label: 'Landlord phone number' },
      { label: 'Preferred landlord payout day', hint: 'Day of month' },
    ],
  },
  {
    title: 'LC1 / Local Official',
    fields: [
      { label: 'LC1 chairperson name' },
      { label: 'LC1 phone number' },
      { label: 'Village / Zone' },
    ],
  },
];

export async function generateRentRequestFormPdf(input: FieldFormInput = {}): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const logo = await loadLogo();

  let pageNo = 1;
  const drawHeader = (no: number) => {
    pdf.setFillColor(146, 52, 234);
    pdf.rect(0, 0, pw, 26, 'F');
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(margin, 5, 16, 16, 2, 2, 'F');
    if (logo) {
      try { pdf.addImage(logo, 'PNG', margin + 1.5, 6.5, 13, 13, undefined, 'FAST'); } catch { /* ignore */ }
    }
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text('Rent Request — Field Form', margin + 22, 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text('Fill this in the field, then post it in the app', margin + 22, 19);
    pdf.setFontSize(8);
    pdf.text(`Page ${no}`, pw - margin, 19, { align: 'right' });
  };

  const drawFooter = () => {
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text('welile.com  ·  Rent request field form', pw / 2, ph - 6, { align: 'center' });
  };

  drawHeader(pageNo);
  let y = 34;

  // Agent / date block
  pdf.setTextColor(20, 20, 20);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(`Agent: ${input.agentName || '____________________________'}`, margin, y);
  if (input.agentPhone) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(input.agentPhone, pw - margin, y, { align: 'right' });
  }
  y += 6;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90, 90, 90);
  pdf.text('Date: ____________________', margin, y);
  y += 8;

  const lineColor: [number, number, number] = [180, 180, 180];

  const ensure = (need: number) => {
    if (y + need > ph - 14) {
      drawFooter();
      pdf.addPage();
      pageNo += 1;
      drawHeader(pageNo);
      y = 34;
    }
  };

  for (const section of SECTIONS) {
    ensure(16);
    // Section header
    pdf.setFillColor(243, 236, 255);
    pdf.roundedRect(margin, y, pw - margin * 2, 8, 2, 2, 'F');
    pdf.setTextColor(88, 28, 135);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(section.title.toUpperCase(), margin + 4, y + 5.5);
    y += 13;

    for (const field of section.fields) {
      const lines = field.lines ?? 1;
      ensure(8 + (lines - 1) * 7);
      pdf.setTextColor(40, 40, 40);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(field.label, margin, y);
      if (field.hint) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(7.5);
        pdf.setTextColor(140, 140, 140);
        pdf.text(`(${field.hint})`, margin + pdf.getTextWidth(field.label) + 3, y);
      }
      y += 3;
      pdf.setDrawColor(...lineColor);
      for (let i = 0; i < lines; i++) {
        pdf.line(margin, y, pw - margin, y);
        y += 7;
      }
      y += 1;
    }
    y += 3;
  }

  // Notes + signature
  ensure(30);
  pdf.setFillColor(243, 236, 255);
  pdf.roundedRect(margin, y, pw - margin * 2, 8, 2, 2, 'F');
  pdf.setTextColor(88, 28, 135);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text('NOTES', margin + 4, y + 5.5);
  y += 13;
  pdf.setDrawColor(...lineColor);
  for (let i = 0; i < 2; i++) {
    pdf.line(margin, y, pw - margin, y);
    y += 7;
  }
  y += 6;
  ensure(12);
  pdf.setTextColor(40, 40, 40);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.text('Agent signature: ____________________', margin, y);
  pdf.text('Tenant signature: ____________________', pw - margin, y, { align: 'right' });

  drawFooter();
  return pdf.output('blob');
}
