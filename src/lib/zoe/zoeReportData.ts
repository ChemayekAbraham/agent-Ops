/**
 * Pure report data extraction and normalization for Zoe (My Space Staff Assistant).
 *
 * Rules:
 *   - Uses ONLY the exact rows and summary figures Zoe returned in `reportPayload`
 *     (or an explicit markdown table in the assistant message).
 *   - Never recalculates, re-aggregates, or invents any figure on the client.
 *   - Enforces Welile regulatory terminology ("Rent Plan", "Supporter", "Returns")
 *     and formats money as "UGX 1,234".
 */
import { dayTime, ugx, num } from '@/lib/welileReportDocument';

export interface ZoeReportSummaryMetric {
  key: string;
  label: string;
  rawValue: string | number | boolean | null;
  formattedValue: string;
}

export interface ZoeReportSheet {
  name: string;
  headers: string[];
  keys: string[];
  rows: (string | number | null)[][];
  rawRows: Record<string, unknown>[];
}

export interface ZoeExportableReport {
  kind: 'table' | 'period_summary';
  title: string;
  subtitle: string;
  source: string;
  periodLabel: string;
  generatedAt: string;
  generatedBy: string;
  howCountedNote: string;
  headers: string[];
  keys: string[];
  rows: (string | number | null)[][];
  rawRows: Record<string, unknown>[];
  rowCount: number;
  summaryMetrics: ZoeReportSummaryMetric[];
  sheets: ZoeReportSheet[];
  filenameBase: string;
}

