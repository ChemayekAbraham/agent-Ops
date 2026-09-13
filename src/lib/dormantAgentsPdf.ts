import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';

// Bulk export of every dormant agent's tenant data at once, not logged
// before this. Plain client-side insert so the audit_logs IP-capture
// trigger sees the real browser IP directly. Never blocks the actual
// download.
async function logDormantAgentsExport(filename: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'pdf_report_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename },
    });
  } catch (e) {
    console.warn('[dormantAgentsPdf] audit log insert failed:', e);
  }
}

export interface DormantAgentTenant {
  rent_request_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  daily_amount: number;
  arrears: number;
  outstanding: number;
  plan_total: number;
  repaid: number;
  term_start: string;
  obligation_end: string;
  days_past_term: number;
  last_paid_on: string | null;
}

export interface DormantAgentEntry {
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  last_collection_on: string | null;
  never_collected: boolean;
  days_silent: number | null;
  tenants_owing: number;
  arrears_ugx: number;
  outstanding_ugx: number;
  tenants: DormantAgentTenant[];
}

export interface DormantAgentsReport {
  as_of: string;
  silent_days: number;
  timezone: string;
  totals: {
    agents: number;
    agents_never_collected: number;
    tenants_owing: number;
    arrears_ugx: number;
    outstanding_ugx: number;
  };
  agents: DormantAgentEntry[];
  generated_at: string;
}

const RED: [number, number, number] = [185, 28, 28];
const MUTED: [number, number, number] = [107, 114, 128];

/** Build and download the dormant-agents field collection worklist PDF. */
export async function downloadDormantAgentsPdf(report: DormantAgentsReport): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;

  // 1. Title
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(17, 24, 39);
  doc.text('Agents gone quiet with money owed', pageWidth / 2, 40, { align: 'center' });

  // 2. Context line
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  doc.text(
    `Agent Ops · as at ${report.as_of} · no collection for ${report.silent_days} days or more · Africa/Kampala`,
    pageWidth / 2,
    58,
    { align: 'center' },
  );

  // 3. Summary line
  doc.setFontSize(9);
  doc.text(
    `${report.totals.agents} agents · ${report.totals.agents_never_collected} never collected · ` +
      `${report.totals.tenants_owing} tenants owing · arrears ${formatUGX(report.totals.arrears_ugx)} · ` +
      `outstanding ${formatUGX(report.totals.outstanding_ugx)}`,
    pageWidth / 2,
    74,
    { align: 'center' },
  );

  let cursorY = 96;

  // 4. Per-agent blocks, in payload order
  for (const agent of report.agents) {
    const headingBlockHeight = 34;
    // Keep the heading with at least the table header on the same page.
    if (cursorY + headingBlockHeight + 46 > pageHeight - 40) {
      doc.addPage();
      cursorY = 56;
    }

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(17, 24, 39);
    const headline = `${agent.agent_name} — ${formatUGX(agent.arrears_ugx)}`;
    doc.text(headline, marginX, cursorY);
    const headlineWidth = doc.getTextWidth(headline);
    doc.setFont('helvetica', 'normal');
    doc.text(
      ` · ${agent.tenants_owing} tenants · of ${formatUGX(agent.outstanding_ugx)} outstanding`,
      marginX + headlineWidth,
      cursorY,
    );

    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    const silence = agent.never_collected
      ? 'Never collected'
      : `Silent ${agent.days_silent} days · last collected ${agent.last_collection_on}`;
    doc.text(`${agent.agent_phone || '—'} · ${silence}`, marginX, cursorY + 13);

    const tenants = agent.tenants ?? [];
    autoTable(doc, {
      startY: cursorY + 22,
      margin: { left: marginX, right: marginX, top: 56, bottom: 40 },
      head: [[
        'Tenant', 'Phone', 'Arrears', 'Outstanding', 'Daily',
        'Term start', 'Obligation end', 'Days past term', 'Last paid',
      ]],
      body: tenants.map((t) => [
        t.tenant_name,
        t.tenant_phone || '—',
        formatUGX(t.arrears),
        formatUGX(t.outstanding),
        formatUGX(t.daily_amount),
        t.term_start,
        t.obligation_end,
        String(t.days_past_term ?? 0),
        t.last_paid_on ?? '—',
      ]),
      showHead: 'everyPage',
      styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
      headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' },
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        7: { halign: 'right' },
      },
      didParseCell: (hookData: any) => {
        if (hookData.section === 'body' && hookData.column.index === 2) {
          hookData.cell.styles.textColor = RED;
        }
      },
    });

    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY + 40) + 24;
  }

  // 6. Footer — page count read only once the document is complete.
  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(
      `Welile Technologies · generated ${report.generated_at} · page ${page} of ${totalPages}`,
      pageWidth / 2,
      pageHeight - 20,
      { align: 'center' },
    );
  }

  const filename = `welile-dormant-agents-${report.as_of}-${report.silent_days}d.pdf`;
  doc.save(filename);
  void logDormantAgentsExport(filename);
}
