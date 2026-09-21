import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsxWorkbook } from '@/lib/xlsxExport';
import type {
  RegistrationControlRow,
  RegistrationOverrideRecord,
} from '@/hooks/useAgentRegistrationControl';

const PRIMARY: [number, number, number] = [79, 70, 229];      // indigo-600
const PRIMARY_DARK: [number, number, number] = [55, 48, 163]; // indigo-800
const STRIPE: [number, number, number] = [239, 241, 254];

const fmtDateTime = (d: string | null) => (d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—');
const fmtDate = (d: string | null) => (d ? format(new Date(d), 'dd MMM yyyy') : '—');

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

/** An agent's on-screen status: mirrors the three badge states rendered in the Agents table. */
function statusOf(row: RegistrationControlRow): 'Blocked' | 'Override active' | 'Can register' {
  if (row.blocked) return 'Blocked';
  if (row.restricted && row.override_id) return 'Override active';
  return 'Can register';
}

function statusBreakdown(agents: RegistrationControlRow[]) {
  const total = agents.length;
  const counts: Record<'Blocked' | 'Override active' | 'Can register', number> = {
    Blocked: 0,
    'Override active': 0,
    'Can register': 0,
  };
  agents.forEach((a) => {
    counts[statusOf(a)] += 1;
  });
  return (['Blocked', 'Override active', 'Can register'] as const).map((label) => ({
    label,
    count: counts[label],
    pct: total === 0 ? 0 : Math.round((counts[label] / total) * 1000) / 10,
  }));
}

function overrideOutcome(o: RegistrationOverrideRecord) {
  if (o.revoked_at) return `Withdrawn ${fmtDate(o.revoked_at)}`;
  if (o.active) return `Allowed${o.expires_at ? ` until ${fmtDate(o.expires_at)}` : ''}`;
  return 'Ended';
}

function overrideWasState(o: RegistrationOverrideRecord) {
  return String((o.previous_state as { blocked?: unknown })?.blocked) === 'true'
    ? 'Blocked from registering'
    : 'Not blocked';
}

/**
 * Branded PDF report for the Agent Registration Control tab — copies the
 * header band / section() + table() recipe from `generateCfoWeeklyReportPdf`
 * (src/lib/cfoWeeklyReportPdf.ts) so every executive report in the app shares
 * the same look. Archives to the offline PDF vault and triggers a download.
 */
export async function generateRegistrationControlPdf(
  agents: RegistrationControlRow[],
  overrides: RegistrationOverrideRecord[],
  meta?: { generatedByUserId?: string },
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

  const total = agents.length;
  const breakdown = statusBreakdown(agents);
  const blockedCount = breakdown.find((b) => b.label === 'Blocked')?.count ?? 0;
  const blockedPct = total === 0 ? 0 : Math.round((blockedCount / total) * 1000) / 10;

  // ── Header band ──
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pw, 30, 'F');
  if (logo) { try { doc.addImage(logo, 'PNG', margin, 6, 17, 17); } catch { /* ignore */ } }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Agent Registration Control Report', logo ? margin + 21 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(new Date(), 'dd MMM yyyy, HH:mm')}`, logo ? margin + 21 : margin, 20);
  doc.setFontSize(8);
  doc.text(`${total} agent(s) reviewed · ${overrides.length} override(s) on record`, logo ? margin + 21 : margin, 25.5);

  let y = 38;
  doc.setTextColor(15, 23, 42);

  // ── Executive summary ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...PRIMARY_DARK);
  doc.text('Executive Summary', margin, y);
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.line(margin, y, pw - margin, y);
  y += 5;

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const summaryLines = doc.splitTextToSize(
    `${blockedCount} of ${total} reviewed agents (${blockedPct}%) are currently blocked from registering new tenants. ` +
      `${breakdown.find((b) => b.label === 'Override active')?.count ?? 0} agent(s) are registering under an active override, ` +
      `and ${breakdown.find((b) => b.label === 'Can register')?.count ?? 0} agent(s) meet the rule cleanly with no restriction.`,
    pw - margin * 2,
  );
  doc.text(summaryLines, margin, y);
  y += summaryLines.length * 4.4 + 4;

  const section = (title: string, startY: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...PRIMARY_DARK);
    doc.text(title, margin, startY);
    doc.setDrawColor(...PRIMARY);
    doc.line(margin, startY + 2, pw - margin, startY + 2);
    doc.setTextColor(15, 23, 42);
    return startY + 6;
  };

  const table = (head: string[][], body: (string | number)[][], startY: number, foot?: (string | number)[][]) => {
    autoTable(doc, {
      head, body, foot, startY,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      footStyles: { fillColor: STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    return ((doc as any).lastAutoTable?.finalY || startY) + 8;
  };

  // ── Status breakdown ──
  y = section('Status Breakdown', y);
  y = table(
    [['Status', 'Agent count', '% of total']],
    breakdown.map((b) => [b.label, b.count, `${b.pct}%`]),
    y,
    [['Total', total, '100%']],
  );

  // ── Agents detail ──
  y = section('Agents', y);
  if (y > 240) { doc.addPage(); y = 20; }
  autoTable(doc, {
    head: [['Agent', 'Phone', 'District', 'Active tenants', 'Last month due', 'Collected', 'Performance', 'Rule', 'Status']],
    body: agents.map((a) => [
      a.full_name ?? 'Unnamed agent',
      a.phone ?? '—',
      a.district ?? '—',
      a.active_tenants,
      formatUGX(Number(a.prev_expected)),
      formatUGX(Number(a.prev_collected)),
      a.prev_pct == null ? '—' : `${a.prev_pct}%`,
      a.group_label ? `${a.group_label} (needs ${a.group_required_pct}%)` : 'No rule applies',
      statusOf(a),
    ]),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7.5, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' },
    },
  });
  y = ((doc as any).lastAutoTable?.finalY || y) + 8;

  // ── Override audit trail ──
  if (y > 250) { doc.addPage(); y = 20; }
  y = section('Override Audit Trail', y);
  autoTable(doc, {
    head: [['When', 'Agent', 'Approved by', 'Reason', 'Was', 'Now']],
    body: overrides.map((o) => [
      fmtDateTime(o.created_at),
      o.agent_name ?? o.agent_id,
      o.approved_by_name ?? o.approved_by,
      o.reason,
      overrideWasState(o),
      overrideOutcome(o),
    ]),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7.5, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
  });
  y = ((doc as any).lastAutoTable?.finalY || y) + 6;

  if (overrides.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.setTextColor(120, 120, 120);
    doc.text('No overrides recorded yet.', margin, y);
  }

  // ── Footer ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — Tenant Operations Workspace', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pw - margin, ph - 6, { align: 'right' });
  }

  const filename = `agent-registration-control-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`;
  savePdfWithVault(doc, filename, {
    label: 'Agent Registration Control Report',
    category: 'tenant-ops',
    userId: meta?.generatedByUserId,
  });
}

