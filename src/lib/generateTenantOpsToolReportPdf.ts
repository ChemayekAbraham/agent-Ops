import jsPDF from 'jspdf';
import { format } from 'date-fns';

/**
 * Audit-grade PDF reports for the existing Tenant Ops Tools.
 *
 * Layout, filter echo, cap note, KPI cards, breakdown table and detail table all
 * mirror the Landlord Ops house verification report
 * (`generateHouseVerificationReportPdf`). Only the DATA is tool-specific: every
 * row comes from the `ops_tenant_ops_tool_report` RPC for the tool being
 * exported, using the exact filters the user is looking at on screen.
 */

export type TenantOpsTool =
  | 'review_requests'
  | 'approval_history'
  | 'missed_days'
  | 'calls_made'
  | 'daily_payments'
  | 'tenant_behavior'
  | 'transfer_audit';

export type TenantOpsReportRow = Record<string, any>;

export interface TenantOpsReportMeta {
  tool: TenantOpsTool;
  /** Status / risk / method filter currently applied on screen. */
  status?: string | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** True DB match count — may exceed rows.length when the export is capped. */
  totalMatches?: number;
  generatedBy?: string | null;
}

type Align = 'left' | 'right';
type Kpi = { label: string; value: string };
type Col = { label: string; w: number; align?: Align; get: (r: TenantOpsReportRow) => string };