export interface ZoeExportableMessageInput {
  id?: string;
  role?: 'user' | 'assistant';
  content: string;
  outcome?: string | null;
  status?: string | null;
  source?: string | null;
  period?: string | null;
  reportPayload?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface ExtractZoeReportOptions {
  generatedBy?: string | null;
  generatedAt?: Date | string;
}

/**
 * Regulatory terminology guard:
 * Replaces any accidental prohibited terms with mandatory Welile terms:
 *   - "loan" / "loans" -> "Rent Plan" / "Rent Plans"
 *   - "lender" / "lenders" -> "Supporter" / "Supporters"
 *   - "ROI" / "interest" -> "Returns"
 */
export function sanitizeWelileTerms(input: string): string {
  if (!input) return '';
  return input
    .replace(/\bloans\b/gi, 'Rent Plans')
    .replace(/\bloan\b/gi, 'Rent Plan')
    .replace(/\blenders\b/gi, 'Supporters')
    .replace(/\blender\b/gi, 'Supporter')
    .replace(/\bROI\b/g, 'Returns')
    .replace(/\binterest\s+rate\b/gi, 'Returns rate')
    .replace(/\binterest\b/gi, 'Returns');
}

const TOOL_REPORT_TITLES: Record<string, { title: string; howCounted: string }> = {
  my_profile: {
    title: 'My Staff Profile & Enabled Roles',
    howCounted:
      'Read directly from your authenticated profile, staff profile record, and enabled user_roles.',
  },
  my_payslips: {
    title: 'My Payslips & Allowances Statement',
    howCounted:
      'Counted from paid payroll items and allowances recorded on your staff payroll profile for the selected period.',
  },
  my_attendance_and_leave: {
    title: 'My Attendance & Leave Summary',
    howCounted:
      'Counted from daily staff attendance clock-ins and submitted leave requests for your account in the selected period.',
  },
  my_tasks_and_tickets: {
    title: 'My Assigned Tasks & Helpdesk Tickets',
    howCounted:
      'Counted from staff tasks and helpdesk tickets assigned to or created by your account.',
  },
  my_requests_and_advances: {
    title: 'My Requisitions, Salary Advances & Expense Claims',
    howCounted:
      'Counted from staff requisitions, salary advances, and expense claims submitted by your account.',
  },
  my_call_history: {
    title: 'My Calling & Rent Plan Pipeline Report',
    howCounted:
      'Counted via official server RPC staff_calling_detailed_report unioning Tenant Calling Center, Landlord Calling Center, and Rent Plan pipeline calls.',
  },
  tenant_ops_overview: {
    title: 'Tenant Ops Executive Overview Report',
    howCounted:
      'Counted via official server RPC get_tenant_ops_overview over active, repaying, and pipeline Rent Plans.',
  },
  tenant_ops_pipeline_queues: {
    title: 'Tenant Ops Rent Plan Pipeline Queues',
    howCounted:
      'Counted via official server RPC get_tenant_ops_Rent_requests grouped by Rent Plan pipeline stage.',
  },
  tenant_ops_repayments: {
    title: 'Tenant Ops Repayments & Collection Rate Report',
    howCounted:
      'Counted via official server RPC get_tenant_ops_repayments comparing scheduled daily charges against posted collections.',
  },
  tenant_ops_Missed_today: {
    title: 'Tenants Who Missed Payment Today',
    howCounted:
      'Counted via official server RPC tenant_ops_no_payment_report for active Rent Plans with zero payment posted on the target Kampala day.',
  },
  tenant_ops_missed_today: {
    title: 'Tenants Who Missed Payment Today',
    howCounted:
      'Counted via official server RPC tenant_ops_no_payment_report for active Rent Plans with zero payment posted on the target Kampala day.',
  },
  tenant_ops_behaviour_segments: {
    title: 'Tenant Payment Behaviour Classification Report',
    howCounted:
      'Counted via official server RPC tenant_ops_classification_report grouping tenants by historical repayment consistency.',
  },
  tenant_ops_topup_eligibility: {
    title: 'Tenant Rent Plan Renewal & Top-Up Eligibility Report',
    howCounted:
      'Counted via official server RPC tenant_ops_topup_eligibility_report evaluating active tenants against renewal rules.',
  },
  tenant_ops_registration_control: {
    title: 'Tenant Registration & Verification Control Report',
    howCounted:
      'Counted via official server RPC tenant_ops_registration_control_report tracking incomplete and unverified tenant profiles.',
  },
  tenant_ops_calling_summary: {
    title: 'Tenant Ops Calling Center Daily & Weekly Summary',
    howCounted:
      'Counted via official server RPCs cc_daily_summary and cc_weekly_report across Tenant Ops calling logs.',
  },
  landlord_ops_pipeline: {
    title: 'Landlord Ops Verification Pipeline Report',
    howCounted:
      'Counted from rent_requests in Landlord Ops verification stages and landlord_ops_reviews.',
  },
  landlord_ops_assigned_houses: {
    title: 'Landlord Ops Listed Houses & Occupancy Report',
    howCounted:
      'Counted from house_listings across verification and occupancy statuses.',
  },
  landlord_ops_payouts: {
    title: 'Landlord Payouts & Disbursement Report',
    howCounted:
      'Counted from landlord_payout_events and disbursed Rent Plans in the selected period.',
  },
  landlord_ops_principal_comparison: {
    title: 'Landlord Float Allocations vs Principal Comparison',
    howCounted:
      'Counted via official server RPC get_landlord_principal_comparison comparing cumulative non-cancelled float allocations against non-reversed principal.',
  },
  landlord_ops_awareness_calls: {
    title: 'Landlord Awareness Calls & OTP Consent Report',
    howCounted:
      'Counted from append-only landlord_awareness_calls records in the selected period.',
  },
  landlord_ops_calling_reports: {
    title: 'Landlord Ops Calling Center Summary & Call Log',
    howCounted:
      'Counted via official server RPCs landlord_cc_daily_summary, landlord_cc_weekly_report, and landlord_cc_landlord_call_log.',
  },
  landlord_ops_concerns: {
    title: 'Landlord Ops Escalated Concerns & Dispute Report',
    howCounted:
      'Counted via official server RPC landlord_cc_concerns_report over flagged landlord calls.',
  },
  coo_overview: {
    title: 'COO Operations Snapshot & Rent Coverage Statement',
    howCounted:
      'Counted via official server RPCs get_coo_overview_snapshot and get_coo_rent_coverage_statement.',
  },
  coo_collections_vs_payouts: {
    title: 'Collections vs Payouts Comparison Report',
    howCounted:
      'Counted via official server RPCs get_cfo_overview_summary and get_cfo_wallet_reconciliation for the selected Kampala period.',
  },
  coo_pipeline_bottlenecks: {
    title: 'Rent Plan Pipeline Stage Bottlenecks & Stuck Requests',
    howCounted:
      'Counted from rent_requests grouped by stage age and pending_wallet_operations waiting queues.',
  },
  coo_missed_followups: {
    title: 'Overdue Vetting, Uncalled Queues & Missed Follow-Ups',
    howCounted:
      'Counted via official server RPCs cc_daily_summary and landlord_cc_daily_summary plus overdue vetting rent_requests.',
  },
  coo_staff_calling_performance: {
    title: 'Staff Calling & Rent Plan Pipeline Performance Report',
    howCounted:
      'Counted via official server RPC staff_calling_detailed_report across all Tenant and Landlord Calling Center and pipeline reviewers.',
  },
  ceo_health_and_growth: {
    title: 'CEO Company Health, Growth Quality & Rent Coverage Report',
    howCounted:
      'Counted via official server RPCs get_ceo_growth_quality, get_coo_rent_coverage_statement, and get_cfo_overview_summary.',
  },
  cfo_cash_position: {
    title: 'Treasury Cash Position Report',
    howCounted:
      'Counted exclusively via official server RPC get_treasury_cash_position across read-only ledger account totals.',
  },
  cfo_reconciliation_and_discrepancies: {
    title: 'Wallet & Ledger Reconciliation Report',
    howCounted:
      'Counted via official server RPCs get_cfo_wallet_reconciliation and check_ledger_integrity.',
  },
  cfo_pending_approvals: {
    title: 'CFO Pending Approvals, Withdrawals & Requisitions Queue',
    howCounted:
      'Counted via official server RPC get_cfo_overview_summary, pending_wallet_operations, withdrawal_requests, and staff_requisitions.',
  },
  cfo_receivables_and_payables: {
    title: 'Company Receivables & Payables Forecast Report',
    howCounted:
      'Counted via official server RPCs get_receivables_Analytics and get_payables_forecast (excluding agent lending and ineligible merchandise plans).',
  },
  cfo_commissions_and_deductions: {
    title: 'Agent Commissions & Recovery Deductions Report',
    howCounted:
      'Counted via official server RPC get_cfo_commission_payouts_summary and posted recovery ledger entries.',
  },
  cfo_budget_vs_actual: {
    title: 'Department Budget vs Actual & Supplements Report',
    howCounted:
      'Counted from budget_Revised_position (original approved lines plus CFO-approved budget_supplements) against disbursed actuals.',
  },
  partner_ops_overview: {
    title: 'Supporter Portfolios & Capital Summary Report',
    howCounted:
      'Counted via official server RPC get_partner_ops_overview over active and pending Supporter portfolios.',
  },
  partner_ops_due_returns: {
    title: 'Supporter Returns Payouts & Upcoming Due Dates Report',
    howCounted:
      'Counted from investor_portfolios due dates and supporter_roi_payments records in the selected window.',
  },
  partner_ops_withdrawals: {
    title: 'Supporter Capital Withdrawal Requests Report',
    howCounted:
      'Counted from partner_withdrawal_requests and withdrawal_requests for Supporter portfolios.',
  },
  agent_ops_float_and_advances: {
    title: 'Agent Float Balances & Active Advances Report',
    howCounted:
      'Counted via official server RPC get_agent_ops_float_summary and active agent_advances records.',
  },
  agent_ops_activity_and_rankings: {
    title: 'Agent Field Collections, Rankings & Dormancy Report',
    howCounted:
      'Counted via official server RPC agent_ops_report_rent_collections over field collection performance.',
  },
  agent_ops_sent_back_and_pending: {
    title: 'Sent-Back Rent Plans, Float Returns & Pending Verifications',
    howCounted:
      'Counted from sent-back rent_requests, agent_float_allocations, and pending agent verifications.',
  },
  agent_ops_schools_and_medicine: {
    title: 'Welile Schools & Welile Medicine Field Registrations Report',
    howCounted:
      'Counted from welile_school_profiles, welile_medical_profiles, and welile_medical_receipts in the selected period.',
  },
  hr_overview: {
    title: 'HR Staff Headcount, Attendance & Expiring Contracts Report',
    howCounted:
      'Counted from staff_profiles by department, daily staff_attendance, leave_requests, and contracts expiring within 30 days.',
  },
  hr_payroll_and_statutory: {
    title: 'HR Payroll Runs, Advances & TIN/NSSF Statutory Report',
    howCounted:
      'Counted from payroll_runs, salary_advances, and official server RPC cfo_statutory_consent_list.',
  },
};

const ROW_ARRAY_KEYS = [
  'rows',
  'payslips',
  'tasks',
  'tickets',
  'requisitions',
  'advances',
  'concerns',
  'orders',
  'detailed_rows',
  'expiring_contracts',
  'approved_requisitions',
  'agents',
  'waiting',
  'landlord_call_log',
  'weekly_all_calls_summary',
  'top_collectors',
  'by_department',
  'items',
  'records',
] as const;

const SUMMARY_OBJECT_KEYS = [
  'summary',
  'totals',
  'overview',
  'cash_position',
  'money_received',
  'money_paid_out',
  'receivables',
  'payables',
  'growth_quality',
  'rent_coverage_statement',
  'pending_portfolios',
  'comparison',
  'attendance',
  'leave',
  'schools',
  'medicine',
  'float_summary',
  'advances_summary',
  'reconciliation',
  'ledger_integrity',
  'commissions_summary',
  'deductions_and_recoveries',
  'statutory_tin_nssf',
  'payroll_runs',
  'salary_advances',
  'cfo_summary',
  'pending_wallet_operations',
  'withdrawal_requests',
  'daily_summary',
  'weekly_report',
  'tenant_calling_daily',
  'landlord_calling_daily',
  'overdue_vetting',
  'stuck_rent_plans',
  'waiting_wallet_ops',
  'data',
] as const;

const METADATA_KEYS = new Set([
  'tool',
  'rpc',
  'args',
  'source',
  'period',
  'row_count',
  'basis',
  'note',
  'how_counted',
  'generated_at',
  'email_draft',
]);

/**
 * Formats a snake_case or camelCase identifier into a clean Title Case header,
 * applying Welile regulatory terminology.
 */
export function formatZoeColumnHeader(key: string): string {
  const cleaned = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/g, 'ID')
    .replace(/\bUgx\b/gi, 'UGX')
    .replace(/\bTin\b/gi, 'TIN')
    .replace(/\bNssf\b/gi, 'NSSF')
    .replace(/\bLc1\b/gi, 'LC1')
    .replace(/\bOtp\b/gi, 'OTP')
    .replace(/\bCfo\b/gi, 'CFO')
    .replace(/\bCoo\b/gi, 'COO')
    .replace(/\bCeo\b/gi, 'CEO')
    .replace(/\bHr\b/gi, 'HR')
    .replace(/\bRoi\b/gi, 'Returns');
  return sanitizeWelileTerms(cleaned);
}