/**
 * Excel export for the Agent Registration Control tab — reuses the existing
 * `downloadXlsxWorkbook` helper (src/lib/xlsxExport.ts), no bespoke Excel
 * writing here.
 */
export async function exportRegistrationControlXlsx(
  agents: RegistrationControlRow[],
  overrides: RegistrationOverrideRecord[],
): Promise<void> {
  const total = agents.length;
  const breakdown = statusBreakdown(agents);

  await downloadXlsxWorkbook(`agent-registration-control-${format(new Date(), 'yyyy-MM-dd-HHmm')}.xlsx`, [
    {
      name: 'Summary',
      headers: ['Status', 'Agent count', '% of total'],
      rows: [
        ...breakdown.map((b) => [b.label, b.count, `${b.pct}%`]),
        ['Total', total, '100%'],
      ],
    },
    {
      name: 'Agents',
      headers: [
        'Agent', 'Phone', 'District', 'Active tenants', 'Last month due', 'Collected',
        'Performance %', 'Rule', 'Required %', 'Status',
      ],
      rows: agents.map((a) => [
        a.full_name ?? 'Unnamed agent',
        a.phone ?? '',
        a.district ?? '',
        a.active_tenants,
        Number(a.prev_expected),
        Number(a.prev_collected),
        a.prev_pct == null ? '' : a.prev_pct,
        a.group_label ?? 'No rule applies',
        a.group_required_pct ?? '',
        statusOf(a),
      ]),
    },
    {
      name: 'Overrides',
      headers: ['When', 'Agent', 'Approved by', 'Reason', 'Was', 'Now'],
      rows: overrides.map((o) => [
        fmtDateTime(o.created_at),
        o.agent_name ?? o.agent_id,
        o.approved_by_name ?? o.approved_by,
        o.reason,
        overrideWasState(o),
        overrideOutcome(o),
      ]),
    },
  ]);
}
