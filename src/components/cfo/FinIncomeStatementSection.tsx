import { useState, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import {
  type FinIncomeStatement,
  type FinIncomeLine,
  type FinIncomeLineDetail,
  convertToFinIncomeStatement,
} from '@/hooks/useFinIncomeStatement';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface YearColumnData {
  label: string;
  statement: FinIncomeStatement;
}

interface FinIncomeStatementSectionProps {
  d: FinIncomeStatement | null;
  error?: string | null;
  comparisonD?: FinIncomeStatement | null;
  comparisonLabel?: string;
  fallbackD?: import('@/hooks/useFinancialStatements').IncomeStatementData | null;
  fallbackComparisonD?: import('@/hooks/useFinancialStatements').IncomeStatementData | null;
  multiYearColumns?: YearColumnData[];
  headerTitle?: string;
}

/** Formats currency in standard US GAAP / SEC Form 10-K presentation: negative values enclosed in parentheses `(5,000)`. */
function formatAccounting(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—';
  if (val === 0) return '—';
  if (val < 0) return `(${formatUGX(Math.abs(val))})`;
  return formatUGX(val);
}

interface FunctionalExpenseGroup {
  key: string;
  title: string;
  matcher: (l: FinIncomeLine) => boolean;
}

const FUNCTIONAL_GROUPS: FunctionalExpenseGroup[] = [
  {
    key: 'ops_support',
    title: 'Operations and support',
    matcher: (l) =>
      l.label.toLowerCase().includes('reimbursement') ||
      l.label.toLowerCase().includes('field') ||
      l.label.toLowerCase().includes('support') ||
      l.label.toLowerCase().includes('requisition'),
  },
  {
    key: 'sales_marketing',
    title: 'Sales and marketing',
    matcher: (l) =>
      l.label.toLowerCase().includes('marketing') ||
      l.label.toLowerCase().includes('incentive') ||
      (l.label.toLowerCase().includes('bonus') && !l.label.toLowerCase().includes('loyalty')),
  },
  {
    key: 'rd',
    title: 'Research and development',
    matcher: (l) =>
      l.label.toLowerCase().includes('research') ||
      l.label.toLowerCase().includes('development') ||
      l.label.toLowerCase().includes('r&d'),
  },
  {
    key: 'ga',
    title: 'General and administrative',
    matcher: (l) =>
      l.label.toLowerCase().includes('payroll') ||
      l.label.toLowerCase().includes('staff') ||
      l.label.toLowerCase().includes('salary') ||
      l.label.toLowerCase().includes('administrative') ||
      l.label.toLowerCase().includes('general') ||
      l.label.toLowerCase().includes('equipment'),
  },
];

export default function FinIncomeStatementSection({
  d,
  error,
  comparisonD,
  fallbackD,
  fallbackComparisonD,
  multiYearColumns,
  headerTitle = 'Year Ended December 31,',
}: FinIncomeStatementSectionProps) {
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Resolve single-period active statement
  const effectiveD = useMemo(() => {
    if (d) return d;
    if (fallbackD) return convertToFinIncomeStatement(fallbackD);
    return null;
  }, [d, fallbackD]);

  const effectiveComparisonD = useMemo(() => {
    if (comparisonD) return comparisonD;
    if (fallbackComparisonD) return convertToFinIncomeStatement(fallbackComparisonD);
    return null;
  }, [comparisonD, fallbackComparisonD]);

  // Construct multi-year columns matching Uber Technologies' 10-K format
  const columns: YearColumnData[] = useMemo(() => {
    if (multiYearColumns && multiYearColumns.length > 0) {
      return multiYearColumns;
    }
    if (effectiveD && effectiveComparisonD) {
      return [
        { label: '2025', statement: effectiveComparisonD },
        { label: '2026', statement: effectiveD },
      ];
    }
    if (effectiveD) {
      return [{ label: '2026', statement: effectiveD }];
    }
    return [];
  }, [multiYearColumns, effectiveD, effectiveComparisonD]);

  // Error handling
  if (error && columns.length === 0) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-xs text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold">Unable to compile Income Statement</p>
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  // Loading state
  if (columns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-xs font-medium">Resolving general ledger legs and generating statements…</span>
      </div>
    );
  }

  // Collect distinct revenue lines across all available year columns
  const revenueLines = Array.from(
    new Set(columns.flatMap((c) => c.statement.sections.revenue.lines.map((l) => l.label)))
  );

  // Collect distinct cost of revenue lines
  const costOfRevenueLines = Array.from(
    new Set(columns.flatMap((c) => c.statement.sections.cost_of_revenue.lines.map((l) => l.label)))
  );

  // Group operating expense lines into Uber's functional categories
  const allOpLines = Array.from(
    new Set(columns.flatMap((c) => c.statement.sections.operating_expense.lines.map((l) => l.label)))
  );

  const matchedOpKeys = new Set<string>();
  const functionalOpGroups = FUNCTIONAL_GROUPS.map((g) => {
    const lines = allOpLines.filter((l) => {
      if (g.matcher({ label: l } as FinIncomeLine)) {
        matchedOpKeys.add(l);
        return true;
      }
      return false;
    });
    return { key: g.key, title: g.title, lines };
  }).filter((g) => g.lines.length > 0);

  const remainingOpLines = allOpLines.filter((l) => !matchedOpKeys.has(l));
  if (remainingOpLines.length > 0) {
    functionalOpGroups.push({
      key: 'other_operating',
      title: 'Other operating costs',
      lines: remainingOpLines,
    });
  }

  // Collect distinct other income/expense lines
  const otherLines = Array.from(
    new Set(columns.flatMap((c) => c.statement.sections.other.lines.map((l) => l.label)))
  );

  // Collect distinct tax lines
  const taxLines = Array.from(
    new Set(columns.flatMap((c) => c.statement.sections.tax.lines.map((l) => l.label)))
  );

  const primaryStatement = columns[columns.length - 1].statement;

  return (
    <div className="space-y-6 text-foreground font-sans">
      {/* ── Statement Header ── */}
      <div className="pb-2 border-b border-border/70">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold tracking-widest text-primary uppercase">
            Welile Technologies, Inc.
          </span>
          <Badge variant="outline" className="text-[10px] uppercase font-semibold">
            Form 10-K Reference
          </Badge>
        </div>
        <h2 className="text-xl font-bold tracking-tight text-foreground mt-0.5">
          Consolidated Statements of Operations
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          (In Uganda Shillings [UGX], under General Ledger accounting standard)
        </p>
      </div>

      {/* ── Main Statements of Operations Table (Uber 10-K Structure) ── */}
      <div className="overflow-x-auto rounded-lg border border-border/80 bg-card shadow-sm">
        <table className="w-full text-xs text-left border-collapse">
          <thead>
            {/* Top Super-Header: "Year Ended December 31," spanning year columns */}
            <tr className="border-b border-border/50">
              <th className="py-2.5 pl-4 pr-3 text-left font-serif italic text-muted-foreground text-xs font-normal">
                (In UGX)
              </th>
              <th
                colSpan={columns.length}
                className="text-center py-2 font-serif font-bold text-xs sm:text-sm tracking-wide text-foreground border-b-2 border-foreground/80"
              >
                {headerTitle}
              </th>
            </tr>

            {/* Individual Year Columns with separate underlines */}
            <tr className="border-b border-border/80 bg-muted/20">
              <th className="py-2.5 pl-4 pr-3 text-left text-xs font-bold text-foreground">
                Line Item
              </th>
              {columns.map((col) => (
                <th
                  key={col.label}
                  className="py-2 px-4 text-right font-serif font-bold text-xs sm:text-sm text-foreground min-w-[140px]"
                >
                  <span className="inline-block border-b-2 border-foreground/80 pb-0.5 px-3">
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-border/30">
            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 1. REVENUE                                                      */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <tr className="font-bold text-foreground bg-muted/10">
              <td colSpan={columns.length + 1} className="py-2 pl-4 pr-3 text-[11px] uppercase tracking-wider text-primary">
                Revenue
              </td>
            </tr>

            {revenueLines.map((label) => {
              const rowId = `rev-${label}`;
              const isExpanded = !!expandedRows[rowId];
              const details = columns
                .flatMap((c) => c.statement.sections.revenue.lines.find((l) => l.label === label)?.detail || [])
                .slice(0, 5);

              return (
                <MultiYearRowItem
                  key={label}
                  id={rowId}
                  label={label}
                  indent={1}
                  columns={columns}
                  getValue={(s) => s.sections.revenue.lines.find((l) => l.label === label)?.amount ?? 0}
                  detail={details}
                  isExpanded={isExpanded}
                  onToggle={() => toggleRow(rowId)}
                />
              );
            })}

            {/* Total Revenue */}
            <tr className="font-bold border-t border-b border-border/80 bg-muted/20">
              <td className="py-2.5 pl-6 pr-3 text-foreground font-semibold">
                Total revenue
              </td>
              {columns.map((col) => (
                <td key={col.label} className="py-2.5 px-4 text-right font-mono font-bold text-foreground">
                  {formatAccounting(col.statement.totals.revenue)}
                </td>
              ))}
            </tr>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 2. COSTS AND EXPENSES                                           */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <tr className="font-bold text-foreground bg-muted/10">
              <td colSpan={columns.length + 1} className="py-2 pl-4 pr-3 text-[11px] uppercase tracking-wider text-primary pt-3">
                Costs and expenses:
              </td>
            </tr>

            {/* Cost of revenue header */}
            <tr className="font-semibold text-muted-foreground">
              <td colSpan={columns.length + 1} className="py-1 pl-6 pr-3 text-[11px]">
                Cost of revenue (exclusive of operating expenses shown below)
              </td>
            </tr>

            {costOfRevenueLines.map((label) => {
              const rowId = `cor-${label}`;
              const isExpanded = !!expandedRows[rowId];
              const details = columns
                .flatMap((c) => c.statement.sections.cost_of_revenue.lines.find((l) => l.label === label)?.detail || [])
                .slice(0, 5);

              return (
                <MultiYearRowItem
                  key={label}
                  id={rowId}
                  label={label}
                  isExpense
                  indent={2}
                  columns={columns}
                  getValue={(s) => -(s.sections.cost_of_revenue.lines.find((l) => l.label === label)?.amount ?? 0)}
                  detail={details}
                  isExpanded={isExpanded}
                  onToggle={() => toggleRow(rowId)}
                />
              );
            })}

            {/* Total Cost of Revenue */}
            <tr className="font-semibold bg-muted/10 border-t border-border/50 text-muted-foreground">
              <td className="py-1.5 pl-8 pr-3">Total cost of revenue</td>
              {columns.map((col) => (
                <td key={col.label} className="py-1.5 px-4 text-right font-mono text-destructive">
                  {formatAccounting(-col.statement.totals.cost_of_revenue)}
                </td>
              ))}
            </tr>

            {/* Gross Profit Subtotal */}
            <tr className="font-bold bg-muted/20 border-t-2 border-b-2 border-border/80">
              <td className="py-2.5 pl-4 pr-3 font-semibold text-foreground">
                Gross profit / (loss)
              </td>
              {columns.map((col) => {
                const gp = col.statement.totals.gross_profit;
                return (
                  <td
                    key={col.label}
                    className={cn(
                      'py-2.5 px-4 text-right font-mono font-bold',
                      gp < 0 ? 'text-destructive' : 'text-foreground'
                    )}
                  >
                    {formatAccounting(gp)}
                  </td>
                );
              })}
            </tr>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 3. OPERATING EXPENSES (UBER FUNCTIONAL CATEGORIES)              */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <tr className="font-semibold text-muted-foreground">
              <td colSpan={columns.length + 1} className="py-1.5 pl-6 pr-3 text-[11px] pt-3">
                Operating expenses:
              </td>
            </tr>

            {functionalOpGroups.map((grp) => {
              // Group total across columns
              return (
                <tr key={grp.key} className="contents">
                  {/* Category Group Header */}
                  <tr className="font-medium text-foreground bg-muted/5">
                    <td className="py-1.5 pl-8 pr-3 font-medium">{grp.title}</td>
                    {columns.map((col) => {
                      const totalInGrp = grp.lines.reduce((acc, l) => {
                        const amt = col.statement.sections.operating_expense.lines.find((ol) => ol.label === l)?.amount || 0;
                        return acc + amt;
                      }, 0);

                      return (
                        <td key={col.label} className="py-1.5 px-4 text-right font-mono text-destructive">
                          {formatAccounting(-totalInGrp)}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Individual sublines */}
                  {grp.lines.map((label) => {
                    const rowId = `op-${grp.key}-${label}`;
                    const isExpanded = !!expandedRows[rowId];
                    const details = columns
                      .flatMap((c) => c.statement.sections.operating_expense.lines.find((l) => l.label === label)?.detail || [])
                      .slice(0, 5);

                    return (
                      <MultiYearRowItem
                        key={label}
                        id={rowId}
                        label={label}
                        isExpense
                        indent={3}
                        columns={columns}
                        getValue={(s) => -(s.sections.operating_expense.lines.find((l) => l.label === label)?.amount ?? 0)}
                        detail={details}
                        isExpanded={isExpanded}
                        onToggle={() => toggleRow(rowId)}
                      />
                    );
                  })}
                </tr>
              );
            })}

            {/* Total Operating Expenses */}
            <tr className="font-semibold bg-muted/15 border-t border-border">
              <td className="py-2 pl-6 pr-3 text-foreground">
                Total operating expenses
              </td>
              {columns.map((col) => (
                <td key={col.label} className="py-2 px-4 text-right font-mono text-destructive font-semibold">
                  {formatAccounting(-col.statement.totals.operating_expenses)}
                </td>
              ))}
            </tr>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 4. OPERATING PROFIT / (LOSS) (INCOME FROM OPERATIONS)           */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <tr className="font-bold bg-muted/25 border-t-2 border-b-2 border-border/80">
              <td className="py-2.5 pl-4 pr-3 font-semibold text-foreground">
                Operating profit / (loss)
              </td>
              {columns.map((col) => {
                const op = col.statement.totals.operating_result;
                return (
                  <td
                    key={col.label}
                    className={cn(
                      'py-2.5 px-4 text-right font-mono font-bold',
                      op < 0 ? 'text-destructive' : 'text-foreground'
                    )}
                  >
                    {formatAccounting(op)}
                  </td>
                );
              })}
            </tr>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 5. OTHER INCOME / (EXPENSE), NET (NON-OPERATING)                */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            {otherLines.length > 0 && (
              <>
                <tr className="font-bold text-muted-foreground bg-muted/5">
                  <td colSpan={columns.length + 1} className="py-1.5 pl-4 pr-3 uppercase tracking-wider text-[11px] pt-3">
                    Other income / (expense), net:
                  </td>
                </tr>

                {otherLines.map((label) => {
                  const rowId = `oth-${label}`;
                  const isExpanded = !!expandedRows[rowId];
                  const details = columns
                    .flatMap((c) => c.statement.sections.other.lines.find((l) => l.label === label)?.detail || [])
                    .slice(0, 5);

                  return (
                    <MultiYearRowItem
                      key={label}
                      id={rowId}
                      label={label}
                      isExpense
                      indent={2}
                      columns={columns}
                      getValue={(s) => -(s.sections.other.lines.find((l) => l.label === label)?.amount ?? 0)}
                      detail={details}
                      isExpanded={isExpanded}
                      onToggle={() => toggleRow(rowId)}
                    />
                  );
                })}

                <tr className="font-semibold bg-muted/10 border-t border-border/60 text-muted-foreground">
                  <td className="py-1.5 pl-6 pr-3">Total other income / (expense)</td>
                  {columns.map((col) => (
                    <td key={col.label} className="py-1.5 px-4 text-right font-mono text-destructive">
                      {formatAccounting(-col.statement.totals.other_items)}
                    </td>
                  ))}
                </tr>
              </>
            )}

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 6. PROFIT / (LOSS) BEFORE TAX                                   */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <tr className="font-bold bg-muted/15 border-t border-border">
              <td className="py-2 pl-4 pr-3 font-semibold text-foreground">
                Profit / (loss) before income taxes
              </td>
              {columns.map((col) => {
                const pbt = col.statement.totals.result_before_tax;
                return (
                  <td
                    key={col.label}
                    className={cn(
                      'py-2 px-4 text-right font-mono font-semibold',
                      pbt < 0 ? 'text-destructive' : 'text-foreground'
                    )}
                  >
                    {formatAccounting(pbt)}
                  </td>
                );
              })}
            </tr>

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 7. INCOME TAX EXPENSE                                           */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            {taxLines.length > 0 && (
              <>
                {taxLines.map((label) => (
                  <MultiYearRowItem
                    key={label}
                    id={`tax-${label}`}
                    label={label}
                    isExpense
                    indent={1}
                    columns={columns}
                    getValue={(s) => -(s.sections.tax.lines.find((l) => l.label === label)?.amount ?? 0)}
                  />
                ))}
              </>
            )}

            {/* ═══════════════════════════════════════════════════════════════ */}
            {/* 8. NET PROFIT / (LOSS) (UBER NET INCOME DOUBLE-UNDERLINE)       */}
            {/* ═══════════════════════════════════════════════════════════════ */}
            <tr className="font-extrabold text-sm border-t-2 border-b-4 border-double border-foreground/60 bg-muted/20">
              <td className="py-3 pl-4 pr-3 text-foreground tracking-tight">
                Net profit / (loss)
              </td>
              {columns.map((col) => {
                const net = col.statement.totals.net_result;
                return (
                  <td
                    key={col.label}
                    className={cn(
                      'py-3 px-4 text-right font-mono font-bold text-sm',
                      net < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'
                    )}
                  >
                    {formatAccounting(net)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Footnote & Reconciliation Tie-Out ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1 text-[11px] text-muted-foreground border-t border-border/50">
        <div
          className={cn(
            'flex items-center gap-1.5 font-medium',
            primaryStatement.reconciliation.ties_to_ledger
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-destructive'
          )}
        >
          {primaryStatement.reconciliation.ties_to_ledger ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          <span>
            {primaryStatement.reconciliation.ties_to_ledger
              ? `General ledger tie-out confirmed: Revenue ${formatUGX(
                  primaryStatement.reconciliation.ledger_revenue
                )} less Expenses ${formatUGX(
                  primaryStatement.reconciliation.ledger_expenses
                )} = Net ${formatUGX(primaryStatement.reconciliation.ledger_net)}.`
              : `Differs from general ledger by ${formatUGX(
                  Math.abs(primaryStatement.reconciliation.difference)
                )}.`}
          </span>
        </div>

        <div className="text-[10px] text-muted-foreground">
          Reporting Currency: <span className="font-semibold text-foreground">UGX</span> • Presentation Standard: US GAAP Form 10-K
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────

interface MultiYearRowItemProps {
  id: string;
  label: string;
  isExpense?: boolean;
  indent?: number;
  columns: YearColumnData[];
  getValue: (s: FinIncomeStatement) => number;
  detail?: FinIncomeLineDetail[];
  isExpanded?: boolean;
  onToggle?: () => void;
}

function MultiYearRowItem({
  label,
  isExpense = false,
  indent = 1,
  columns,
  getValue,
  detail = [],
  isExpanded,
  onToggle,
}: MultiYearRowItemProps) {
  const hasDetail = detail && detail.length > 0;
  const paddingLeft = indent === 1 ? 'pl-6' : indent === 2 ? 'pl-10' : 'pl-14';

  return (
    <>
      <tr className="hover:bg-muted/15 group transition-colors">
        <td className={cn('py-1.5 pr-3 text-xs text-foreground/90', paddingLeft)}>
          <div className="flex items-center gap-1.5 min-w-0">
            {hasDetail && onToggle ? (
              <button
                type="button"
                onClick={onToggle}
                className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground group-hover:text-foreground transition-colors shrink-0"
                title="View underlying account codes"
              >
                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className="truncate">{label}</span>
          </div>
        </td>

        {columns.map((col) => {
          const val = getValue(col.statement);
          return (
            <td
              key={col.label}
              className={cn(
                'py-1.5 px-4 text-right font-mono tabular-nums text-xs',
                val < 0 && 'text-destructive'
              )}
            >
              {formatAccounting(val)}
            </td>
          );
        })}
      </tr>

      {/* Expanded Underlying General Ledger Detail */}
      {isExpanded && hasDetail && (
        <tr className="bg-muted/20">
          <td colSpan={columns.length + 1} className="py-2 px-6">
            <div className="rounded-md border border-border/50 bg-background/80 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground uppercase tracking-wide border-b border-border/40 pb-1">
                <span>Underlying General Ledger Accounts ({detail.length} accounts)</span>
                <span>Category Breakdown</span>
              </div>
              <div className="space-y-1">
                {detail.map((d, idx) => (
                  <div key={`${d.account}-${d.category}-${idx}`} className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-primary">{d.account}</span>
                      <span className="text-muted-foreground">•</span>
                      <span className="font-mono text-muted-foreground">{d.category}</span>
                      <span className="text-[10px] text-muted-foreground">({d.legs} legs)</span>
                    </div>
                    <span className={cn('font-mono tabular-nums', isExpense ? 'text-destructive' : 'text-foreground')}>
                      {formatAccounting(isExpense ? -d.amount : d.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
