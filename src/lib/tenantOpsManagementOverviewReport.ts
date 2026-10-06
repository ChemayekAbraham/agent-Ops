/**
 * Reporting for the Tenant Operations "Management Overview" tab — the
 * flagship combined report of the workspace.
 *
 * Renders only figures already produced by `useTenantOpsManagementOverview`
 * (itself a read-only roll-up of `get_tenant_topup_eligibility` and
 * `get_agent_registration_control`). No eligibility, arrears, cycle or
 * performance figure is recomputed here — this file only formats, sums and
 * counts what it is handed.
 */
import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { TOPUP_TIER_LABELS } from '@/hooks/useTenantTopupEligibility';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsxWorkbook, type XlsxSheet } from '@/lib/xlsxExport';
import type {
  ManagementTenantRow,
  ManagementAgentRow,
} from '@/hooks/useTenantOpsManagementOverview';

const PRIMARY: [number, number, number] = [79, 70, 229]; // indigo-600
const PRIMARY_DARK: [number, number, number] = [55, 48, 163]; // indigo-800
const STRIPE: [number, number, number] = [239, 241, 254];

const CYCLE_LABELS: Record<string, string> = {
  in_cycle: 'Still inside the cycle',
  within_one_month: 'Up to a month past the cycle',
  within_two_months: 'One to two months past the cycle',
  beyond_two_months: 'Over two months past the cycle',
  completed: 'Fully paid',
};

const fmtUGX = (n: number | null | undefined) => formatUGX(Number(n ?? 0));
const pctOf = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

function registrationStatusLabel(a: ManagementAgentRow): string {
  if (a.blocked) return 'Cannot register';
  if (a.override_active) return 'Allowed by override';
  if (a.restricted) return 'Watch — below required level';
  return 'Can register';
}

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

// ---- Shared row/column builders (used by both the PDF and the Excel export) ----

const TENANT_HEADERS = [
  'Tenant',
  'Phone',
  'Agent',
  'Initial rent',
  'Current rent',
  'Total expected (full cycle)',
  'Total collected (all time)',
  'Outstanding (whole plan)',
  'Paid % (all time)',
  'Left % (all time)',
  'Arrears to date',
  'Cycle position',
  'Eligibility',
  'Can access',
  'Needed for next level',
  'Actions',
];

function tenantDetailRows(tenants: ManagementTenantRow[]): (string | number)[][] {
  return tenants.map((t) => {
    const nextLevel = t.levels?.find((l) => !l.reached && l.amount_required > 0);
    return [
      t.tenant_name ?? 'Unnamed tenant',
      t.tenant_phone ?? '—',
      t.agent_name ?? '—',
      t.initial_rent == null ? '—' : fmtUGX(t.initial_rent),
      fmtUGX(Number(t.rent_amount)),
      fmtUGX(Number(t.total_amount)),
      fmtUGX(Number(t.amount_repaid)),
      fmtUGX(Number(t.outstanding)),
      `${Math.round(t.pct_covered ?? 0)}%`,
      `${Math.round(t.pct_remaining)}%`,
      t.arrears > 0 ? fmtUGX(t.arrears) : '—',
      `${CYCLE_LABELS[t.cycle_status] ?? t.cycle_status}${
        t.cycle_status === 'in_cycle' && t.days_left_in_cycle > 0
          ? ` (${t.days_left_in_cycle}d left)`
          : ''
      }`,
      TOPUP_TIER_LABELS[t.tier_key] ?? t.tier_key,
      fmtUGX(Number(t.max_accessible_rent ?? 0)),
      nextLevel
        ? `${fmtUGX(nextLevel.amount_required)} for up to ${fmtUGX(nextLevel.max_accessible_rent)}`
        : '—',
      '—',
    ];
  });
}

const AGENT_HEADERS = [
  'Agent',
  'Active tenants',
  'Total expected (full cycle)',
  'Total collected (all time)',
  'Portfolio % (all time)',
  'Average tenant % (all time)',
  'Arrears to date',
  'Last month %',
  'Last month detail',
  'Registration standing',
  'Actions',
];