/**
 * Determines whether a column key or metric key represents a monetary UGX amount.
 */
export function isMoneyFieldKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (
    lower.endsWith('_count') ||
    lower === 'count' ||
    lower.startsWith('count_') ||
    lower.endsWith('_days') ||
    lower.endsWith('_id') ||
    lower.endsWith('_rate') ||
    lower.endsWith('_pct') ||
    lower.endsWith('_percent') ||
    lower.includes('phone') ||
    lower.includes('year') ||
    lower.includes('month') ||
    lower.includes('stage') ||
    lower.includes('status') ||
    lower.includes('number')
  ) {
    return false;
  }
  return (
    lower.includes('ugx') ||
    lower.includes('amount') ||
    lower.includes('balance') ||
    lower.includes('total_collected') ||
    lower.includes('collected_total') ||
    lower.includes('disbursed') ||
    lower.includes('principal') ||
    lower.includes('commission') ||
    lower.includes('salary') ||
    lower.includes('net_pay') ||
    lower.includes('gross_pay') ||
    lower.includes('allowance') ||
    lower.includes('deduction') ||
    lower.includes('receivable') ||
    lower.includes('payable') ||
    lower.includes('float') ||
    lower.includes('rent_approved') ||
    lower.includes('rent_funded') ||
    lower.includes('repayment_booked') ||
    lower.includes('recorded_repaid') ||
    lower.includes('outstanding') ||
    lower.includes('cash') ||
    lower.includes('budget') ||
    lower.includes('supplement') ||
    lower.includes('revised') ||
    lower.includes('actual') ||
    lower.includes('variance') ||
    lower.includes('capital') ||
    lower.includes('returns') ||
    lower.includes('roi') ||
    lower.includes('fee') ||
    lower.includes('surcharge') ||
    lower.includes('wallet')
  );
}