const ugx = (n: any) => `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;
const num = (n: any) => Math.round(Number(n || 0)).toLocaleString();
const txt = (s: any, fallback = '—') => {
  const v = (s ?? '').toString().trim();
  return v.length ? v : fallback;
};
const dt = (d: any, withTime = false) => {
  if (!d) return '—';
  try { return format(new Date(d), withTime ? 'dd MMM yyyy HH:mm' : 'dd MMM yyyy'); } catch { return '—'; }
};
const pretty = (s: any) => txt(s).replace(/_/g, ' ');
const sum = (rows: TenantOpsReportRow[], k: string) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
const distinct = (rows: TenantOpsReportRow[], k: string) =>
  new Set(rows.map(r => txt(r[k], '')).filter(Boolean)).size;

interface ToolConfig {
  title: string;
  dateBasis: string;
  accent: [number, number, number];
  statusLabel: string;
  kpis: (rows: TenantOpsReportRow[]) => Kpi[];
  /** Grouping table (the tenant-ops equivalent of the district breakdown). */
  breakdown: {
    heading: string;
    keyLabel: string;
    key: (r: TenantOpsReportRow) => string;
    metrics: { label: string; w: number; value: (rows: TenantOpsReportRow[]) => string }[];
  };
  columns: Col[];
}

const TOOL_CONFIG: Record<TenantOpsTool, ToolConfig> = {
  review_requests: {
    title: 'Rent Requests Awaiting Review',
    dateBasis: 'date the tenant rent request was submitted',
    accent: [217, 119, 6],
    statusLabel: 'Pipeline stage',
    kpis: rows => [
      { label: 'REQUESTS', value: num(rows.length) },
      { label: 'TENANTS', value: num(distinct(rows, 'tenant_name')) },
      { label: 'AGENTS', value: num(distinct(rows, 'agent_name')) },
      { label: 'RENT VALUE', value: ugx(sum(rows, 'rent_amount')) },
      { label: 'REPAYABLE', value: ugx(sum(rows, 'total_repayment')) },
      { label: 'DAILY DUE', value: ugx(sum(rows, 'daily_repayment')) },
      { label: 'WITH GPS', value: `${num(rows.filter(r => r.has_gps).length)} / ${num(rows.length)}` },
      { label: 'RESUBMITTED', value: num(rows.filter(r => Number(r.resubmission_count || 0) > 0).length) },
    ],
    breakdown: {
      heading: 'Stage breakdown',
      keyLabel: 'Pipeline stage',
      key: r => pretty(r.status),
      metrics: [
        { label: 'Requests', w: 24, value: rs => num(rs.length) },
        { label: 'Tenants', w: 24, value: rs => num(distinct(rs, 'tenant_name')) },
        { label: 'Rent (UGX)', w: 38, value: rs => num(sum(rs, 'rent_amount')) },
        { label: 'Daily due (UGX)', w: 38, value: rs => num(sum(rs, 'daily_repayment')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 40, get: r => txt(r.tenant_name) },
      { label: 'Phone', w: 24, get: r => txt(r.tenant_phone) },
      { label: 'Agent', w: 36, get: r => txt(r.agent_name) },
      { label: 'Stage', w: 30, get: r => pretty(r.status) },
      { label: 'Rent', w: 24, align: 'right', get: r => num(r.rent_amount) },
      { label: 'Repayable', w: 24, align: 'right', get: r => num(r.total_repayment) },
      { label: 'Daily', w: 20, align: 'right', get: r => num(r.daily_repayment) },
      { label: 'Days', w: 12, align: 'right', get: r => txt(r.duration_days) },
      { label: 'Category', w: 26, get: r => pretty(r.house_category) },
      { label: 'Town/City', w: 26, get: r => txt(r.request_city) },
      { label: 'GPS', w: 12, get: r => (r.has_gps ? 'Yes' : 'No') },
      { label: 'Submitted', w: 26, get: r => dt(r.created_at, true) },
    ],
  },

  approval_history: {
    title: 'Tenant Request Approval History',
    dateBasis: 'date the request last changed state in the approval pipeline',
    accent: [37, 99, 235],
    statusLabel: 'Status',
    kpis: rows => [
      { label: 'RECORDS', value: num(rows.length) },
      { label: 'TENANTS', value: num(distinct(rows, 'tenant_name')) },
      { label: 'REJECTED', value: num(rows.filter(r => r.status === 'rejected').length) },
      { label: 'FUNDED', value: num(rows.filter(r => r.status === 'funded').length) },
      { label: 'REPAYING', value: num(rows.filter(r => r.status === 'repaying').length) },
      { label: 'COMPLETED', value: num(rows.filter(r => r.status === 'completed').length) },
      { label: 'RENT VALUE', value: ugx(sum(rows, 'rent_amount')) },
      { label: 'REVIEWERS', value: num(distinct(rows, 'tenant_ops_by')) },
    ],
    breakdown: {
      heading: 'Decisions by status',
      keyLabel: 'Status',
      key: r => pretty(r.status),
      metrics: [
        { label: 'Records', w: 26, value: rs => num(rs.length) },
        { label: 'Tenants', w: 26, value: rs => num(distinct(rs, 'tenant_name')) },
        { label: 'Rent (UGX)', w: 40, value: rs => num(sum(rs, 'rent_amount')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 36, get: r => txt(r.tenant_name) },
      { label: 'Agent', w: 32, get: r => txt(r.agent_name) },
      { label: 'Status', w: 24, get: r => pretty(r.status) },
      { label: 'Rent', w: 22, align: 'right', get: r => num(r.rent_amount) },
      { label: 'Tenant Ops', w: 30, get: r => `${txt(r.tenant_ops_by, '—')}${r.tenant_ops_at ? ` · ${dt(r.tenant_ops_at)}` : ''}` },
      { label: 'Agent Ops', w: 30, get: r => `${txt(r.agent_ops_by, '—')}${r.agent_ops_at ? ` · ${dt(r.agent_ops_at)}` : ''}` },
      { label: 'Landlord Ops', w: 30, get: r => `${txt(r.landlord_ops_by, '—')}${r.landlord_ops_at ? ` · ${dt(r.landlord_ops_at)}` : ''}` },
      { label: 'COO', w: 26, get: r => `${txt(r.coo_by, '—')}${r.coo_at ? ` · ${dt(r.coo_at)}` : ''}` },
      { label: 'CFO', w: 26, get: r => `${txt(r.cfo_by, '—')}${r.cfo_at ? ` · ${dt(r.cfo_at)}` : ''}` },
      { label: 'Reason / note', w: 44, get: r => txt(r.rejected_reason || r.approval_comment) },
      { label: 'Last update', w: 24, get: r => dt(r.updated_at, true) },
    ],
  },

  missed_days: {
    title: 'Tenants Behind on Daily Payments',
    dateBasis: 'date the tenant rent plan was disbursed',
    accent: [220, 38, 38],
    statusLabel: 'Risk band',
    kpis: rows => [
      { label: 'PLANS', value: num(rows.length) },
      { label: 'TENANTS', value: num(distinct(rows, 'tenant_id')) },
      { label: 'CRITICAL (5+)', value: num(rows.filter(r => r.risk_level === 'critical').length) },
      { label: 'WARNING (2-4)', value: num(rows.filter(r => r.risk_level === 'warning').length) },
      { label: 'ON TRACK', value: num(rows.filter(r => r.risk_level === 'on_track').length) },
      { label: 'MISSED DAYS', value: num(sum(rows, 'missed_days')) },
      { label: 'OUTSTANDING', value: ugx(sum(rows, 'outstanding_balance')) },
      { label: 'DAILY EXPECTED', value: ugx(sum(rows, 'daily_repayment')) },
    ],
    breakdown: {
      heading: 'Exposure by agent',
      keyLabel: 'Agent',
      key: r => txt(r.agent_name, 'Unassigned'),
      metrics: [
        { label: 'Tenants', w: 22, value: rs => num(distinct(rs, 'tenant_id')) },
        { label: 'Missed days', w: 26, value: rs => num(sum(rs, 'missed_days')) },
        { label: 'Collected (UGX)', w: 36, value: rs => num(sum(rs, 'amount_repaid')) },
        { label: 'Outstanding (UGX)', w: 40, value: rs => num(sum(rs, 'outstanding_balance')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 38, get: r => txt(r.tenant_name) },
      { label: 'Phone', w: 24, get: r => txt(r.tenant_phone) },
      { label: 'Agent', w: 34, get: r => txt(r.agent_name) },
      { label: 'Risk', w: 18, get: r => pretty(r.risk_level) },
      { label: 'Missed', w: 16, align: 'right', get: r => num(r.missed_days) },
      { label: 'Days in', w: 16, align: 'right', get: r => num(r.days_since_disbursed) },
      { label: 'Daily', w: 20, align: 'right', get: r => num(r.daily_repayment) },
      { label: 'Expected', w: 24, align: 'right', get: r => num(r.expected_repaid) },
      { label: 'Repaid', w: 24, align: 'right', get: r => num(r.amount_repaid) },
      { label: 'Outstanding', w: 26, align: 'right', get: r => num(r.outstanding_balance) },
      { label: '%', w: 12, align: 'right', get: r => `${num(r.repayment_pct)}%` },
      { label: 'Last paid', w: 24, get: r => dt(r.last_payment_at) },
      { label: 'Calls', w: 14, align: 'right', get: r => num(r.call_count) },
      { label: 'Last call', w: 26, get: r => dt(r.last_call_at, true) },
      { label: 'Outcome', w: 22, get: r => pretty(r.last_call_outcome) },
      { label: 'Latest comment', w: 46, get: r => txt(r.latest_call_comment) },
    ],
  },

  calls_made: {
    title: 'Tenant Calls Made',
    dateBasis: 'date the tenant rent plan was disbursed (call history is all-time)',
    accent: [79, 70, 229],
    statusLabel: 'Risk band',
    kpis: rows => [
      { label: 'TENANTS CALLED', value: num(distinct(rows, 'tenant_id')) },
      { label: 'TOTAL CALLS', value: num(sum(rows, 'call_count')) },
      { label: 'PICKED UP', value: num(rows.filter(r => r.last_call_outcome === 'picked_up').length) },
      { label: 'STILL MISSED', value: num(rows.filter(r => r.last_call_outcome === 'missed').length) },
      { label: 'MISSED DAYS', value: num(sum(rows, 'missed_days')) },
      { label: 'OUTSTANDING', value: ugx(sum(rows, 'outstanding_balance')) },
      { label: 'DAILY EXPECTED', value: ugx(sum(rows, 'daily_repayment')) },
      { label: 'WITH COMMENT', value: num(rows.filter(r => txt(r.latest_call_comment, '') !== '').length) },
    ],
    breakdown: {
      heading: 'Calls by agent',
      keyLabel: 'Agent',
      key: r => txt(r.agent_name, 'Unassigned'),
      metrics: [
        { label: 'Tenants', w: 22, value: rs => num(distinct(rs, 'tenant_id')) },
        { label: 'Calls', w: 20, value: rs => num(sum(rs, 'call_count')) },
        { label: 'Missed days', w: 28, value: rs => num(sum(rs, 'missed_days')) },
        { label: 'Outstanding (UGX)', w: 40, value: rs => num(sum(rs, 'outstanding_balance')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 38, get: r => txt(r.tenant_name) },
      { label: 'Phone', w: 24, get: r => txt(r.tenant_phone) },
      { label: 'Agent', w: 32, get: r => txt(r.agent_name) },
      { label: 'Calls', w: 14, align: 'right', get: r => num(r.call_count) },
      { label: 'Last call', w: 26, get: r => dt(r.last_call_at, true) },
      { label: 'Outcome', w: 22, get: r => pretty(r.last_call_outcome) },
      { label: 'Missed', w: 16, align: 'right', get: r => num(r.missed_days) },
      { label: 'Daily', w: 20, align: 'right', get: r => num(r.daily_repayment) },
      { label: 'Outstanding', w: 26, align: 'right', get: r => num(r.outstanding_balance) },
      { label: 'Last paid', w: 24, get: r => dt(r.last_payment_at) },
      { label: 'Latest comment', w: 58, get: r => txt(r.latest_call_comment) },
    ],
  },

  daily_payments: {
    title: 'Tenant Daily Payment Collections',
    dateBasis: 'date and time the payment was recorded by the agent',
    accent: [16, 163, 74],
    statusLabel: 'Payment method',
    kpis: rows => [
      { label: 'PAYMENTS', value: num(rows.length) },
      { label: 'TENANTS PAID', value: num(distinct(rows, 'tenant_name')) },
      { label: 'AGENTS', value: num(distinct(rows, 'agent_name')) },
      { label: 'COLLECTED', value: ugx(sum(rows, 'amount')) },
      { label: 'AVG PAYMENT', value: ugx(rows.length ? sum(rows, 'amount') / rows.length : 0) },
      { label: 'CASH', value: num(rows.filter(r => String(r.payment_method).toLowerCase() === 'cash').length) },
      { label: 'MOBILE MONEY', value: num(rows.filter(r => String(r.payment_method).toLowerCase().includes('momo') || String(r.payment_method).toLowerCase().includes('mobile')).length) },
      { label: 'LINKED TO PLAN', value: `${num(rows.filter(r => r.rent_request_id).length)} / ${num(rows.length)}` },
    ],
    breakdown: {
      heading: 'Collections by agent',
      keyLabel: 'Agent',
      key: r => txt(r.agent_name, 'Unknown agent'),
      metrics: [
        { label: 'Payments', w: 24, value: rs => num(rs.length) },
        { label: 'Tenants', w: 24, value: rs => num(distinct(rs, 'tenant_name')) },
        { label: 'Collected (UGX)', w: 40, value: rs => num(sum(rs, 'amount')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 38, get: r => txt(r.tenant_name) },
      { label: 'Phone', w: 24, get: r => txt(r.tenant_phone) },
      { label: 'Agent', w: 36, get: r => txt(r.agent_name) },
      { label: 'Amount', w: 24, align: 'right', get: r => num(r.amount) },
      { label: 'Method', w: 22, get: r => pretty(r.payment_method) },
      { label: 'Provider', w: 20, get: r => pretty(r.momo_provider) },
      { label: 'Reference', w: 34, get: r => txt(r.momo_transaction_id || r.tracking_id) },
      { label: 'Location', w: 32, get: r => txt(r.location_name) },
      { label: 'Recorded', w: 28, get: r => dt(r.created_at, true) },
    ],
  },

  tenant_behavior: {
    title: 'Tenant Payment Behaviour',
    dateBasis: 'tenant lifetime record (first request to latest payment)',
    accent: [146, 52, 234],
    statusLabel: 'Risk segment',
    kpis: rows => [
      { label: 'TENANTS', value: num(rows.length) },
      { label: 'CRITICAL', value: num(rows.filter(r => String(r.risk_level).toLowerCase() === 'critical').length) },
      { label: 'WARNING', value: num(rows.filter(r => String(r.risk_level).toLowerCase() === 'warning').length) },
      { label: 'HEALTHY', value: num(rows.filter(r => String(r.risk_level).toLowerCase() === 'healthy').length) },
      { label: 'ACTIVE PLANS', value: num(sum(rows, 'active_requests')) },
      { label: 'RENT VALUE', value: ugx(sum(rows, 'total_rent_amount')) },
      { label: 'REPAID', value: ugx(sum(rows, 'total_repaid')) },
      { label: 'OVERDUE', value: ugx(sum(rows, 'current_overdue_amount')) },
    ],
    breakdown: {
      heading: 'Behaviour by risk segment',
      keyLabel: 'Risk segment',
      key: r => pretty(r.risk_level),
      metrics: [
        { label: 'Tenants', w: 24, value: rs => num(rs.length) },
        { label: 'Active plans', w: 28, value: rs => num(sum(rs, 'active_requests')) },
        { label: 'Repaid (UGX)', w: 36, value: rs => num(sum(rs, 'total_repaid')) },
        { label: 'Overdue (UGX)', w: 36, value: rs => num(sum(rs, 'current_overdue_amount')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 40, get: r => txt(r.tenant_name) },
      { label: 'Phone', w: 24, get: r => txt(r.tenant_phone) },
      { label: 'Risk', w: 18, get: r => pretty(r.risk_level) },
      { label: 'Score', w: 16, align: 'right', get: r => num(r.health_score) },
      { label: 'Plans', w: 16, align: 'right', get: r => num(r.total_requests) },
      { label: 'Active', w: 16, align: 'right', get: r => num(r.active_requests) },
      { label: 'Completed', w: 22, align: 'right', get: r => num(r.fully_repaid_count) },
      { label: 'Defaulted', w: 20, align: 'right', get: r => num(r.defaulted_count) },
      { label: 'Rent value', w: 26, align: 'right', get: r => num(r.total_rent_amount) },
      { label: 'Repaid', w: 24, align: 'right', get: r => num(r.total_repaid) },
      { label: '%', w: 12, align: 'right', get: r => `${num(r.repayment_pct)}%` },
      { label: 'Overdue', w: 24, align: 'right', get: r => num(r.current_overdue_amount) },
      { label: 'Last paid', w: 24, get: r => dt(r.last_payment_date) },
    ],
  },

  transfer_audit: {
    title: 'Tenant Transfer Audit Trail',
    dateBasis: 'date the tenant transfer was recorded',
    accent: [13, 148, 136],
    statusLabel: 'Flag',
    kpis: rows => [
      { label: 'TRANSFERS', value: num(rows.length) },
      { label: 'TENANTS', value: num(distinct(rows, 'tenant_name')) },
      { label: 'FROM AGENTS', value: num(distinct(rows, 'from_agent_name')) },
      { label: 'TO AGENTS', value: num(distinct(rows, 'to_agent_name')) },
      { label: 'FLAGGED', value: num(rows.filter(r => txt(r.flag_type, 'none') !== 'none').length) },
      { label: 'PLANS MOVED', value: num(sum(rows, 'rent_requests_updated')) },
      { label: 'SUBS MOVED', value: num(sum(rows, 'subscriptions_updated')) },
      { label: 'WITH GPS', value: `${num(rows.filter(r => r.has_gps).length)} / ${num(rows.length)}` },
    ],
    breakdown: {
      heading: 'Transfers by receiving agent',
      keyLabel: 'Receiving agent',
      key: r => txt(r.to_agent_name, 'Unknown agent'),
      metrics: [
        { label: 'Transfers', w: 26, value: rs => num(rs.length) },
        { label: 'Tenants', w: 26, value: rs => num(distinct(rs, 'tenant_name')) },
        { label: 'Flagged', w: 24, value: rs => num(rs.filter(r => txt(r.flag_type, 'none') !== 'none').length) },
        { label: 'Plans moved', w: 30, value: rs => num(sum(rs, 'rent_requests_updated')) },
      ],
    },
    columns: [
      { label: 'Tenant', w: 38, get: r => txt(r.tenant_name) },
      { label: 'Phone', w: 24, get: r => txt(r.tenant_phone) },
      { label: 'From agent', w: 36, get: r => txt(r.from_agent_name) },
      { label: 'To agent', w: 36, get: r => txt(r.to_agent_name) },
      { label: 'Actioned by', w: 32, get: r => txt(r.actor_name) },
      { label: 'Flag', w: 22, get: r => pretty(r.flag_type) },
      { label: 'Plans', w: 14, align: 'right', get: r => num(r.rent_requests_updated) },
      { label: 'Subs', w: 14, align: 'right', get: r => num(r.subscriptions_updated) },
      { label: 'Reason', w: 44, get: r => txt(r.reason) },
      { label: 'Recorded', w: 26, get: r => dt(r.created_at, true) },
    ],
  },
};

export const tenantOpsToolReportTitle = (tool: TenantOpsTool) => TOOL_CONFIG[tool].title;
export const tenantOpsToolStatusLabel = (tool: TenantOpsTool) => TOOL_CONFIG[tool].statusLabel;

export function generateTenantOpsToolReportPdf(
  rows: TenantOpsReportRow[],
  meta: TenantOpsReportMeta,
): Blob {
  const cfg = TOOL_CONFIG[meta.tool];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  const accent = cfg.accent;
  let y = 14;

  const bottomLimit = pageHeight - 12;
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const ensure = (needed: number, onNewPage?: () => void) => {
    if (y + needed > bottomLimit) { doc.addPage(); y = 14; onNewPage?.(); }
  };

  // ─── Header ───
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.setTextColor(15, 23, 42);
  doc.text(`Tenant Operations — ${cfg.title}`, margin, y);

  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.text(`Dates in this report use the ${cfg.dateBasis}.`, margin, y);

  y += 4.2;
  const filterBits: string[] = [
    `Period: ${meta.dateFrom ? dt(meta.dateFrom) : 'All time'} → ${meta.dateTo ? dt(meta.dateTo) : 'Today'}`,
    `${cfg.statusLabel}: ${!meta.status || meta.status === 'all' ? 'All' : pretty(meta.status)}`,
  ];
  if (meta.search) filterBits.push(`Search: "${meta.search}"`);
  if (meta.generatedBy) filterBits.push(`Prepared by: ${meta.generatedBy}`);
  doc.setFont('helvetica', 'italic');
  doc.text(filterBits.join('   •   '), margin, y);

  if (typeof meta.totalMatches === 'number' && meta.totalMatches > rows.length) {
    y += 4.2;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38);
    doc.text(
      `Note: ${meta.totalMatches.toLocaleString()} records match these filters; this export lists the ${rows.length.toLocaleString()} most recent. Narrow the date range for a complete set.`,
      margin, y,
    );
    doc.setTextColor(110, 110, 120);
  }

  y += 4;
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  const sectionHeading = (label: string, size = 10) => {
    ensure(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
    doc.text(label, margin, y);
    y += 4;
  };

  // ─── KPI cards ───
  const cards = cfg.kpis(rows);
  ensure(22);
  const cardGap = 2.5;
  const cardW = (contentWidth - cardGap * (cards.length - 1)) / cards.length;
  const cardH = 16;
  cards.forEach((c, i) => {
    const x = margin + i * (cardW + cardGap);
    doc.setFillColor(248, 249, 252);
    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(120, 122, 135);
    doc.text(c.label, x + 3, y + 5.5);
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(clip(c.value, 18), x + 3, y + 12);
  });
  y += cardH + 6;

  // ─── Breakdown table ───
  const groups = new Map<string, TenantOpsReportRow[]>();
  rows.forEach(r => {
    const k = cfg.breakdown.key(r);
    const cur = groups.get(k) || [];
    cur.push(r);
    groups.set(k, cur);
  });
  const groupRows = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);

  if (groupRows.length) {
    sectionHeading(cfg.breakdown.heading);
    const bCols = [
      { label: cfg.breakdown.keyLabel, w: 58, align: 'left' as Align },
      ...cfg.breakdown.metrics.map(m => ({ label: m.label, w: m.w, align: 'right' as Align })),
    ];
    const bWidth = bCols.reduce((s, c) => s + c.w, 0);
    const bHead = () => {
      doc.setFillColor(...accent);
      doc.rect(margin, y, bWidth, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      let x = margin;
      bCols.forEach(c => {
        doc.text(c.label, c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 4, { align: c.align });
        x += c.w;
      });
      y += 6;
    };
    bHead();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    groupRows.slice(0, 25).forEach(([name, groupSet], i) => {
      ensure(6, bHead);
      if (i % 2 === 1) {
        doc.setFillColor(248, 249, 252);
        doc.rect(margin, y, bWidth, 5.2, 'F');
      }
      doc.setTextColor(30, 35, 50);
      let x = margin;
      const vals = [clip(name, 32), ...cfg.breakdown.metrics.map(m => m.value(groupSet))];
      bCols.forEach((c, ci) => {
        doc.text(vals[ci], c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 3.7, { align: c.align });
        x += c.w;
      });
      y += 5.2;
    });
    if (groupRows.length > 25) {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(120, 122, 135);
      doc.text(`+ ${groupRows.length - 25} more groups (full detail in the record list below)`, margin, y + 3.5);
      y += 5.2;
    }
    y += 6;
  }

  // ─── Detail table ───
  sectionHeading(`Records (${rows.length.toLocaleString()})`);
  const cols = cfg.columns;
  const scale = contentWidth / cols.reduce((s, c) => s + c.w, 0);
  const widths = cols.map(c => c.w * scale);
  const drawHead = () => {
    doc.setFillColor(...accent);
    doc.rect(margin, y, contentWidth, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    let x = margin;
    cols.forEach((c, i) => {
      const align = c.align || 'left';
      doc.text(c.label, align === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + 4, { align });
      x += widths[i];
    });
    y += 6;
  };
  drawHead();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  rows.forEach((r, ri) => {
    ensure(5.6, drawHead);
    if (ri % 2 === 1) {
      doc.setFillColor(248, 249, 252);
      doc.rect(margin, y, contentWidth, 5, 'F');
    }
    doc.setTextColor(30, 35, 50);
    let x = margin;
    cols.forEach((c, i) => {
      const align = c.align || 'left';
      const maxChars = Math.max(4, Math.floor(widths[i] / 1.4));
      doc.text(clip(c.get(r), maxChars), align === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + 3.5, { align });
      x += widths[i];
    });
    y += 5;
  });

  // ─── Footer page numbers ───
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140, 142, 155);
    doc.text(
      `Welile — Tenant Operations · ${cfg.title} · generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`,
      margin, pageHeight - 6,
    );
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  return doc.output('blob');
}
