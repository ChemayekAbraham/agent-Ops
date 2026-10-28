/**
 * Shared report data extraction, column ranking, verified summary lines,
 * totals calculation, and file-request detection for Zoe (My Space Staff Assistant).
 *
 * Prompt 1 rules enforced here:
 *   1. No unrequested files: `extractZoeExportableReport` extracts ONLY structured
 *      tabular row arrays (`kind: 'table'`) from `report_payload` — it never builds
 *      `period_summary` reports out of loose scalar fields or markdown tables.
 *   2. A file is created only when the user explicitly asks ("give me an Excel",
 *      "PDF please", etc.) or taps an offer chip (`isZoeFileRequested` / `evaluateZoeFileRequest`).
 *   3. Internal ID columns (`id`, `*_id`, `uuid`, or UUID-valued columns) are hidden.
 *   4. PDF tables select at most 8 columns by importance (`selectImportantColumnsForPdf`).
 *   5. Totals rows and 3–5 line written summaries are deterministically verified against
 *      the exact figures in the report.
 *   6. Mandatory Welile regulatory terminology: "Rent Plan", "Supporter", "Returns",
 *      and "UGX 1,234" money formatting.
 */

export type ZoeReportCell = string | number | boolean | null;

export type ZoeReportKind = 'table' | 'period_summary';

export interface ZoeReportSheet {
  name: string;
  headers: string[];
  keys: string[];
  rows: ZoeReportCell[][];
  rawRows: Record<string, unknown>[];
  totalsRow?: ZoeReportCell[] | null;
}

export interface ZoeReportSummaryMetric {
  key: string;
  label: string;
  rawValue: ZoeReportCell;
  formattedValue: string;
}

export interface ZoeExportableReport {
  kind: ZoeReportKind;
  title: string;
  subtitle: string;
  question: string;
  periodLabel: string;
  generatedAt: string;
  generatedBy: string;
  source: string;
  howCountedNote: string;
  /** Human-formatted column headers (`Tenant Name`, `Overdue Amount`, etc.) */
  headers: string[];
  /** Raw column keys matching `rawRows` keys (`tenant_name`, `overdue_ugx`, etc.) */
  columns: string[];
  /** Alias for `columns` preserved for backward compatibility */
  keys: string[];
  /** Internal ID column keys that were hidden from `columns` (`tenant_id`, `id`, etc.) */
  hiddenColumns: string[];
  /** Exact cell values in the same order as `columns` */
  rows: ZoeReportCell[][];
  /** Verbatim row objects from Zoe's answer payload */
  rawRows: Record<string, unknown>[];
  rowCount: number;
  /** Named table sheets built from `rows` */
  sheets: ZoeReportSheet[];
  /** Summary metrics when applicable */
  summaryMetrics: ZoeReportSummaryMetric[];
  /** Optional totals row summing numeric/money columns where applicable */
  totalsRow: ZoeReportCell[] | null;
  /** 3 to 5 plain-language summary lines verified against the report's numbers */
  summaryLines: string[];
  /** Up to 8 importance-ranked column keys for PDF page width */
  pdfColumns: string[];
  /** Human headers corresponding to `pdfColumns` */
  pdfHeaders: string[];
  /** Cell rows corresponding to `pdfColumns` */
  pdfRows: ZoeReportCell[][];
  /** Totals row corresponding to `pdfColumns` */
  pdfTotalsRow: ZoeReportCell[] | null;
  /** Number of columns omitted from the PDF (included in full in the .xlsx export) */
  omittedPdfColumns: number;
  filenameBase: string;
}

export interface ZoeExportSourceMessage {
  id?: string;
  role?: 'user' | 'assistant';
  content: string;
  status?: string;
  outcome?: string | null;
  source?: string | null;
  source_label?: string | null;
  period?: string | null;
  period_label?: string | null;
  reportPayload?: Record<string, unknown> | null;
  report_payload?: Record<string, unknown> | null;
  createdAt?: Date | string;
  created_at?: string;
  userQuestion?: string;
}

export type ZoeExportableMessageInput = ZoeExportSourceMessage;

export interface ZoeExtractReportOptions {
  generatedBy?: string | null;
  generatedAt?: Date | string;
  userQuestion?: string;
}

export type ExtractZoeReportOptions = ZoeExtractReportOptions;

export interface ZoeFileRequestIntent {
  requested: boolean;
  format: 'xlsx' | 'pdf' | 'both' | null;
}

export interface ZoeFileDecision {
  report: ZoeExportableReport | null;
  fileCreated: boolean;
  requestedFormat: 'xlsx' | 'pdf' | 'both' | null;
  offerChipsShown: boolean;
}

const BANNED_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bloans\b/gi, 'Rent Plans'],
  [/\bloan\b/gi, 'Rent Plan'],
  [/\blenders\b/gi, 'Supporters'],
  [/\blender\b/gi, 'Supporter'],
  [/\bROI\b/gi, 'Returns'],
  [/\binterests\b/gi, 'Returns'],
  [/\binterest\b/gi, 'Returns'],
];

/**
 * Enforces Welile regulatory terminology on any human-facing label or note.
 */