/**
 * Formats a cell value for human display in HTML/PDF while preserving Welile money formatting (`UGX 1,234`).
 */
export function formatZoeCellForDisplay(
  key: string,
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (isMoneyFieldKey(key)) {
      return ugx(value);
    }
    return num(value);
  }
  const str = String(value);
  return sanitizeWelileTerms(str);
}

/**
 * Converts an arbitrary row property into a primitive cell value (`string | number | null`)
 * without altering any string or number returned by Zoe.
 */
function toExactCellPrimitive(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeWelileTerms(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item ?? '')))
      .join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Builds a `ZoeReportSheet` from an array of plain row objects, preserving exact row order and cell values.
 */
export function buildSheetFromRowObjects(
  sheetName: string,
  rawObjects: Record<string, unknown>[],
): ZoeReportSheet {
  const keySet = new Set<string>();
  for (const row of rawObjects) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const k of Object.keys(row)) {
        keySet.add(k);
      }
    }
  }
  const keys = Array.from(keySet);
  const headers = keys.map(formatZoeColumnHeader);
  const rows = rawObjects.map((row) => keys.map((k) => toExactCellPrimitive(row[k])));

  return {
    name: sanitizeWelileTerms(sheetName).slice(0, 31) || 'Report Data',
    headers,
    keys,
    rows,
    rawRows: rawObjects,
  };
}

