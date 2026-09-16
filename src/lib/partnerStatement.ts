/**
 * The partner portfolio statement, as a PDF.
 *
 * A record of what actually happened: every portfolio, what was put in, the
 * Returns added to it, money taken out, renewals and office corrections. That
 * is a different document from the projection PDF, which shows what a
 * portfolio is *expected* to earn — one looks back, the other forward, and a
 * partner usually wants to be asked which.
 *
 * Drawn with jsPDF + autoTable like every other statement in the product, so
 * the text is real vector text a person can select and search, page breaks and
 * repeating table headers are handled, and the file is a few tens of KB rather
 * than a screenshot of a web page.
 *
 * Read-only. `my_portfolio_statement` proves ownership from `auth.uid()`, so
 * the browser cannot ask for anyone else's portfolios.
 */
import { supabase } from '@/integrations/supabase/client';

export interface StatementCompound { date: string; amount: number; reference: string | null }
export interface StatementPayout { date: string; amount: number; reference: string | null }
export interface StatementChange { date: string; what: string }

export interface StatementPortfolio {
  id: string;
  code: string | null;
  name: string | null;
  status: string;
  roi_mode: string | null;
  rate: number;
  current_value: number;
  start_date: string;
  maturity_date: string | null;
  days_left: number | null;
  next_roi_date: string | null;
  duration_months: number | null;
  auto_reinvest: boolean;
  compounds: StatementCompound[];
  renewals: { date: string }[];
  changes: StatementChange[];
  payouts: StatementPayout[];
}

export interface StatementData {
  generated_at: string;
  partner: { name: string | null; phone: string | null; mobile_money: string | null } | null;
  payouts_total: { count: number; amount: number };
  portfolios: StatementPortfolio[];
  error?: string;
}

/** Fetch the signed-in partner's statement. Omit the id for every portfolio. */
export async function fetchPartnerStatement(portfolioId?: string): Promise<StatementData> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'my_portfolio_statement', { p_portfolio_id: portfolioId ?? null },
  );
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Partial<StatementData>;
  if (d.error) throw new Error('Please sign in again to download your statement.');
  return {
    generated_at: d.generated_at ?? new Date().toISOString(),
    partner: d.partner ?? null,
    payouts_total: d.payouts_total ?? { count: 0, amount: 0 },
    portfolios: Array.isArray(d.portfolios) ? d.portfolios : [],
  };
}

/* ───────────────────────────── shared helpers ──────────────────────────── */

const PURPLE: [number, number, number] = [107, 33, 168];
const INK: [number, number, number] = [15, 23, 42];
const MUTED: [number, number, number] = [100, 116, 139];
const DASH = '—';

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const ugx = (v: unknown) => Math.round(n(v)).toLocaleString('en-US');
const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : DASH);

const STATUS: Record<string, string> = {
  active: 'Active',
  cancelled: 'Closed',
  awaiting_partner_details: 'Awaiting your details',
  locked: 'Locked',
  pending_ops_approval: 'Being set up',
};
const statusOf = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ');

/** Compound, Payout or Self support, in the partner's own words. */
export function typeOf(p: StatementPortfolio): string {
  const code = p.code ?? '';
  if (code.startsWith('WSP') || code.startsWith('WSH')) return 'Self support';
  return (p.roi_mode ?? '').includes('compound') ? 'Compound' : 'Payout';
}

function modeWords(p: StatementPortfolio): string {
  if (typeOf(p) === 'Self support') return 'Self support';
  return (p.roi_mode ?? '').includes('compound')
    ? 'Return added back each month'
    : 'Return paid to you each month';
}

/* Returns are folded into the balance as they are earned, so what the partner
   actually put in is the balance less those Returns. Showing the two apart is
   the whole point of the statement. */
const compoundedOf = (p: StatementPortfolio) =>
  (p.compounds ?? []).reduce((s, c) => s + n(c.amount), 0);
const principalOf = (p: StatementPortfolio) =>
  Math.max(0, n(p.current_value) - compoundedOf(p));

/* Only the parts of the jsPDF document this file touches. Enough to keep the
   call sites honest without pulling the library's types into the bundle. */
interface JsPdfDoc {
  internal: { pageSize: { getWidth(): number; getHeight(): number } };
  setFillColor(r: number, g: number, b: number): void;
  setDrawColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setFont(name: string, style?: string): void;
  setFontSize(size: number): void;
  text(text: string | string[], x: number, y: number, opts?: { align?: string }): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  roundedRect(x: number, y: number, w: number, h: number, rx: number, ry: number, style?: string): void;
  splitTextToSize(text: string, width: number): string[];
  addPage(): void;
  setPage(n: number): void;
  getNumberOfPages(): number;
  output(type: string): Blob;
  lastAutoTable: { finalY: number };
}

/* ─────────────────────────────── the PDF ───────────────────────────────── */