function agentDetailRows(agents: ManagementAgentRow[]): (string | number)[][] {
  return agents.map((a) => [
    a.agent_name ?? a.agent_id,
    a.active_tenants,
    fmtUGX(a.total_expected),
    fmtUGX(a.total_collected),
    `${a.portfolio_pct}%`,
    `${a.avg_pct_covered}%`,
    a.total_arrears > 0 ? fmtUGX(a.total_arrears) : '—',
    a.prev_month_pct == null ? '—' : `${a.prev_month_pct}%`,
    a.prev_month_expected > 0
      ? `${fmtUGX(a.prev_month_collected)} of ${fmtUGX(a.prev_month_expected)}`
      : 'Nothing was due last month',
    registrationStatusLabel(a),
    '—',
  ]);
}

interface OverviewTotals {
  totalTenants: number;
  totalAgents: number;
  totalExpected: number;
  totalPaid: number;
  totalOutstanding: number;
  totalArrears: number;
  eligibleCount: number;
  pctEligible: number;
  blockedAgents: number;
  restrictedAgents: number;
  pctBlocked: number;
  tierRows: { label: string; count: number; pct: number }[];
  registrationRows: { label: string; count: number; pct: number }[];
}

function computeTotals(tenants: ManagementTenantRow[], agents: ManagementAgentRow[]): OverviewTotals {
  const totalTenants = tenants.length;
  const totalAgents = agents.length;
  const totalExpected = tenants.reduce((s, t) => s + Number(t.total_amount ?? 0), 0);
  const totalPaid = tenants.reduce((s, t) => s + Number(t.amount_repaid ?? 0), 0);
  const totalOutstanding = tenants.reduce((s, t) => s + Number(t.outstanding ?? 0), 0);
  const totalArrears = tenants.reduce((s, t) => s + Number(t.arrears ?? 0), 0);
  const eligibleCount = tenants.filter((t) => t.eligible).length;
  const blockedAgents = agents.filter((a) => a.blocked).length;
  const restrictedAgents = agents.filter((a) => a.restricted && !a.blocked).length;

  const tierRows = Object.entries(TOPUP_TIER_LABELS).map(([key, label]) => {
    const count = tenants.filter((t) => t.tier_key === key).length;
    return { label, count, pct: pctOf(count, totalTenants) };
  });

  const registrationRows = [
    { label: 'Can register', count: agents.filter((a) => !a.blocked).length, pct: pctOf(agents.filter((a) => !a.blocked).length, totalAgents) },
    { label: 'Blocked', count: blockedAgents, pct: pctOf(blockedAgents, totalAgents) },
    { label: 'Restricted / watch', count: restrictedAgents, pct: pctOf(restrictedAgents, totalAgents) },
  ];

  return {
    totalTenants,
    totalAgents,
    totalExpected,
    totalPaid,
    totalOutstanding,
    totalArrears,
    eligibleCount,
    pctEligible: pctOf(eligibleCount, totalTenants),
    blockedAgents,
    restrictedAgents,
    pctBlocked: pctOf(blockedAgents, totalAgents),
    tierRows,
    registrationRows,
  };
}

// ---- PDF ----