/**
 * Formats a Zoe `period` object or string into a readable dates label.
 */
export function formatZoePeriodLabel(
  period: unknown,
  fallbackPeriod?: string | null,
): string {
  if (typeof fallbackPeriod === 'string' && fallbackPeriod.trim()) {
    return fallbackPeriod.trim();
  }
  if (!period) return 'Current Period';
  if (typeof period === 'string') return period.trim() || 'Current Period';
  if (typeof period === 'object' && !Array.isArray(period)) {
    const p = period as Record<string, unknown>;
    if (typeof p.from === 'string' && typeof p.to === 'string') {
      return p.from === p.to ? p.from : `${p.from} to ${p.to}`;
    }
    if (typeof p.as_of === 'string') {
      return `as of ${p.as_of}`;
    }
    if (p.month && p.year) {
      return `${p.year}-${String(p.month).padStart(2, '0')}`;
    }
    if (p.year) {
      return `Year ${p.year}`;
    }
    if (typeof p.days_ahead === 'number') {
      return `Next ${p.days_ahead} days`;
    }
  }
  return 'Current Period';
}

/**
 * Flattens scalar summary properties from an object into `ZoeReportSummaryMetric[]`
 * without recalculating or altering any number.
 */
function collectSummaryMetricsFromObject(
  obj: Record<string, unknown>,
  prefix = '',
  out: ZoeReportSummaryMetric[] = [],
  depth = 0,
): ZoeReportSummaryMetric[] {
  if (depth > 2 || out.length >= 40) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (METADATA_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    const compositeKey = prefix ? `${prefix}_${k}` : k;
    const label = prefix
      ? `${formatZoeColumnHeader(prefix)} — ${formatZoeColumnHeader(k)}`
      : formatZoeColumnHeader(k);

    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      if (typeof v === 'string' && v.length > 140) continue;
      out.push({
        key: compositeKey,
        label,
        rawValue: typeof v === 'string' ? sanitizeWelileTerms(v) : v,
        formattedValue: formatZoeCellForDisplay(compositeKey, v),
      });
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      collectSummaryMetricsFromObject(v as Record<string, unknown>, compositeKey, out, depth + 1);
    }
  }
  return out;
}