export async function generateStatementPdf(d: StatementData): Promise<Blob> {
  /* jspdf is published with both a named and a default export, and the two
     other PDF builders in this repo each pick a different one. Under the
     bundler either works; outside it (a test, SSR) only one does. Take
     whichever is actually there rather than betting on the packaging. */
  const pdfMod = await import('jspdf') as unknown as Record<string, unknown>;
  const jsPDF = (pdfMod.jsPDF
    ?? (pdfMod.default as Record<string, unknown> | undefined)?.jsPDF
    ?? pdfMod.default) as new (opts: Record<string, unknown>) => JsPdfDoc;

  const tableMod = await import('jspdf-autotable') as unknown as Record<string, unknown>;
  const autoTable = (tableMod.default ?? tableMod) as
    (doc: unknown, opts: Record<string, unknown>) => void;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const margin = 12;
  const lastY = () => doc.lastAutoTable.finalY;

  const ps = d.portfolios;
  const totalPrincipal = ps.reduce((s, p) => s + principalOf(p), 0);
  const totalCompounded = ps.reduce((s, p) => s + compoundedOf(p), 0);
  const totalValue = ps.reduce((s, p) => s + n(p.current_value), 0);
  const totalMonthly = ps.reduce((s, p) => s + Math.round(principalOf(p) * n(p.rate) / 100), 0);
  const active = ps.filter((p) => p.status === 'active').length;
  const dateStr = String(d.generated_at).slice(0, 10);
  const who = d.partner?.name ?? 'Partner';

  /* ---- masthead ---- */
  doc.setFillColor(...PURPLE);
  doc.rect(0, 0, pw, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('WELILE TECHNOLOGIES LIMITED', margin, 11);
  doc.setFontSize(15);
  doc.text('Partner Portfolio Statement', margin, 19);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text('Everything you have put in, what it has earned, and what it is worth today',
    margin, 24.5);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(who, pw - margin, 12, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text(`Statement date ${dateStr}`, pw - margin, 17, { align: 'right' });
  doc.text(`${ps.length} portfolios · ${active} still running`, pw - margin, 21.5, { align: 'right' });

  /* ---- who this is ---- */
  doc.setTextColor(...INK);
  autoTable(doc, {
    startY: 34,
    head: [['Partner', 'Mobile money', 'Phone']],
    body: [[who, d.partner?.mobile_money ?? DASH, d.partner?.phone ?? DASH]],
    theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 2 },
    headStyles: { fillColor: PURPLE, textColor: 255, fontSize: 8 },
    margin: { left: margin, right: margin },
  });

  /* ---- the four figures ---- */
  autoTable(doc, {
    startY: lastY() + 5,
    head: [['MONEY YOU PUT IN', 'RETURN ADDED', 'TOTAL CAPITAL', 'RETURN EACH MONTH']],
    body: [[
      `UGX ${ugx(totalPrincipal)}`,
      `UGX ${ugx(totalCompounded)}`,
      `UGX ${ugx(totalValue)}`,
      `UGX ${ugx(totalMonthly)}`,
    ]],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 3, halign: 'center', fontStyle: 'bold' },
    headStyles: { fillColor: [248, 250, 252], textColor: MUTED, fontSize: 7, fontStyle: 'bold' },
    margin: { left: margin, right: margin },
  });

  /* ---- every portfolio on one page ---- */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`All your portfolios (${ps.length})`, margin, lastY() + 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text('Return is what one month earns on the principal, at the rate shown.',
    margin, lastY() + 13);
  doc.setTextColor(...INK);

  autoTable(doc, {
    startY: lastY() + 16,
    head: [['#', 'Portfolio', 'Status', 'Rate', 'Principal', 'Return', 'Current value',
            'Start', 'Matures', 'Days', 'Type']],
    body: ps.map((p, i) => {
      const principal = principalOf(p);
      return [
        String(i + 1),
        p.code ?? p.id.slice(0, 8),
        statusOf(p.status),
        `${n(p.rate)}%`,
        ugx(principal),
        ugx(Math.round(principal * n(p.rate) / 100)),
        ugx(p.current_value),
        day(p.start_date),
        day(p.maturity_date),
        p.days_left == null ? DASH : String(p.days_left),
        typeOf(p),
      ];
    }),
    foot: [['', 'TOTALS', '', '', ugx(totalPrincipal), ugx(totalMonthly), ugx(totalValue),
            '', '', '', '']],
    theme: 'grid',
    styles: { fontSize: 6.8, cellPadding: 1.4, overflow: 'linebreak' },
    headStyles: { fillColor: PURPLE, textColor: 255, fontSize: 6.5 },
    footStyles: { fillColor: [248, 250, 252], textColor: INK, fontStyle: 'bold', fontSize: 6.8 },
    columnStyles: {
      0: { cellWidth: 6, halign: 'right' },
      3: { halign: 'right' }, 4: { halign: 'right' },
      5: { halign: 'right' }, 6: { halign: 'right', fontStyle: 'bold' },
      9: { halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });

  /* ---- the caveat, stated plainly rather than left as an empty table ---- */
  const noteY = lastY() + 6;
  doc.setFillColor(250, 245, 255);
  doc.setDrawColor(233, 213, 255);
  doc.roundedRect(margin, noteY, pw - margin * 2, 16, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('About money taken out', margin + 3, noteY + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(...MUTED);
  doc.text(
    doc.splitTextToSize(
      `${d.payouts_total.count} payouts totalling UGX ${ugx(d.payouts_total.amount)} are recorded on this ` +
      'account. A payout only appears against a portfolio below when it records which portfolio it came ' +
      'from, so "current value" is the portfolio balance rather than the balance after money was taken out.',
      pw - margin * 2 - 6),
    margin + 3, noteY + 9);
  doc.setTextColor(...INK);

  /* ---- one block per portfolio ---- */
  for (const p of ps) {
    doc.addPage();
    const principal = principalOf(p);
    const compounded = compoundedOf(p);

    doc.setFillColor(...PURPLE);
    doc.rect(0, 0, pw, 16, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(p.code ?? p.id.slice(0, 8), margin, 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(`${statusOf(p.status)} · ${n(p.rate)}% · ${modeWords(p)}`, pw - margin, 10,
      { align: 'right' });
    doc.setTextColor(...INK);

    autoTable(doc, {
      startY: 22,
      head: [['Portfolio details', '']],
      body: [
        ['Contribution date', day(p.start_date)],
        ['Portfolio name', p.name || p.code || DASH],
        ['Portfolio ID', p.id.slice(0, 8)],
        ['Return rate', `${n(p.rate)}%`],
        ['Maturity date', day(p.maturity_date)],
        ['Days left', p.days_left == null ? DASH : String(p.days_left)],
        ['Term', p.duration_months == null ? DASH : `${p.duration_months} months`],
        ['Principal', `UGX ${ugx(principal)}`],
        ['Return each month', `UGX ${ugx(Math.round(principal * n(p.rate) / 100))}`],
        ['Worth now', `UGX ${ugx(p.current_value)}`],
      ],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.8 },
      headStyles: { fillColor: PURPLE, textColor: 255, fontSize: 8 },
      columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: margin, right: margin },
    });

    const section = (
      title: string,
      head: string[],
      body: string[][],
      empty: string,
      foot?: string[],
    ) => {
      autoTable(doc, {
        startY: lastY() + 5,
        head: [[{ content: title, colSpan: head.length, styles: { halign: 'left' } }], head],
        body: body.length ? body : [[{ content: empty, colSpan: head.length,
                                       styles: { textColor: MUTED, fontStyle: 'italic' } }]],
        foot: foot ? [foot] : undefined,
        theme: 'grid',
        styles: { fontSize: 7.5, cellPadding: 1.6 },
        headStyles: { fillColor: PURPLE, textColor: 255, fontSize: 7.5 },
        footStyles: { fillColor: [248, 250, 252], textColor: INK, fontStyle: 'bold', fontSize: 7.5 },
        columnStyles: { [head.length - 1]: { halign: 'right' } },
        margin: { left: margin, right: margin },
      });
    };

    section('Payouts (money taken out)', ['Date', 'Reference', 'Amount (UGX)'],
      (p.payouts ?? []).map((w) => [day(w.date), w.reference ?? DASH, ugx(w.amount)]),
      'No payout is linked to this portfolio.');

    section('Top-ups', ['Date', 'What happened', 'Amount (UGX)'],
      [[day(p.start_date), 'Portfolio opened', ugx(principal)]],
      'No top-up recorded.');

    section('Compounds (Return added)', ['Date', 'Reference', 'Amount (UGX)'],
      (p.compounds ?? []).map((c) => [day(c.date), c.reference ?? DASH, ugx(c.amount)]),
      'No Return has been added to this portfolio yet.',
      compounded > 0 ? ['Total', '', ugx(compounded)] : undefined);

    const changes = [
      ...(p.renewals ?? []).map((r) => ({ date: r.date, what: 'Renewed for another term' })),
      ...(p.changes ?? []),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    section('Renewals & changes', ['Date', 'What happened'],
      changes.map((c) => [day(c.date), c.what]),
      'No renewal or change recorded.');
  }

  /* ---- footer on every page, numbered once the total is known ---- */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(`WELILE TECHNOLOGIES LIMITED · PARTNER PORTFOLIO STATEMENT · ${who}`,
      margin, ph - 7);
    doc.text(`${dateStr} · Page ${i} of ${pages}`, pw - margin, ph - 7, { align: 'right' });
  }

  return doc.output('blob');
}

/**
 * Build and save the statement as a PDF.
 * @param portfolioId omit for every portfolio the partner holds.
 */
export async function downloadPartnerStatement(portfolioId?: string): Promise<void> {
  const data = await fetchPartnerStatement(portfolioId);
  if (data.portfolios.length === 0) {
    throw new Error('There are no portfolios to put in a statement yet.');
  }
  const blob = await generateStatementPdf(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const who = (data.partner?.name ?? 'partner').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const scope = portfolioId
    ? (data.portfolios[0].code ?? portfolioId.slice(0, 8))
    : 'all-portfolios';
  a.href = url;
  a.download = `welile-statement-${who}-${scope}-${String(data.generated_at).slice(0, 10)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a later tick so the download has taken its reference.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
