// Downloads the signed-in agent's full tenant list as a PDF.
//
// Columns requested by the field team: tenant name, phone number, rent plan
// amount and paid so far. All figures come from the same server RPC the
// My Tenants list uses (get_agent_tenants_overview) — never recomputed in the
// client. Amounts are printed as UGX with thousands separators.
// jsPDF is imported dynamically to keep it out of the main bundle.
import { supabase } from '@/integrations/supabase/client';

interface AgentTenantOverviewRow {
  full_name: string | null;
  phone: string | null;
  total_repayment: number | null;
  amount_repaid: number | null;
}

function ugx(amount: number): string {
  return `UGX ${Math.round(amount).toLocaleString('en-US')}`;
}

/** Builds the tenant-list PDF and returns it as a Blob. */
async function generateAgentTenantsPdf(
  rows: AgentTenantOverviewRow[],
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 40;

  // Brand palette (Welile purple) — same as the other agent PDFs.
  const PRIMARY: [number, number, number] = [107, 33, 168];
  const DARK: [number, number, number] = [30, 41, 59];
  const GREY: [number, number, number] = [100, 116, 139];
  const LIGHT: [number, number, number] = [245, 240, 255];

  // ---- Header band ----
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, PAGE_W, 90, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('My Tenants', MARGIN, 48);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.text(
    `${rows.length} tenant${rows.length === 1 ? '' : 's'}  •  ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    MARGIN,
    70,
  );

  // ---- Table ----
  const COLS = [
    { label: 'Tenant Name', x: MARGIN, w: 150 },
    { label: 'Phone Number', x: MARGIN + 155, w: 100 },
    { label: 'Rent Plan Amount', x: MARGIN + 260, w: 95 },
    { label: 'Paid So Far', x: MARGIN + 360, w: 95 },
  ];
  const ROW_H = 26;
  let y = 120;

  const drawTableHeader = () => {
    doc.setFillColor(...LIGHT);
    doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...PRIMARY);
    COLS.forEach((c) => doc.text(c.label, c.x + 6, y + 17));
    y += ROW_H;
  };

  drawTableHeader();

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  rows.forEach((r, i) => {
    if (y + ROW_H > PAGE_H - 50) {
      doc.addPage();
      y = 40;
      drawTableHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
    }
    if (i % 2 === 1) {
      doc.setFillColor(250, 248, 253);
      doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H, 'F');
    }
    doc.setTextColor(...DARK);
    doc.text(doc.splitTextToSize(r.full_name || 'Tenant', COLS[0].w - 10)[0], COLS[0].x + 6, y + 17);
    doc.text(r.phone || '—', COLS[1].x + 6, y + 17);
    doc.text(ugx(Number(r.total_repayment || 0)), COLS[2].x + 6, y + 17);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...PRIMARY);
    doc.text(ugx(Number(r.amount_repaid || 0)), COLS[3].x + 6, y + 17);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK);
    y += ROW_H;
  });

  // ---- Footer band on every page ----
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFillColor(...PRIMARY);
    doc.rect(0, PAGE_H - 30, PAGE_W, 30, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Welile — My Tenants', MARGIN, PAGE_H - 11);
    doc.text(`${p} / ${pageCount}`, PAGE_W - MARGIN, PAGE_H - 11, { align: 'right' });
  }

  doc.setTextColor(...GREY);
  return doc.output('blob');
}

function downloadPdf(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function exportAgentTenantsList(): Promise<{ ok: boolean; count: number }> {
  const { data, error } = await supabase.rpc('get_agent_tenants_overview', {
    p_today_start: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
  });
  if (error) throw error;

  const rows = (data || []) as unknown as AgentTenantOverviewRow[];

  const blob = await generateAgentTenantsPdf(rows);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadPdf(blob, `welile-tenants-list-${stamp}.pdf`);

  return { ok: true, count: rows.length };
}
