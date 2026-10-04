import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface AgentProductKpis {
  total_products: number;
  in_field_items: number;
  in_field_agents: number;
  in_field_amount: number;
  in_field_outstanding: number;
  in_field_repaid: number;
  purchased_qty: number;
  purchased_value: number;
  stock_qty: number;
  service_centres: number;
  pending_applications?: number;
}

export interface AgentProductRow {
  agent_id: string;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  location_name: string | null;
  items_held: number;
  distinct_products: number;
  held_amount: number;
  repaid_amount: number;
  outstanding_amount: number;
  last_issued_on: string | null;
  product_names: string[] | null;
}

const ugx = (n: any) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString();
const day = (d?: string | null) => {
  if (!d) return '—';
  try { return format(new Date(d.length <= 10 ? `${d}T00:00:00` : d), 'dd MMM yyyy'); } catch { return String(d); }
};

export function generateAgentProductsInFieldPdf(opts: {
  kpis: AgentProductKpis;
  rows: AgentProductRow[];
  actor: string;
}): Blob {
  const { kpis, rows, actor } = opts;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  const brand: [number, number, number] = [88, 28, 135];
  let y = 14;

  doc.setFillColor(brand[0], brand[1], brand[2]);
  doc.rect(0, 0, pageWidth, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('WELILE', margin, 9);
  doc.setFontSize(13);
  doc.text('AGENT PRODUCTS & SERVICES — IN FIELD', margin, 16.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')} (EAT)`, margin, 21.5);
  y = 31;

  doc.setTextColor(90, 90, 100);
  doc.setFontSize(7.5);
  doc.text(`Reported by: ${actor}`, pageWidth - margin, y, { align: 'right' });
  y += 5;

  // KPI band
  const cards: [string, string][] = [
    ['Total products', num(kpis.total_products)],
    ['In field (items)', num(kpis.in_field_items)],
    ['Purchased stock', num(kpis.stock_qty)],
    ['Service centres', num(kpis.service_centres)],
    ['Held amount', ugx(kpis.in_field_amount)],
    ['Repaid', ugx(kpis.in_field_repaid)],
    ['Outstanding', ugx(kpis.in_field_outstanding)],
  ];
  const cw = contentWidth / cards.length;
  cards.forEach((c, i) => {
    const x = margin + i * cw;
    doc.setDrawColor(220, 220, 230);
    doc.setFillColor(250, 250, 253);
    doc.rect(x, y, cw - 2, 14, 'FD');
    doc.setTextColor(110, 110, 125);
    doc.setFontSize(6.5);
    doc.text(c[0].toUpperCase(), x + 2, y + 5);
    doc.setTextColor(30, 30, 40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text(c[1], x + 2, y + 11);
    doc.setFont('helvetica', 'normal');
  });
  y += 20;

  const head = ['Agent', 'Location', 'Products held', 'Items', 'Held amount', 'Repaid', 'Outstanding', 'Date'];
  const widths = [48, 40, 62, 14, 30, 28, 30, 22];
  const aligns: ('left' | 'right')[] = ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'left'];

  const drawHead = () => {
    doc.setFillColor(brand[0], brand[1], brand[2]);
    doc.rect(margin, y, contentWidth, 6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    let hx = margin + 2;
    head.forEach((h, i) => {
      const align = aligns[i];
      doc.text(h, align === 'right' ? hx + widths[i] - 4 : hx, y + 4, { align });
      hx += widths[i];
    });
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(35, 35, 45);
  };
  drawHead();

  rows.forEach((r, idx) => {
    if (y + 5.2 > pageHeight - 16) { doc.addPage(); y = 16; drawHead(); }
    if (idx % 2 === 1) {
      doc.setFillColor(248, 248, 252);
      doc.rect(margin, y, contentWidth, 5.2, 'F');
    }
    const cells = [
      r.full_name || r.agent_id.slice(0, 8),
      r.location_name || '—',
      (r.product_names || []).join(', ') || '—',
      num(r.items_held),
      ugx(r.held_amount),
      ugx(r.repaid_amount),
      ugx(r.outstanding_amount),
      day(r.last_issued_on),
    ];
    doc.setFontSize(7);
    let cx = margin + 2;
    cells.forEach((c, i) => {
      const align = aligns[i];
      const text = doc.splitTextToSize(String(c), widths[i] - 4)[0] ?? '';
      doc.text(text, align === 'right' ? cx + widths[i] - 4 : cx, y + 3.6, { align });
      cx += widths[i];
    });
    y += 5.2;
  });

  y += 6;
  doc.setTextColor(120, 120, 135);
  doc.setFontSize(6.5);
  doc.text(
    'Repayments are recovered automatically from agent wallets through the merchandise recovery plans.',
    margin,
    Math.min(y, pageHeight - 8),
  );

  return doc.output('blob');
}