/**
 * Fallback parser for Markdown pipe tables inside `message.content` when `reportPayload`
 * does not carry structured rows.
 */
export function parseMarkdownTableFromContent(content: string): ZoeReportSheet | null {
  if (!content || !content.includes('|')) return null;
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i];
    const dividerLine = lines[i + 1];
    if (
      headerLine.startsWith('|') &&
      headerLine.endsWith('|') &&
      /^\|[\s:|-]+\|$/.test(dividerLine) &&
      dividerLine.includes('-')
    ) {
      const headers = headerLine
        .slice(1, -1)
        .split('|')
        .map((c) => sanitizeWelileTerms(c.trim()));
      if (headers.length === 0 || headers.every((h) => !h)) continue;

      const keys = headers.map((h, idx) =>
        h
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '') || `col_${idx + 1}`,
      );

      const rawRows: Record<string, unknown>[] = [];
      const rows: (string | number | null)[][] = [];

      for (let j = i + 2; j < lines.length; j++) {
        const rowLine = lines[j];
        if (!rowLine.startsWith('|') || !rowLine.endsWith('|')) break;
        const cells = rowLine
          .slice(1, -1)
          .split('|')
          .map((c) => sanitizeWelileTerms(c.trim()));
        const rowObj: Record<string, unknown> = {};
        const rowArr: (string | number | null)[] = [];
        keys.forEach((k, colIdx) => {
          const cellVal = cells[colIdx] ?? '';
          rowObj[k] = cellVal;
          rowArr.push(cellVal);
        });
        rawRows.push(rowObj);
        rows.push(rowArr);
      }

      if (rows.length > 0) {
        return {
          name: 'Report Data',
          headers,
          keys,
          rows,
          rawRows,
        };
      }
    }
  }
  return null;
}

function normalizeToolKey(toolOrRpc?: string | null): string {
  if (!toolOrRpc) return '';
  return toolOrRpc.trim().replace(/^assistant_staff_/, '');
}