export function sanitizeWelileTerms(text: string): string {
  if (!text) return '';
  let out = text;
  for (const [pattern, replacement] of BANNED_TERM_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Formats a numeric amount as `"UGX 1,234"` (rounded to whole shillings, comma-grouped).
 */
export function formatZoeUgx(value: number): string {
  if (!Number.isFinite(value)) return 'UGX 0';
  const rounded = Math.round(value);
  if (rounded < 0) {
    return `-UGX ${Math.abs(rounded).toLocaleString('en-US')}`;
  }
  return `UGX ${rounded.toLocaleString('en-US')}`;
}

/**
 * Formats a Date or ISO string into a readable Africa/Kampala timestamp:
 * e.g. `"26 Oct 2026, 14:05 EAT"`.
 */
export function formatZoeKampalaTimestamp(input?: Date | string): string {
  const date =
    input instanceof Date
      ? input
      : typeof input === 'string' && input.trim()
        ? new Date(input)
        : new Date();

  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;

  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Kampala',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${formatter.format(validDate)} EAT`;
  } catch {
    return `${validDate.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

/**
 * Normalizes a period string or period object from `report_payload` into a clean display label.
 */
export function formatZoePeriodLabel(
  period: unknown,
  fallbackPeriod?: string | null,
): string {
  if (typeof period === 'string' && period.trim()) {
    return sanitizeWelileTerms(period.trim());
  }
  if (period && typeof period === 'object') {
    const p = period as Record<string, unknown>;
    const from = typeof p.from === 'string' ? p.from.trim() : '';
    const to = typeof p.to === 'string' ? p.to.trim() : '';
    if (from && to) {
      return from === to ? from : `${from} to ${to}`;
    }
    if (typeof p.as_of === 'string' && p.as_of.trim()) {
      return `as of ${p.as_of.trim()}`;
    }
    if (typeof p.service_date === 'string' && p.service_date.trim()) {
      return p.service_date.trim();
    }
    if (typeof p.anchor === 'string' && p.anchor.trim()) {
      return `week of ${p.anchor.trim()}`;
    }
    if (typeof p.week_start === 'string' && p.week_start.trim()) {
      return `week starting ${p.week_start.trim()}`;
    }
    if (typeof p.label === 'string' && p.label.trim()) {
      return sanitizeWelileTerms(p.label.trim());
    }
  }
  if (typeof fallbackPeriod === 'string' && fallbackPeriod.trim()) {
    return sanitizeWelileTerms(fallbackPeriod.trim());
  }
  return 'Current period (Africa/Kampala)';
}

const MONEY_KEY_PATTERNS =
  /(?:^|_)(?:ugx|amount|amt|balance|total_ugx|rent|fee|fees|commission|bonus|principal|arrears|overdue_ugx|expected|collected|disbursed|payout|payable|receivable|float|withdrawable|locked|advance|salary|gross|net|deduction|deductions|cost|price|spend|budget|supplement|revised|expenditure|remaining|shortfall|uncollected|outstanding|repaid|funded|paid_amount|due_amount|returns|topup|withdrawal|cash)(?:_|$)/i;

const NON_MONEY_KEY_PATTERNS =
  /(?:^|_)(?:count|cnt|pct|percent|percentage|rate|ratio|days|hours|minutes|mins|rank|score|index|id|uuid|phone|tel|mobile|number|code|status|stage|bucket|tier|name|title|email|role|date|time|at|from|to|month|year|week|day|note|reason|source|type|kind|category|region|district|enabled|active|verified|is_|has_|can_|total_row_count|row_count|plans_count|item_count|collection_count|payout_count|landlords_paid|calls|payers|started|missed|paid|part|not_due|future)(?:_|$)/i;

/**
 * Determines whether a column key represents a UGX money figure.
 */
export function isMoneyColumn(columnKey: string): boolean {
  const key = columnKey.trim().toLowerCase();
  if (!key) return false;
  if (key.endsWith('_ugx') || key === 'ugx') return true;
  if (NON_MONEY_KEY_PATTERNS.test(key) && !key.endsWith('_amount') && !key.endsWith('_ugx')) {
    return false;
  }
  return MONEY_KEY_PATTERNS.test(key);
}

export const isMoneyFieldKey = isMoneyColumn;

/**
 * Determines whether a column key represents a count or percentage rather than money.
 */
export function isCountOrRateColumn(columnKey: string): boolean {
  const key = columnKey.trim().toLowerCase();
  return /(?:^|_)(?:count|cnt|pct|percent|percentage|rate|ratio|days|hours|minutes|rank|score|calls|plans|payers|started|items|tenants|landlords|agents)(?:_|$)/i.test(
    key,
  );
}

const ISO_DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Determines whether a column key or its values represent dates/timestamps.
 */
export function isDateColumn(columnKey: string, sampleValues?: ZoeReportCell[]): boolean {
  const key = columnKey.trim().toLowerCase();
  if (/(?:^|_)(?:date|as_at|as_of|from|to|period_start|period_end|called_at|created_at|updated_at|due_at|paid_at|disbursed_at|remind_at|started_at)(?:_|$)/i.test(key)) {
    return true;
  }
  if (sampleValues && sampleValues.length > 0) {
    const nonNull = sampleValues.filter((v) => v !== null && v !== '');
    if (
      nonNull.length > 0 &&
      nonNull.every((v) => typeof v === 'string' && ISO_DATE_VALUE_RE.test(v.trim()))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether a column contains numeric values (money, counts, rates).
 */
export function isNumericColumn(columnKey: string, sampleValues?: ZoeReportCell[]): boolean {
  if (isMoneyColumn(columnKey) || isCountOrRateColumn(columnKey)) {
    return true;
  }
  if (sampleValues && sampleValues.length > 0) {
    const nonNull = sampleValues.filter((v) => v !== null && v !== '');
    if (nonNull.length > 0 && nonNull.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return true;
    }
  }
  return false;
}

/**
 * Infers the OpenXML column format type (`money`, `integer`, `decimal`, `date`, or `text`)
 * for a given column in `.xlsx` exports.
 */
export function getZoeColumnXlsxType(
  columnKey: string,
  rows: ReadonlyArray<ReadonlyArray<ZoeReportCell>>,
  colIdx: number,
): 'money' | 'integer' | 'decimal' | 'date' | 'text' {
  const sampleValues = rows.map((r) => r[colIdx] ?? null);
  if (isMoneyColumn(columnKey)) return 'money';
  if (isDateColumn(columnKey, sampleValues)) return 'date';
  const numericValues = sampleValues.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (numericValues.length > 0) {
    return numericValues.every((v) => Number.isInteger(v)) ? 'integer' : 'decimal';
  }
  return 'text';
}

const INTERNAL_ID_COLUMN_RE =
  /^(?:id|uuid|.*_id|.*_uuid|user_id|staff_id|agent_id|tenant_id|landlord_id|supporter_id|partner_id|rr_id|rent_request_id|person_id|caller_id|contract_id|department_id|submission_id|line_id|conversation_id|message_id|draft_id|prompt_id|requisition_id)$/i;

const UUID_VALUE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true when a column is an internal database ID or UUID column that should be hidden
 * from human-facing Excel and PDF tables.
 */
export function isInternalIdColumn(
  columnKey: string,
  rows?: ReadonlyArray<Record<string, unknown>>,
): boolean {
  const key = columnKey.trim();
  if (!key) return true;
  if (INTERNAL_ID_COLUMN_RE.test(key)) return true;

  if (rows && rows.length > 0) {
    const values = rows
      .map((r) => r[columnKey])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    if (
      values.length > 0 &&
      values.every((v) => typeof v === 'string' && UUID_VALUE_RE.test(v.trim()))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Formats a cell value for display in HTML/PDF tables while keeping non-money counts intact
 * and formatting money columns as `"UGX 1,234"`.
 */
export function formatZoeCellForDisplay(
  value: ZoeReportCell,
  columnKey: string,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (isMoneyColumn(columnKey)) {
      return formatZoeUgx(value);
    }
    const key = columnKey.trim().toLowerCase();
    if (key.endsWith('_pct') || key.endsWith('_percent') || key.endsWith('_rate')) {
      const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
      return `${formatted}%`;
    }
    if (Number.isInteger(value)) {
      return value.toLocaleString('en-US');
    }
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  const str = String(value).trim();
  if (ISO_DATE_VALUE_RE.test(str) && str.length >= 10) {
    // Keep clean YYYY-MM-DD or YYYY-MM-DD HH:MM for dates
    if (str.length === 10) return str;
    return str.slice(0, 16).replace('T', ' ');
  }
  return sanitizeWelileTerms(str);
}

const HEADER_ACRONYMS: Record<string, string> = {
  ugx: 'UGX',
  id: 'ID',
  lc1: 'LC1',
  nin: 'NIN',
  tin: 'TIN',
  nssf: 'NSSF',
  cfo: 'CFO',
  coo: 'COO',
  ceo: 'CEO',
  cto: 'CTO',
  hr: 'HR',
  crm: 'CRM',
  pso: 'PSO',
  kyc: 'KYC',
  mfa: 'MFA',
  sms: 'SMS',
  otp: 'OTP',
  pct: '%',
};

/**
 * Turns a snake_case or camelCase column key into a clean Title Case header.
 */
export function formatZoeColumnHeader(columnKey: string): string {
  const cleaned = sanitizeWelileTerms(
    columnKey
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[_\s-]+/g, ' ')
      .trim(),
  );
  if (!cleaned) return 'Value';

  return cleaned
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase();
      if (HEADER_ACRONYMS[lower]) return HEADER_ACRONYMS[lower];
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

const KNOWN_TOOL_TITLES: Record<string, string> = {
  my_profile: 'My Space Staff Profile',
  my_tasks_and_tickets: 'My Tasks & Support Tickets',
  my_tasks: 'My Tasks & Support Tickets',
  my_payslips: 'My Payslips Summary',
  my_requisitions: 'My Staff Requisitions',
  my_advances: 'My Salary Advances & Ledger',
  my_concerns: 'My Pipeline & Calling Concerns',
  my_canteen: 'My Canteen Orders',
  my_wallet: 'My Wallet Balances',
  my_calls: 'My Calling Log & Summary',
  tenant_ops_overview: 'Tenant Ops Executive Overview',
  tenant_ops_first7: 'First 7 Days Rent Plan Performance',
  tops_first_seven_summary: 'First 7 Days Rent Plan Performance',
  tenant_ops_arrears_ageing: 'Tenant Ops Arrears Ageing Report',
  tops_arrears_ageing: 'Tenant Ops Arrears Ageing Report',
  tenant_ops_uncovered_plans: 'Rent Plans Waiting for Landlord Payout',
  tops_landlord_not_paid: 'Rent Plans Waiting for Landlord Payout',
  tenant_ops_repayments: 'Tenant Ops Repayments & Collection Rate Report',
  tops_repayment_breakdown: 'Tenant Ops Repayments & Collection Rate Report',
  tenant_ops_calling_summary: 'Tenant Calling Center Summary',
  tops_calling_summary: 'Tenant Calling Center Summary',
  landlord_ops_overview: 'Landlord Ops Workspace Overview',
  lops_home_range: 'Landlord Ops Workspace Overview',
  landlord_ops_paid_lists: 'Landlord Ops Paid & Repaying Lists',
  lops_paid_lists: 'Landlord Ops Paid & Repaying Lists',
  lops_paid_and_repaying: 'Landlord Ops Paid & Repaying Rent Plans Report',
  lops_paid_and_repaying_summary: 'Landlord Ops Paid & Repaying Rent Plans Report',
  landlord_ops_principal_comparison: 'Landlord Principal vs Float Allocation Report',
  lops_principal_comparison: 'Landlord Principal vs Float Allocation Report',
  landlord_ops_calling_summary: 'Landlord Calling Center Summary',
  lops_calling_summary: 'Landlord Calling Center Summary',
  agent_ops_overview: 'Agent Ops Network Overview',
  aops_network_overview: 'Agent Ops Network Overview',
  agent_ops_metrics: 'Agent Ops Listing & Advance Metrics',
  aops_metrics_totals: 'Agent Ops Listing & Advance Metrics',
  aops_metrics_agents: 'Agent Ops Per-Agent Performance Report',
  agent_ops_silent_collectors: 'Agent Ops Silent Collectors Report',
  aops_silent_collectors: 'Agent Ops Silent Collectors Report',
  partner_ops_overview: 'Partner Ops Supporter Portfolio Report',
  pops_report_overview: 'Partner Ops Supporter Portfolio Report',
  partner_ops_pso_performance: 'Partner Success Officer (PSO) Performance Report',
  pso_cohort_performance: 'Partner Success Officer (PSO) Performance Report',
  cfo_cash_position: 'Treasury Cash Position Report',
  cfo_treasury_cash_position: 'Treasury Cash Position Report',
  cfo_receivables_payables: 'Company Receivables & Payables Report',
  cfo_receivables_and_payables: 'Company Receivables & Payables Report',
  cfo_seven_day_expenses: 'CFO 7-Day Platform Expenses Report',
  cfo_budget_position: 'CFO Revised Budget Position Report',
  cfo_budget_revised_position: 'CFO Revised Budget Position Report',
  coo_command_center: 'COO Command Center & Rent Coverage Report',
  coo_overview: 'COO Command Center & Rent Coverage Report',
  ceo_growth_quality: 'CEO Growth Quality & Executive Report',
  ceo_growth_and_approvals: 'CEO Growth Quality & Executive Report',
  hr_calling_detailed_report: 'Staff Calling & Pipeline Feedback Report',
  hr_contracts_expiring: 'HR Expiring Contracts & Birthdays Report',
  hr_contracts_and_birthdays: 'HR Expiring Contracts & Birthdays Report',
  hr_payroll_cost_by_department: 'HR Payroll Cost by Department Report',
};

/**
 * Produces a clean human-readable report title from a tool/RPC name or source label.
 */
export function humanizeZoeReportTitle(
  toolOrSource?: string | null,
  fallbackKind: ZoeReportKind = 'table',
): string {
  if (!toolOrSource || !toolOrSource.trim()) {
    return fallbackKind === 'table'
      ? 'Welile Staff Operations Report'
      : 'Welile Period Summary Report';
  }
  const raw = toolOrSource.trim();
  const normalizedKey = raw
    .replace(/^public\./i, '')
    .replace(/^assistant_staff_/i, '')
    .replace(/^get_/i, '')
    .toLowerCase();

  if (KNOWN_TOOL_TITLES[normalizedKey]) {
    return KNOWN_TOOL_TITLES[normalizedKey];
  }

  return sanitizeWelileTerms(
    normalizedKey
      .split(/[_\s+]+/)
      .filter(Boolean)
      .map((part) => {
        const lower = part.toLowerCase();
        if (HEADER_ACRONYMS[lower]) return HEADER_ACRONYMS[lower];
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(' ') + ' Report',
  );
}

/**
 * Builds the "How this was counted" provenance note from the payload's `source`, `rpc`, and `basis`.
 */
export function buildZoeHowCountedNote(
  payload: Record<string, unknown> | null | undefined,
  fallbackSource?: string | null,
): string {
  const source =
    (typeof payload?.source === 'string' && payload.source.trim()) ||
    (typeof fallbackSource === 'string' && fallbackSource.trim()) ||
    (typeof payload?.rpc === 'string' && payload.rpc.trim()) ||
    (typeof payload?.tool === 'string' && payload.tool.trim()) ||
    'Verified Welile read-only reporting RPC';

  const basis =
    (typeof payload?.basis === 'string' && payload.basis.trim()) ||
    (typeof payload?.note === 'string' && payload.note.trim()) ||
    (typeof (payload?.data as Record<string, unknown> | undefined)?.basis === 'string' &&
      String((payload?.data as Record<string, unknown>).basis).trim()) ||
    '';

  const baseNote = `Figures come verbatim from ${source} (Africa/Kampala timezone, read-only server calculation).`;
  return sanitizeWelileTerms(basis ? `${baseNote} ${basis}` : baseNote);
}

/**
 * Guarantees that any Excel download filename ends with `.xlsx` (adds `.xlsx` if missing,
 * or replaces a trailing `.xls` with `.xlsx`).
 */
export function ensureXlsxFilename(filename: string): string {
  const trimmed = (filename || 'welile-zoe-report').trim();
  if (/\.xlsx$/i.test(trimmed)) {
    return trimmed.replace(/\.xlsx$/i, '.xlsx');
  }
  if (/\.xls$/i.test(trimmed)) {
    return trimmed.replace(/\.xls$/i, '.xlsx');
  }
  return `${trimmed.replace(/\.+$/, '')}.xlsx`;
}

/**
 * Builds a clean, safe filename for PDF or `.xlsx` downloads.
 */
export function buildZoeReportFilename(
  toolOrTitle: string,
  periodLabel: string,
  extension: 'pdf' | 'xlsx',
): string {
  const slugTitle = toolOrTitle
    .toLowerCase()
    .replace(/^assistant_staff_/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);

  const dateMatch = periodLabel.match(/\d{4}-\d{2}-\d{2}/);
  const datePart = dateMatch ? dateMatch[0] : new Date().toISOString().slice(0, 10);
  const base = `welile-zoe-${slugTitle || 'report'}-${datePart}`;
  if (extension === 'xlsx') {
    return ensureXlsxFilename(`${base}.xlsx`);
  }
  return `${base}.pdf`;
}

const MAX_PDF_COLUMNS = 8;

function scoreColumnImportance(colKey: string, idx: number): number {
  const k = colKey.trim().toLowerCase();
  // Highest priority: primary entity / label / bucket / stage / staff / tenant / landlord name
  if (
    /^(?:name|full_name|staff_name|tenant_name|landlord_name|agent_name|supporter_name|person_name|title|bucket|stage|department|category|label|day|plan_ref|code)$/.test(
      k,
    )
  ) {
    return 100 - Math.min(idx, 10);
  }
  // High priority: primary totals, amounts, and counts
  if (
    /(?:^|_)(?:total|arrears_ugx|overdue_ugx|rent_amount|collected|expected|uncollected|outstanding|amount|balance|principal|returns|total_calls|answered_calls|unanswered_calls|count|plans|payers)(?:_|$)/.test(
      k,
    )
  ) {
    return 85 - Math.min(idx, 15);
  }
  // Medium-high priority: status, outcome, role, source, percentages, dates
  if (
    /(?:^|_)(?:status|outcome|answered|role|source|pct|percent|rate|called_at|date|as_of|from|to|due_at)(?:_|$)/.test(
      k,
    )
  ) {
    return 70 - Math.min(idx, 15);
  }
  // Medium priority: phone, location, frequency, feedback
  if (/(?:^|_)(?:phone|person_phone|tenant_phone|landlord_phone|district|region|frequency|feedback|note)(?:_|$)/.test(k)) {
    return 55 - Math.min(idx, 15);
  }
  return 40 - Math.min(idx, 20);
}

/**
 * Selects up to `maxCols` (default 8) most important columns for PDF page width,
 * preserving their original left-to-right relative column order.
 */
export function selectImportantColumnsForPdf(
  columns: readonly string[],
  maxCols: number = MAX_PDF_COLUMNS,
): { selectedColumns: string[]; selectedIndices: number[]; omittedCount: number } {
  if (columns.length <= maxCols) {
    return {
      selectedColumns: [...columns],
      selectedIndices: columns.map((_, i) => i),
      omittedCount: 0,
    };
  }

  const scored = columns.map((col, idx) => ({
    col,
    idx,
    score: scoreColumnImportance(col, idx),
  }));

  const topIndices = scored
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, maxCols)
    .map((item) => item.idx)
    .sort((a, b) => a - b);

  return {
    selectedColumns: topIndices.map((i) => columns[i]),
    selectedIndices: topIndices,
    omittedCount: columns.length - topIndices.length,
  };
}

const NON_SUMMABLE_COLUMN_RE =
  /(?:^|_)(?:pct|percent|percentage|rate|ratio|avg|average|mean|median|min|max|day|week|month|year|rank|score|index|phone|tel|mobile|date|at|from|to|id|uuid|code|status|stage|bucket|name|title|role|source|note|feedback|frequency)(?:_|$)/i;

/**
 * Computes a Totals row across `rows` when the table has `>= 2` rows and at least one
 * summable money or count column.
 */
export function computeZoeReportTotalsRow(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<ZoeReportCell>>,
): ZoeReportCell[] | null {
  if (rows.length < 2 || columns.length === 0) return null;

  let hasSummableColumn = false;
  const totals: ZoeReportCell[] = columns.map((col, colIdx) => {
    const key = col.trim().toLowerCase();
    if (colIdx === 0 && !isMoneyColumn(col) && !NON_SUMMABLE_COLUMN_RE.test(key)) {
      return 'Total';
    }
    if (NON_SUMMABLE_COLUMN_RE.test(key) && !isMoneyColumn(col)) {
      return colIdx === 0 ? 'Total' : null;
    }

    const numericVals: number[] = [];
    for (const r of rows) {
      const cell = r[colIdx];
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        numericVals.push(cell);
      } else if (cell !== null && cell !== undefined && cell !== '') {
        // Non-numeric value in this column -> do not sum
        return colIdx === 0 ? 'Total' : null;
      }
    }

    if (numericVals.length === 0) {
      return colIdx === 0 ? 'Total' : null;
    }

    if (isMoneyColumn(col) || /(?:^|_)(?:count|cnt|total|calls|plans|payers|started|missed|paid|part|items)(?:_|$)/i.test(key)) {
      hasSummableColumn = true;
      const sum = numericVals.reduce((acc, v) => acc + v, 0);
      return Number.isInteger(sum) ? sum : Math.round(sum * 100) / 100;
    }

    return colIdx === 0 ? 'Total' : null;
  });

  if (!hasSummableColumn) return null;
  if (totals[0] === null) totals[0] = 'Total';
  return totals;
}

/**
 * Verifies that every numeric token in `candidateLine` appears in the report's allowed number pool
 * (built from `rows`, `totalsRow`, `rowCount`, `periodLabel`, and `chatContent`).
 */
export function verifySummaryNumbersAgainstReport(
  candidateLine: string,
  allowedNumbers: ReadonlySet<number>,
  periodLabel: string,
): boolean {
  const scrubbed = candidateLine
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:01|02|03|04|05|06|07|08|09|10|11|12|13|14|15|16|17|18|19|20|21|22|23):\d{2}\b/g, ' ')
    .replace(/\+?256\s*7[•*xX\d\s-]{6,14}\b/g, ' ')
    .replace(/\b(?:1[-_]7|8[-_]14|15[-_]30|31[-_]60|61[-_]90|90_plus|30\+)\b/gi, ' ')
    .replace(/\bfirst\s+7\s+days\b/gi, ' ')
    .replace(/\b(?:week|wk)[-_\s]?\d+\b/gi, ' ')
    .replace(/\bday\s+[1-7]\b/gi, ' ');

  const matches = scrubbed.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g);
  for (const m of matches) {
    const n = Number(m[0].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (n >= 2020 && n <= 2035 && periodLabel.includes(String(n))) continue;
    if (
      !allowedNumbers.has(n) &&
      !allowedNumbers.has(Math.round(n)) &&
      !allowedNumbers.has(Number(n.toFixed(1))) &&
      !allowedNumbers.has(Number(n.toFixed(2)))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Produces 3 to 5 clean written summary lines for the PDF report header section.
 * Uses Zoe's verified reply sentences (passed through `verifySummaryNumbersAgainstReport`)
 * plus factual period/row/total lines derived directly from the report data.
 */
export function buildVerifiedSummaryLines(args: {
  chatContent: string;
  title: string;
  periodLabel: string;
  source: string;
  rowCount: number;
  columns: readonly string[];
  headers: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<ZoeReportCell>>;
  totalsRow: ReadonlyArray<ZoeReportCell> | null;
}): string[] {
  const allowedNumbers = new Set<number>([0, 1, args.rowCount, args.rows.length, args.columns.length]);
  const addNum = (n: number) => {
    if (!Number.isFinite(n)) return;
    allowedNumbers.add(n);
    allowedNumbers.add(Math.round(n));
    allowedNumbers.add(Number(n.toFixed(1)));
    allowedNumbers.add(Number(n.toFixed(2)));
  };

  for (const row of args.rows) {
    for (const cell of row) {
      if (typeof cell === 'number') addNum(cell);
      else if (typeof cell === 'string') {
        for (const m of cell.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g)) {
          addNum(Number(m[0].replace(/,/g, '')));
        }
      }
    }
  }
  if (args.totalsRow) {
    for (const cell of args.totalsRow) {
      if (typeof cell === 'number') addNum(cell);
    }
  }
  for (const m of args.chatContent.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g)) {
    addNum(Number(m[0].replace(/,/g, '')));
  }

  const lines: string[] = [];

  // Extract clean prose lines from Zoe's reply (excluding markdown table rows, Source lines, and file offer lines)
  const rawParagraphs = sanitizeWelileTerms(args.chatContent || '')
    .split(/\n+/)
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*•]\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim(),
    )
    .filter(
      (l) =>
        l.length >= 12 &&
        !l.startsWith('|') &&
        !/^source:\s*/i.test(l) &&
        !/would you like.*\b(?:excel|pdf)\b/i.test(l),
    );

  for (const para of rawParagraphs) {
    if (lines.length >= 3) break;
    if (verifySummaryNumbersAgainstReport(para, allowedNumbers, args.periodLabel)) {
      lines.push(para);
    }
  }

  // Add factual Scope & Coverage line if needed
  const scopeLine = `Scope: ${args.title} covering ${args.periodLabel} (${args.rowCount.toLocaleString('en-US')} ${args.rowCount === 1 ? 'record' : 'records'} from ${args.source}).`;
  if (lines.length < 5 && !lines.some((l) => l.includes(args.periodLabel))) {
    lines.push(scopeLine);
  }

  // Add factual Totals summary line from `totalsRow` if present
  if (args.totalsRow && lines.length < 5) {
    const totalParts: string[] = [];
    args.columns.forEach((col, idx) => {
      const val = args.totalsRow![idx];
      if (typeof val === 'number' && Number.isFinite(val) && totalParts.length < 4) {
        totalParts.push(`${args.headers[idx]}: ${formatZoeCellForDisplay(val, col)}`);
      }
    });
    if (totalParts.length > 0) {
      lines.push(`Verified column totals — ${totalParts.join(' | ')}.`);
    }
  }

  // Guarantee between 3 and 5 lines
  if (lines.length < 3) {
    const firstRowPreview: string[] = [];
    if (args.rows.length > 0) {
      args.columns.slice(0, 3).forEach((col, idx) => {
        const val = args.rows[0][idx];
        if (val !== null && val !== undefined && val !== '') {
          firstRowPreview.push(`${args.headers[idx]}: ${formatZoeCellForDisplay(val, col)}`);
        }
      });
    }
    if (firstRowPreview.length > 0) {
      lines.push(`Top record highlight — ${firstRowPreview.join(', ')}.`);
    }
  }

  if (lines.length < 3) {
    lines.push(
      `All figures are read-only server calculations in Africa/Kampala time formatted in Ugandan shillings (UGX).`,
    );
  }

  return lines.slice(0, 5);
}

function toReportCell(val: unknown): ZoeReportCell {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return sanitizeWelileTerms(val);
  if (Array.isArray(val)) {
    return sanitizeWelileTerms(
      val
        .map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
        .join(', '),
    );
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    // Flatten compact state objects like `{ paid: 90, part: 75, missed: 168 }` cleanly
    const pairs = Object.entries(obj)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
      .map(([k, v]) => `${k}: ${v}`);
    if (pairs.length > 0) return sanitizeWelileTerms(pairs.join(', '));
    return sanitizeWelileTerms(JSON.stringify(val));
  }
  return String(val);
}

const ARRAY_CANDIDATE_KEYS = [
  'rows',
  'detailed_rows',
  'by_staff',
  'weekly_all_calls_summary',
  'per_day',
  'categories',
  'items',
  'list',
  'records',
  'results',
  'agents',
  'tenants',
  'landlords',
  'supporters',
  'portfolios',
  'plans',
  'tasks',
  'tickets',
  'payslips',
  'requisitions',
  'approved_requisitions',
  'expiring_contracts',
  'upcoming_birthdays',
  'advances',
  'concerns',
  'orders',
  'calls',
  'waiting',
  'reminders',
  'schedules',
  'buckets',
  'cohorts',
  'departments',
  'accounts',
  'disbursements',
  'cashouts',
  'teams',
];

function isRecordObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function findRowsArrayInObject(obj: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const key of ARRAY_CANDIDATE_KEYS) {
    const candidate = obj[key];
    if (Array.isArray(candidate) && candidate.length > 0 && candidate.every(isRecordObject)) {
      return candidate;
    }
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val) && val.length > 0 && val.every(isRecordObject)) {
      return val;
    }
  }
  // Convert a bucket map (e.g. `summary: { "1-7": { count: 119, arrears_ugx: 15292479 }, ... }`) into structured rows
  if (isRecordObject(obj.summary)) {
    const bucketRows: Record<string, unknown>[] = [];
    for (const [bucketKey, bucketVal] of Object.entries(obj.summary)) {
      if (isRecordObject(bucketVal)) {
        bucketRows.push({ bucket: bucketKey, ...bucketVal });
      }
    }
    if (bucketRows.length >= 2) {
      return bucketRows;
    }
  }
  return null;
}

/**
 * Extracts structured row objects from `report_payload` (including top-level arrays or nested
 * report sections like `data`, `summary`, `receivables`, `payables`), hiding internal ID columns.
 */
function extractStructuredRows(payload: Record<string, unknown>): {
  columns: string[];
  hiddenColumns: string[];
  rows: ZoeReportCell[][];
  rawRows: Record<string, unknown>[];
  rowCount: number;
} | null {
  let rawRows = findRowsArrayInObject(payload);

  if (!rawRows && isRecordObject(payload.data)) {
    rawRows = findRowsArrayInObject(payload.data);
  }
  if (!rawRows && isRecordObject(payload.summary)) {
    rawRows = findRowsArrayInObject(payload.summary);
  }
  if (!rawRows && isRecordObject(payload.receivables)) {
    rawRows = findRowsArrayInObject(payload.receivables);
  }
  if (!rawRows && isRecordObject(payload.payables)) {
    rawRows = findRowsArrayInObject(payload.payables);
  }

  if (!rawRows || rawRows.length === 0) {
    return null;
  }

  const allColumns: string[] = [];
  for (const row of rawRows) {
    for (const key of Object.keys(row)) {
      if (!allColumns.includes(key)) {
        allColumns.push(key);
      }
    }
  }

  if (allColumns.length === 0) return null;

  const hiddenColumns = allColumns.filter((col) => isInternalIdColumn(col, rawRows!));
  const visibleColumns = allColumns.filter((col) => !hiddenColumns.includes(col));
  const columns = visibleColumns.length > 0 ? visibleColumns : allColumns;

  const rows: ZoeReportCell[][] = rawRows.map((row) =>
    columns.map((col) => {
      const cell = toReportCell(row[col]);
      // Coerce numeric strings on money/numeric columns to real numbers so Excel/PDF treat them as numbers
      if (typeof cell === 'string' && isMoneyColumn(col)) {
        const cleaned = cell.replace(/^UGX\s*/i, '').replace(/,/g, '').trim();
        if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
          return Number(cleaned);
        }
      }
      return cell;
    }),
  );

  const explicitCount =
    typeof payload.row_count === 'number' && Number.isFinite(payload.row_count)
      ? payload.row_count
      : typeof (payload.data as Record<string, unknown> | undefined)?.total_row_count === 'number'
        ? Number((payload.data as Record<string, unknown>).total_row_count)
        : rawRows.length;

  return {
    columns,
    hiddenColumns,
    rows,
    rawRows,
    rowCount: Math.max(explicitCount, rawRows.length),
  };
}

const EXPLICIT_FILE_REQUEST_RE =
  /\b(?:excel|xlsx|spreadsheet|workbook|pdf|csv)\b|(?:^|\s)(?:export|download)\s+(?:this|that|it|the\s+(?:report|table|list|data)|as\b|to\b)|(?:give|send|make|create|generate|prepare|share)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:excel|xlsx|spreadsheet|pdf|file)\b/i;

const EXCEL_INTENT_RE = /\b(?:excel|xlsx|spreadsheet|workbook)\b/i;
const PDF_INTENT_RE = /\bpdf\b/i;

/**
 * Deterministic check for whether a user prompt explicitly asks for an Excel or PDF file.
 * Returns `{ requested: false, format: null }` for regular questions with no file request.
 */
export function isZoeFileRequested(userPrompt: string): ZoeFileRequestIntent {
  const text = (userPrompt || '').trim();
  if (!text || !EXPLICIT_FILE_REQUEST_RE.test(text)) {
    return { requested: false, format: null };
  }
  const wantsExcel = EXCEL_INTENT_RE.test(text);
  const wantsPdf = PDF_INTENT_RE.test(text);
  if (wantsExcel && wantsPdf) {
    return { requested: true, format: 'both' };
  }
  if (wantsExcel) {
    return { requested: true, format: 'xlsx' };
  }
  if (wantsPdf) {
    return { requested: true, format: 'pdf' };
  }
  return { requested: true, format: 'both' };
}

/**
 * Evaluates whether a Zoe turn should create a file or only show the two small offer chips.
 * Rule (Prompt 1 item 2):
 *   - A file is created ONLY when the user explicitly asks in `userPrompt` OR taps an offer chip (`chipTappedFormat`).
 *   - When the answer contains a structured table and no file was requested, `fileCreated` is `false`
 *     and `offerChipsShown` is `true`.
 */
export function evaluateZoeFileRequest(args: {
  userPrompt: string;
  assistantMessage: ZoeExportSourceMessage;
  chipTappedFormat?: 'xlsx' | 'pdf' | null;
  options?: ZoeExtractReportOptions;
}): ZoeFileDecision {
  const report = extractZoeExportableReport(args.assistantMessage, {
    ...args.options,
    userQuestion: args.userPrompt || args.assistantMessage.userQuestion,
  });

  if (!report) {
    return {
      report: null,
      fileCreated: false,
      requestedFormat: null,
      offerChipsShown: false,
    };
  }

  if (args.chipTappedFormat === 'xlsx' || args.chipTappedFormat === 'pdf') {
    return {
      report,
      fileCreated: true,
      requestedFormat: args.chipTappedFormat,
      offerChipsShown: false,
    };
  }

  const intent = isZoeFileRequested(args.userPrompt);
  if (intent.requested) {
    return {
      report,
      fileCreated: true,
      requestedFormat: intent.format ?? 'both',
      offerChipsShown: false,
    };
  }

  return {
    report,
    fileCreated: false,
    requestedFormat: null,
    offerChipsShown: true,
  };
}

/**
 * Extracts a structured `ZoeExportableReport` from a Zoe assistant message when it contains
 * structured tabular rows (`report_payload`).
 *
 * Prompt 1 item (2): Never builds `'period_summary'` reports out of loose scalar fields
 * or markdown tables. Returns `null` when the message has no structured table rows.
 */
export function extractZoeExportableReport(
  message: ZoeExportSourceMessage,
  options?: ZoeExtractReportOptions,
): ZoeExportableReport | null {
  if (!message || message.role !== 'assistant') return null;

  const statusOrOutcome = message.status ?? message.outcome ?? 'answered';
  if (statusOrOutcome !== 'answered') return null;

  const payload = message.reportPayload ?? message.report_payload ?? null;
  if (!payload || !isRecordObject(payload)) return null;

  const structured = extractStructuredRows(payload);
  if (!structured || structured.rows.length === 0) {
    return null;
  }

  const rawSource =
    (typeof payload.source === 'string' && payload.source.trim()) ||
    message.source ||
    message.source_label ||
    (typeof payload.rpc === 'string' && payload.rpc.trim()) ||
    (typeof payload.tool === 'string' && payload.tool.trim()) ||
    'Welile Staff Assistant Report';

  const source = sanitizeWelileTerms(String(rawSource));
  const toolOrSource =
    (typeof payload.tool === 'string' && payload.tool.trim()) ||
    (typeof payload.rpc === 'string' && payload.rpc.trim()) ||
    source;

  const periodLabel = formatZoePeriodLabel(
    payload.period,
    message.period ?? message.period_label ?? null,
  );

  const generatedAt = formatZoeKampalaTimestamp(
    options?.generatedAt ?? message.createdAt ?? message.created_at,
  );
  const generatedBy = sanitizeWelileTerms(
    options?.generatedBy?.trim() || 'Signed-in Welile Staff Member',
  );
  const question = sanitizeWelileTerms(
    options?.userQuestion?.trim() ||
      message.userQuestion?.trim() ||
      (typeof payload.question === 'string' ? payload.question.trim() : '') ||
      humanizeZoeReportTitle(toolOrSource, 'table'),
  );
  const howCountedNote = buildZoeHowCountedNote(payload, source);
  const title = humanizeZoeReportTitle(toolOrSource, 'table');
  const headers = structured.columns.map(formatZoeColumnHeader);
  const totalsRow = computeZoeReportTotalsRow(structured.columns, structured.rows);

  const pdfSelection = selectImportantColumnsForPdf(structured.columns, MAX_PDF_COLUMNS);
  const pdfColumns = pdfSelection.selectedColumns;
  const pdfHeaders = pdfColumns.map(formatZoeColumnHeader);
  const pdfRows = structured.rows.map((row) =>
    pdfSelection.selectedIndices.map((idx) => row[idx]),
  );
  const pdfTotalsRow = totalsRow
    ? pdfSelection.selectedIndices.map((idx) => totalsRow[idx])
    : null;

  const summaryLines = buildVerifiedSummaryLines({
    chatContent: message.content || '',
    title,
    periodLabel,
    source,
    rowCount: structured.rowCount,
    columns: structured.columns,
    headers,
    rows: structured.rows,
    totalsRow,
  });

  const primarySheet: ZoeReportSheet = {
    name: 'Report Data',
    headers,
    keys: structured.columns,
    rows: structured.rows,
    rawRows: structured.rawRows,
    totalsRow,
  };

  return {
    kind: 'table',
    title,
    subtitle: `${structured.rowCount.toLocaleString('en-US')} ${structured.rowCount === 1 ? 'row' : 'rows'} · ${periodLabel}`,
    question,
    periodLabel,
    generatedAt,
    generatedBy,
    source,
    howCountedNote,
    headers,
    columns: structured.columns,
    keys: structured.columns,
    hiddenColumns: structured.hiddenColumns,
    rows: structured.rows,
    rawRows: structured.rawRows,
    rowCount: structured.rowCount,
    sheets: [primarySheet],
    summaryMetrics: [],
    totalsRow,
    summaryLines,
    pdfColumns,
    pdfHeaders,
    pdfRows,
    pdfTotalsRow,
    omittedPdfColumns: pdfSelection.omittedCount,
    filenameBase: buildZoeReportFilename(toolOrSource, periodLabel, 'pdf').replace(/\.pdf$/, ''),
  };
}

/**
 * Helper to build a `ZoeReportSheet` from an array of row objects (hiding internal ID columns).
 */
export function buildSheetFromRowObjects(
  sheetName: string,
  rowObjects: Record<string, unknown>[],
): ZoeReportSheet | null {
  if (!Array.isArray(rowObjects) || rowObjects.length === 0) return null;
  const allCols: string[] = [];
  for (const row of rowObjects) {
    for (const k of Object.keys(row)) {
      if (!allCols.includes(k)) allCols.push(k);
    }
  }
  const visible = allCols.filter((c) => !isInternalIdColumn(c, rowObjects));
  const keys = visible.length > 0 ? visible : allCols;
  const headers = keys.map(formatZoeColumnHeader);
  const rows: ZoeReportCell[][] = rowObjects.map((r) => keys.map((k) => toReportCell(r[k])));
  const totalsRow = computeZoeReportTotalsRow(keys, rows);
  return {
    name: sheetName.slice(0, 31) || 'Report Data',
    headers,
    keys,
    rows,
    rawRows: rowObjects,
    totalsRow,
  };
}

/**
 * Retained as a no-op helper for module compatibility; per Prompt 1 item (2),
 * `extractZoeExportableReport` never builds reports from markdown tables.
 */
export function parseMarkdownTableFromContent(_content: string): ZoeReportSheet | null {
  return null;
}

/**
 * Returns the formatted string matrix (`displayRows`) for `report.rows` using `formatZoeCellForDisplay`.
 */
export function buildZoeDisplayRows(report: ZoeExportableReport): string[][] {
  return report.rows.map((row) =>
    row.map((cell, colIndex) =>
      formatZoeCellForDisplay(cell, report.columns[colIndex] ?? `col_${colIndex}`),
    ),
  );
}
