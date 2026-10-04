// Generates a branded, easy-to-read one/two-page PDF summarising every way an
// agent earns money on Welile. Designed to be shared on WhatsApp as an
// attachment. jsPDF is imported dynamically to keep it out of the main bundle.

export const EARNINGS_SHARE_URL = 'https://welileapp.com/agent-commission-benefits';
export const EARNINGS_JOIN_URL = 'https://welileapp.com/join';

export const EARNINGS_SHARE_CAPTION = `💰 *How You Earn Money as a Welile Agent*

See every way you can earn — landlord registration (your #1 priority), 10% rent commission, recruit bonuses and more.

👉 Join Welile as an Agent: ${EARNINGS_JOIN_URL}`;

/** Builds the branded earnings PDF and returns it as a Blob. */
export async function generateAgentEarningsPdf(): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 40;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // Brand palette (Welile purple).
  const PRIMARY: [number, number, number] = [107, 33, 168];
  const DARK: [number, number, number] = [30, 41, 59];
  const GREY: [number, number, number] = [100, 116, 139];
  const LIGHT: [number, number, number] = [245, 240, 255];

  let y = 0;

  const ensureSpace = (needed: number) => {
    if (y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  // ---- Header band ----
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, PAGE_W, 90, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('How You Earn with Welile', MARGIN, 48);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.text('Every way an agent earns money', MARGIN, 70);
  y = 120;

  // ---- Priority callout ----
  ensureSpace(86);
  doc.setFillColor(...LIGHT);
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(1.5);
  doc.roundedRect(MARGIN, y, CONTENT_W, 80, 8, 8, 'FD');
  doc.setTextColor(...PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('YOUR #1 PRIORITY', MARGIN + 16, y + 22);
  doc.setTextColor(...DARK);
  doc.setFontSize(16);
  doc.text('Register a Landlord', MARGIN + 16, y + 44);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GREY);
  doc.setFontSize(11);
  doc.text('Earn UGX 4,000 when verified, then 10% of every rent payment forever.', MARGIN + 16, y + 64);
  y += 100;

  // ---- Section helper ----
  const sectionTitle = (title: string) => {
    ensureSpace(34);
    doc.setFillColor(...PRIMARY);
    doc.rect(MARGIN, y, 4, 16, 'F');
    doc.setTextColor(...DARK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(title, MARGIN + 14, y + 13);
    y += 30;
  };

  const bullet = (label: string, amount: string) => {
    ensureSpace(22);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    const wrapped = doc.splitTextToSize(label, CONTENT_W - 120);
    doc.text('•', MARGIN + 6, y + 11);
    doc.text(wrapped, MARGIN + 20, y + 11);
    if (amount) {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...PRIMARY);
      doc.text(amount, PAGE_W - MARGIN, y + 11, { align: 'right' });
    }
    y += Math.max(wrapped.length * 13, 20);
  };

  // ---- Rent commission ----
  sectionTitle('Earn 10% Every Time Your Tenant Pays Rent');
  bullet('Agent who REGISTERED the tenant', '2%');
  bullet('Agent MANAGING the tenant', '8%');
  bullet('Register AND manage the same tenant — keep the full amount', '10%');
  y += 8;

  // ---- Recruit & funders ----
  sectionTitle('Grow Your Network');
  bullet('From every tenant managed by an agent you recruited', '2%');
  bullet('From investment by a funder you bring (1% on Angel Pool)', '2%');
  y += 8;

  // ---- Cash bonuses ----
  sectionTitle('Extra Cash Bonuses');
  bullet('Help a tenant apply for rent', 'UGX 5,000');
  bullet('List an empty house (paid after verification)', 'UGX 2,000');
  bullet('A tenant moves into a house you listed', 'UGX 10,000');
  bullet('Landlord on your rent request verified', 'UGX 4,000');
  bullet("Sub-agent's house / landlord / LC1 verified", 'UGX 1,000');
  bullet('Rent request posted & listed', 'UGX 1,000');
  bullet('Replace a tenant in a house', 'UGX 20,000');
  bullet('Register a new agent under you', 'UGX 10,000');
  bullet('Set up a Welile Service Centre', 'UGX 25,000');
  y += 8;

  // ---- Footer note ----
  ensureSpace(40);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(10);
  doc.setTextColor(...GREY);
  doc.text('All your earnings go straight to your Welile Wallet.', MARGIN, y + 10);
  y += 26;

  // ---- Footer band with join link on every page ----
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFillColor(...PRIMARY);
    doc.rect(0, PAGE_H - 30, PAGE_W, 30, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(`Join as an Agent: ${EARNINGS_JOIN_URL}`, MARGIN, PAGE_H - 11);
    doc.text(`${p} / ${pageCount}`, PAGE_W - MARGIN, PAGE_H - 11, { align: 'right' });
  }

  return doc.output('blob');
}