function resolveReportMeta(
  payload: Record<string, unknown> | null,
  messageSource?: string | null,
  periodLabel?: string,
): { title: string; subtitle: string; source: string; howCountedNote: string } {
  const toolName =
    (typeof payload?.tool === 'string' && payload.tool) ||
    (typeof payload?.rpc === 'string' && payload.rpc) ||
    '';
  const normalizedKey = normalizeToolKey(toolName);
  const catalogEntry = TOOL_REPORT_TITLES[normalizedKey] ?? TOOL_REPORT_TITLES[toolName];

  const rawSource =
    (typeof payload?.source === 'string' && payload.source.trim()) ||
    (typeof messageSource === 'string' && messageSource.trim()) ||
    (typeof payload?.rpc === 'string' && payload.rpc.trim()) ||
    'Official Welile Read-Only Report';

  const source = sanitizeWelileTerms(rawSource);

  let title = catalogEntry?.title ?? '';
  if (!title) {
    if (normalizedKey) {
      title = `${formatZoeColumnHeader(normalizedKey)} Report`;
    } else if (source && !source.includes('(') && source.length <= 60) {
      title = `${formatZoeColumnHeader(source)} Report`;
    } else {
      title = 'Zoe Staff Operations Report';
    }
  }
  title = sanitizeWelileTerms(title);

  const explicitBasis =
    (typeof payload?.basis === 'string' && payload.basis.trim()) ||
    (typeof payload?.how_counted === 'string' && payload.how_counted.trim()) ||
    (typeof payload?.note === 'string' && payload.note.trim()) ||
    '';

  const baseHowCounted =
    catalogEntry?.howCounted ||
    `Counted directly from official read-only server source (${source}) for ${periodLabel || 'the selected period'}.`;

  const howCountedNote = sanitizeWelileTerms(
    explicitBasis
      ? `${explicitBasis} (${baseHowCounted} Exported rows match the Zoe chat payload with zero client-side recalculation.)`
      : `${baseHowCounted} Exported rows match the Zoe chat payload with zero client-side recalculation.`,
  );

  return {
    title,
    subtitle: `Official Source: ${source}`,
    source,
    howCountedNote,
  };
}

/**
 * Extracts a canonical `ZoeExportableReport` from a Zoe assistant message whenever the
 * answer is a table or a period summary. Returns `null` for user messages, errors,
 * clarifications, or plain conversational responses without tabular/summary report data.
 */
