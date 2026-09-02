import jsPDF from 'jspdf';

export type LandlordAgreementTemplateInput = {
  landlordName?: string | null;
  landlordPhone?: string | null;
  propertyAddress?: string | null;
  monthlyRent?: number | null;
  nin?: string | null;
  houseNumber?: string | null;
  paymentDay?: string | number | null;
};

const MARGIN = 16;
const LINE = 5.2;

function fmtRent(value?: number | null) {
  if (!value || Number.isNaN(Number(value))) return '__________________';
  return `UGX ${Number(value).toLocaleString('en-UG')}`;
}

function blank(value?: string | number | null, width = 34) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || '_'.repeat(width);
}

/**
 * Blank/pre-filled 12-month landlord agreement the agent prints and has the
 * landlord sign, then uploads back into the platform.
 */
export function downloadLandlordAgreementTemplate(input: LandlordAgreementTemplateInput = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  let y = MARGIN;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const heading = (text: string) => {
    ensureSpace(10);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text(text, MARGIN, y);
    y += LINE + 1;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
  };

  const para = (text: string) => {
    const lines = doc.splitTextToSize(text, contentWidth);
    ensureSpace(lines.length * LINE);
    doc.text(lines, MARGIN, y);
    y += lines.length * LINE + 1.5;
  };

  const rows = (pairs: [string, string][]) => {
    pairs.forEach(([label, value]) => {
      ensureSpace(LINE);
      doc.setFont('helvetica', 'bold');
      doc.text(`${label}:`, MARGIN, y);
      doc.setFont('helvetica', 'normal');
      doc.text(value, MARGIN + 52, y);
      y += LINE;
    });
    y += 2;
  };

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('WELILE TECHNOLOGIES LIMITED', pageWidth / 2, y, { align: 'center' });
  y += 6;
  doc.setFontSize(11.5);
  doc.text('LANDLORD PROPERTY MANAGEMENT AGREEMENT (12 MONTHS)', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text('Print, complete in ink, sign with a witness, then upload the signed copy in the Welile app.', pageWidth / 2, y, { align: 'center' });
  y += 8;

  heading('1. PARTIES AND PROPERTY');
  rows([
    ['Landlord name', blank(input.landlordName)],
    ['Landlord phone', blank(input.landlordPhone)],
    ['National ID (NIN)', blank(input.nin)],
    ['Property address', blank(input.propertyAddress, 46)],
    ['House number', blank(input.houseNumber, 20)],
    ['House category', blank(null, 20)],
    ['Number of rooms', blank(null, 12)],
    ['Monthly rent', fmtRent(input.monthlyRent)],
    ['Rent payment day', blank(input.paymentDay, 8)],
    ['Agreement date', blank(null, 20)],
    ['Start date', blank(null, 20)],
    ['End date (12 months)', blank(null, 20)],
  ]);

  heading('2. TERM');
  para('This agreement runs for twelve (12) calendar months from the start date above. It may be renewed by a fresh signed agreement. Any change to rent, payout details, or landlord identity during the term requires a signed addendum.');

  heading('3. WHAT WELILE DOES');
  para('a) Welile markets the property, screens tenants, and supports tenant placement.');
  para('b) Welile records rent collections and remits the landlord\'s rent to the payout details recorded below.');
  para('c) Welile keeps a digital record of this property, its tenants, and all payments made.');

  heading('4. WHAT THE LANDLORD AGREES');
  para('a) The landlord confirms lawful ownership or authority to let the property described above.');
  para('b) The landlord will keep the property habitable and handle structural repairs.');
  para('c) The landlord will not collect rent directly from a Welile-placed tenant outside the platform.');
  para('d) The landlord will give written notice before changing rent, and such change only takes effect through a signed addendum.');

  heading('5. RENT AND PAYOUT DETAILS');
  rows([
    ['Payout mode (Bank / MoMo)', blank(null, 26)],
    ['Bank name', blank(null, 30)],
    ['Account name', blank(null, 30)],
    ['Account number', blank(null, 30)],
    ['Mobile money name', blank(null, 30)],
    ['Mobile money number', blank(null, 30)],
  ]);

  heading('6. UTILITIES');
  rows([
    ['Water meter number', blank(null, 26)],
    ['Water registered name', blank(null, 26)],
    ['Electricity meter number', blank(null, 26)],
    ['Electricity registered name', blank(null, 26)],
  ]);

  heading('7. TERMINATION');
  para('Either party may end this agreement by giving thirty (30) days written notice. Rent already collected for a sitting tenant remains payable to the landlord for the period the tenant occupied the property.');

  heading('8. DISPUTES AND GOVERNING LAW');
  para('The parties will first attempt to resolve any dispute amicably. Failing that, the matter is governed by the laws of the Republic of Uganda.');

  heading('9. SIGNATURES');
  para('By signing below, the parties confirm that the details recorded above are true and complete.');

  const signatureBlock = (title: string) => {
    ensureSpace(26);
    doc.setFont('helvetica', 'bold');
    doc.text(title, MARGIN, y);
    y += LINE + 2;
    doc.setFont('helvetica', 'normal');
    doc.text('Name: ______________________________', MARGIN, y);
    doc.text('Signature: ______________________', MARGIN + 92, y);
    y += LINE + 2;
    doc.text('Date: ______________________________', MARGIN, y);
    y += LINE + 4;
  };

  signatureBlock('LANDLORD');
  signatureBlock('FOR WELILE TECHNOLOGIES LIMITED');
  signatureBlock('WITNESS');

  ensureSpace(12);
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text('After signing: upload a clear scan or photo of every page in the Welile app under the landlord profile.', MARGIN, y);
  y += 4;
  doc.text('Unsigned or incomplete agreements cannot be verified.', MARGIN, y);

  const safeName = (input.landlordName || 'landlord').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  doc.save(`welile-landlord-agreement-${safeName}.pdf`);
}