export async function generateManagementOverviewPdf(
  tenants: ManagementTenantRow[],
  agents: ManagementAgentRow[],
  meta?: { generatedByUserId?: string },
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();
  const now = new Date();
  const totals = computeTotals(tenants, agents);

  // ── Header band ──
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pw, 26, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 5, 15, 15); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Tenant Operations Management Overview', logo ? margin + 19 : margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(now, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 19 : margin, 18);
  doc.setFontSize(8);
  doc.text(
    `${totals.totalTenants.toLocaleString()} tenants · ${totals.totalAgents.toLocaleString()} agents in view`,
    logo ? margin + 19 : margin,
    23,
  );

  let y = 34;
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
    [
      `This report covers ${totals.totalTenants.toLocaleString()} tenants across ${totals.totalAgents.toLocaleString()} agents — the same figures as the top-up eligibility and registration control reports.`,
      `Total expected across the book over the full cycles is ${fmtUGX(totals.totalExpected)}, of which ${fmtUGX(totals.totalPaid)} has been collected all time and ${fmtUGX(totals.totalOutstanding)} remains outstanding. These are all-time figures, not for a date range.`,
      `${fmtUGX(totals.totalArrears)} is in arrears to date (counted from each plan's start).`,
      `${totals.eligibleCount.toLocaleString()} tenants (${totals.pctEligible}%) are eligible for a top-up under the current rules.`,
      `${totals.blockedAgents.toLocaleString()} agents (${totals.pctBlocked}%) cannot currently register new tenants, and ${totals.restrictedAgents.toLocaleString()} are restricted / on watch.`,
    ].join(' '),
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

  const table = (head: string[][], body: (string | number)[][], startY: number, opts?: Record<string, unknown>) => {
    autoTable(doc, {
      head,
      body,
      startY,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: STRIPE },
      ...opts,
    });
    return ((doc as any).lastAutoTable?.finalY || startY) + 8;
  };

  // ── Tier / status breakdown ──
  y = section('Tenant Eligibility Breakdown', y);
  y = table(
    [['Eligibility tier', 'Tenants', '% of total']],
    totals.tierRows.map((r) => [r.label, String(r.count), `${r.pct}%`]),
    y,
    { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } } },
  );

  y = section('Agent Registration Standing', y);
  y = table(
    [['Status', 'Agents', '% of total']],
    totals.registrationRows.map((r) => [r.label, String(r.count), `${r.pct}%`]),
    y,
    { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } } },
  );

  // ── Full tenants detail table ──
  doc.addPage('a4', 'landscape');
  y = section('Tenant Detail — Full Book', 16);
  autoTable(doc, {
    head: [TENANT_HEADERS],
    body: tenantDetailRows(tenants),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 6.5, cellPadding: 1.3, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 6.5, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' },
      9: { halign: 'right' }, 10: { halign: 'right' }, 13: { halign: 'right' },
    },
  });

  // ── Full agents detail table ──
  doc.addPage('a4', 'landscape');
  y = section('Agent Detail — Full Book', 16);
  autoTable(doc, {
    head: [AGENT_HEADERS],
    body: agentDetailRows(agents),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7, cellPadding: 1.6, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 7, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' },
      7: { halign: 'right' },
    },
  });

  // ── Footer on every page ──
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

  const filename = `Welile_Tenant_Ops_Management_Overview_${format(now, 'yyyyMMdd_HHmm')}.pdf`;
  savePdfWithVault(doc, filename, {
    label: 'Tenant Operations Management Overview',
    category: 'tenant-ops',
    userId: meta?.generatedByUserId,
  });
}

// ---- Excel ----

export async function exportManagementOverviewXlsx(
  tenants: ManagementTenantRow[],
  agents: ManagementAgentRow[],
): Promise<void> {
  const now = new Date();
  const totals = computeTotals(tenants, agents);

  const reportInfoSheet: XlsxSheet = {
    name: 'Report Info',
    headers: ['Field', 'Value'],
    rows: [
      ['Report', 'Tenant Operations Management Overview'],
      ['Generated', format(now, 'yyyy-MM-dd HH:mm:ss')],
      ['Scope', 'Full book — every tenant and agent in memory, independent of the on-screen filters'],
      ['Tenants included', totals.totalTenants],
      ['Agents included', totals.totalAgents],
    ],
  };

  const summarySheet: XlsxSheet = {
    name: 'Summary',
    headers: ['Section', 'Item', 'Count', '% of total'],
    rows: [
      ['Totals', 'Total expected (full cycle)', fmtUGX(totals.totalExpected), ''],
      ['Totals', 'Total collected (all time)', fmtUGX(totals.totalPaid), ''],
      ['Totals', 'Outstanding (whole plan)', fmtUGX(totals.totalOutstanding), ''],
      ['Totals', 'Arrears to date', fmtUGX(totals.totalArrears), ''],
      ['Totals', 'Tenants eligible for top-up', totals.eligibleCount, `${totals.pctEligible}%`],
      ...totals.tierRows.map((r) => ['Tenant eligibility tier', r.label, r.count, `${r.pct}%`] as (string | number)[]),
      ...totals.registrationRows.map((r) => ['Agent registration standing', r.label, r.count, `${r.pct}%`] as (string | number)[]),
    ],
  };

  const tenantsSheet: XlsxSheet = {
    name: 'Tenants',
    headers: TENANT_HEADERS,
    rows: tenantDetailRows(tenants),
  };

  const agentsSheet: XlsxSheet = {
    name: 'Agents',
    headers: AGENT_HEADERS,
    rows: agentDetailRows(agents),
  };

  await downloadXlsxWorkbook(
    `Welile_Tenant_Ops_Management_Overview_${format(now, 'yyyyMMdd_HHmm')}.xlsx`,
    [reportInfoSheet, summarySheet, tenantsSheet, agentsSheet],
  );
}
