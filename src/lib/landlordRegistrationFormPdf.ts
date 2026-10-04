import welileLogoUrl from '@/assets/welile-logo.png';
import { sharePdfViaWhatsApp } from '@/lib/whatsappShare';

/**
 * Branded, printable LANDLORD REGISTRATION FORM (blank, fill-by-hand).
 * Captures the full set of details we collect for a landlord with a rental,
 * so an agent can print it, have a landlord fill it in the field, then key it
 * into the app. Branded top-left with the Welile logo and shareable on
 * WhatsApp via the native share sheet.
 */

const BRAND = { r: 22, g: 122, b: 90 }; // Welile green-ish accent

async function loadLogoBase64(): Promise<string | null> {
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

export interface LandlordFormPrefill {
  name?: string;
  phone?: string;
  propertyAddress?: string;
}

export async function generateLandlordRegistrationFormPdf(
  prefill: LandlordFormPrefill = {},
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const cw = pw - margin * 2;

  // ── Header band ──
  pdf.setFillColor(BRAND.r, BRAND.g, BRAND.b);
  pdf.rect(0, 0, pw, 26, 'F');

  const logo = await loadLogoBase64();
  if (logo) {
    // White rounded chip behind the logo so it reads on the green band
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(margin, 5, 16, 16, 2, 2, 'F');
    pdf.addImage(logo, 'PNG', margin + 1.5, 6.5, 13, 13);
  }
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text('Landlord Registration Form', margin + 21, 13);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.text("Welile — Africa's rent trust network", margin + 21, 18.5);

  pdf.setFontSize(7.5);
  pdf.text('welileapp.com', pw - margin, 12, { align: 'right' });
  pdf.text(`Date: ____ / ____ / ______`, pw - margin, 18.5, { align: 'right' });

  pdf.setTextColor(0, 0, 0);
  let y = 34;

  // Intro note
  pdf.setFont('helvetica', 'italic');
  pdf.setFontSize(8);
  pdf.setTextColor(90);
  pdf.text(
    'Fill in clearly in CAPITAL letters. Your agent will register you on Welile using these details.',
    margin,
    y,
  );
  pdf.setTextColor(0);
  y += 7;

  // ── Helpers ──
  const sectionTitle = (label: string) => {
    pdf.setFillColor(238, 245, 242);
    pdf.rect(margin, y - 4, cw, 7, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9.5);
    pdf.setTextColor(BRAND.r, BRAND.g, BRAND.b);
    pdf.text(label.toUpperCase(), margin + 2, y + 0.8);
    pdf.setTextColor(0);
    y += 9;
  };

  // A labelled field with a writing line. `prefill` is printed lightly on the line.
  const field = (label: string, opts: { width?: number; x?: number; prefill?: string } = {}) => {
    const x = opts.x ?? margin;
    const w = opts.width ?? cw;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(60);
    pdf.text(label, x, y);
    pdf.setTextColor(0);
    const lineY = y + 5.5;
    pdf.setDrawColor(150);
    pdf.setLineWidth(0.3);
    pdf.line(x, lineY, x + w, lineY);
    if (opts.prefill) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.text(opts.prefill, x + 1, lineY - 1.5);
    }
  };

  // Two fields side by side
  const fieldRow = (
    left: { label: string; prefill?: string },
    right: { label: string; prefill?: string },
  ) => {
    const half = (cw - 6) / 2;
    field(left.label, { x: margin, width: half, prefill: left.prefill });
    field(right.label, { x: margin + half + 6, width: half, prefill: right.prefill });
    y += 11;
  };

  const fullField = (label: string, prefill?: string) => {
    field(label, { prefill });
    y += 11;
  };

  // Checkbox row for house category
  const checkRow = (label: string, options: string[]) => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(60);
    pdf.text(label, margin, y);
    pdf.setTextColor(0);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    // Fixed 4-column grid so labels never overlap when the row wraps.
    const cols = 4;
    const colW = cw / cols;
    options.forEach((opt, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = margin + col * colW;
      const cy = y + 5 + row * 6;
      pdf.setDrawColor(120);
      pdf.setLineWidth(0.3);
      pdf.rect(cx, cy - 3, 3.2, 3.2);
      pdf.text(opt, cx + 4.8, cy - 0.3);
    });
    const rows = Math.ceil(options.length / cols);
    y += 5 + rows * 6 + 2;
  };

  // ── Section: Landlord details ──
  sectionTitle('Landlord details');
  fullField('Full name (as on National ID)', prefill.name);
  fieldRow(
    { label: 'Phone number', prefill: prefill.phone },
    { label: 'Alternative phone' },
  );
  fullField('National ID number (NIN)');

  // ── Section: Property ──
  sectionTitle('Property / rental details');
  fullField('Property address / location', prefill.propertyAddress);
  fieldRow(
    { label: 'Village / Zone' },
    { label: 'District' },
  );
  fieldRow(
    { label: 'Number of rentals' },
    { label: 'Monthly rent (UGX)' },
  );
  checkRow('House category (tick one)', [
    'Single Room', 'Double Room', 'Bedsitter', 'One Bedroom',
    'Two Bedroom', 'Three Bedroom', 'Commercial', 'Mixed',
  ]);

  // ── Section: Payout ──
  sectionTitle('Mobile money (payout)');
  fieldRow(
    { label: 'MoMo registered name' },
    { label: 'MoMo number' },
  );

  // ── Section: Utility meters ──
  sectionTitle('Utility meters');
  fieldRow(
    { label: 'NWSC water meter no.' },
    { label: 'UEDCL electricity meter no.' },
  );

  // ── Section: LC1 ──
  sectionTitle('LC1 chairperson (verification)');
  fieldRow(
    { label: 'LC1 chairperson name' },
    { label: 'LC1 chairperson phone' },
  );

  // ── Section: Agent ──
  sectionTitle('Registering agent (office use)');
  fieldRow(
    { label: 'Agent name' },
    { label: 'Agent phone' },
  );

  // ── Signatures ──
  y += 2;
  pdf.setDrawColor(180);
  pdf.line(margin, y, pw - margin, y);
  y += 8;
  const half = (cw - 6) / 2;
  pdf.setDrawColor(120);
  pdf.line(margin, y, margin + half, y);
  pdf.line(margin + half + 6, y, pw - margin, y);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(80);
  pdf.text('Landlord signature & date', margin, y + 4);
  pdf.text('Agent signature & date', margin + half + 6, y + 4);
  pdf.setTextColor(0);

  // ── Footer ──
  pdf.setDrawColor(BRAND.r, BRAND.g, BRAND.b);
  pdf.setLineWidth(0.6);
  pdf.line(margin, ph - 16, pw - margin, ph - 16);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(110);
  pdf.text(
    'By registering, the landlord agrees to receive their tenant rent payments through Welile.',
    margin,
    ph - 11,
  );
  pdf.text('Powered by Welile  •  welileapp.com', margin, ph - 7);
  pdf.text(`Generated ${new Date().toLocaleDateString('en-UG')}`, pw - margin, ph - 7, { align: 'right' });

  return pdf.output('blob');
}

/**
 * Share the landlord form through WhatsApp. Uses the native share sheet to
 * attach the PDF directly when supported, otherwise downloads the file and
 * opens a WhatsApp deep link with a caption. Returns the path taken.
 */
export async function shareLandlordRegistrationFormPdf(
  blob: Blob,
  filename = 'Welile-Landlord-Registration-Form.pdf',
  caption = 'Welile Landlord Registration Form — please print, fill in, and return to register the landlord. welileapp.com',
  phone?: string,
) {
  return sharePdfViaWhatsApp(blob, { filename, caption, phone });
}