export function extractZoeExportableReport(
  message: ZoeExportableMessageInput,
  options?: ExtractZoeReportOptions,
): ZoeExportableReport | null {
  if (!message) return null;
  if (message.role && message.role !== 'assistant') return null;
  const statusOrOutcome = message.outcome ?? message.status;
  const hasEmailDraft = Boolean(
    message.reportPayload &&
      typeof message.reportPayload === 'object' &&
      'email_draft' in message.reportPayload,
  );
  if (statusOrOutcome && statusOrOutcome !== 'answered' && !hasEmailDraft) return null;

  const payload =
    message.reportPayload && typeof message.reportPayload === 'object' && !Array.isArray(message.reportPayload)
      ? message.reportPayload
      : null;

  const sheets: ZoeReportSheet[] = [];

  if (payload) {
    // 1. Check all known row-array keys on payload
    for (const key of ROW_ARRAY_KEYS) {
      const candidate = payload[key];
      if (Array.isArray(candidate) && candidate.length > 0) {
        const validRows = candidate.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        );
        if (validRows.length > 0) {
          const sheetLabel = key === 'rows' ? 'Report Data' : formatZoeColumnHeader(key);
          sheets.push(buildSheetFromRowObjects(sheetLabel, validRows));
        }
      }
    }

    // 2. Check if `payload.data` is an array of row objects or contains row arrays
    if (Array.isArray(payload.data) && payload.data.length > 0) {
      const validRows = payload.data.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      );
      if (validRows.length > 0 && sheets.length === 0) {
        sheets.push(buildSheetFromRowObjects('Report Data', validRows));
      }
    } else if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      const nestedData = payload.data as Record<string, unknown>;
      for (const key of ROW_ARRAY_KEYS) {
        const candidate = nestedData[key];
        if (Array.isArray(candidate) && candidate.length > 0) {
          const validRows = candidate.filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          );
          if (validRows.length > 0) {
            const sheetLabel = key === 'rows' ? 'Report Data' : formatZoeColumnHeader(key);
            sheets.push(buildSheetFromRowObjects(sheetLabel, validRows));
          }
        }
      }
    }
  }

  // 3. Collect period summary metrics from summary objects or scalar fields
  const summaryMetrics: ZoeReportSummaryMetric[] = [];
  if (payload) {
    for (const key of SUMMARY_OBJECT_KEYS) {
      const val = payload[key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const prefix = key === 'summary' || key === 'totals' || key === 'overview' || key === 'data' ? '' : key;
        collectSummaryMetricsFromObject(val as Record<string, unknown>, prefix, summaryMetrics);
      }
    }

    // Also collect any direct scalar summary fields on payload itself
    for (const [k, v] of Object.entries(payload)) {
      if (METADATA_KEYS.has(k)) continue;
      if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 120)) {
        if (!summaryMetrics.some((m) => m.key === k)) {
          summaryMetrics.push({
            key: k,
            label: formatZoeColumnHeader(k),
            rawValue: typeof v === 'string' ? sanitizeWelileTerms(v) : v,
            formattedValue: formatZoeCellForDisplay(k, v),
          });
        }
      }
    }
  }

  // 4. Fallback: check if `message.content` contains a Markdown pipe table
  if (sheets.length === 0 && summaryMetrics.length === 0) {
    const mdSheet = parseMarkdownTableFromContent(message.content);
    if (mdSheet) {
      sheets.push(mdSheet);
    }
  }

  if (sheets.length === 0 && summaryMetrics.length === 0) {
    return null;
  }

  const periodLabel = formatZoePeriodLabel(payload?.period, message.period);
  const generatedDate =
    options?.generatedAt instanceof Date
      ? options.generatedAt
      : typeof options?.generatedAt === 'string' && options.generatedAt.trim()
        ? new Date(options.generatedAt)
        : new Date();
  const generatedAt = Number.isNaN(generatedDate.getTime())
    ? String(options?.generatedAt || '')
    : `${dayTime(generatedDate)} EAT`;

  const generatedBy =
    (typeof options?.generatedBy === 'string' && options.generatedBy.trim()) ||
    'Authenticated Staff Member';

  const { title, subtitle, source, howCountedNote } = resolveReportMeta(
    payload,
    message.source,
    periodLabel,
  );

  const dateSlug = Number.isNaN(generatedDate.getTime())
    ? 'report'
    : generatedDate.toISOString().slice(0, 10);
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  const filenameBase = `welile-zoe-${titleSlug || 'report'}-${dateSlug}`;

  // If we have table sheets, primary table is sheets[0]
  if (sheets.length > 0) {
    const primary = sheets[0];
    return {
      kind: 'table',
      title,
      subtitle,
      source,
      periodLabel,
      generatedAt,
      generatedBy,
      howCountedNote,
      headers: primary.headers,
      keys: primary.keys,
      rows: primary.rows,
      rawRows: primary.rawRows,
      rowCount: primary.rows.length,
      summaryMetrics,
      sheets,
      filenameBase,
    };
  }

  // Otherwise, this is a period summary report (`kind: 'period_summary'`)
  const summaryRawRows: Record<string, unknown>[] = summaryMetrics.map((m) => ({
    metric: m.label,
    value: m.rawValue,
  }));
  const summaryRows: (string | number | null)[][] = summaryMetrics.map((m) => [
    m.label,
    m.rawValue,
  ]);
  const summarySheet: ZoeReportSheet = {
    name: 'Period Summary',
    headers: ['Metric', 'Value'],
    keys: ['metric', 'value'],
    rows: summaryRows,
    rawRows: summaryRawRows,
  };

  return {
    kind: 'period_summary',
    title,
    subtitle,
    source,
    periodLabel,
    generatedAt,
    generatedBy,
    howCountedNote,
    headers: summarySheet.headers,
    keys: summarySheet.keys,
    rows: summarySheet.rows,
    rawRows: summarySheet.rawRows,
    rowCount: summarySheet.rows.length,
    summaryMetrics,
    sheets: [summarySheet],
    filenameBase,
  };
}
