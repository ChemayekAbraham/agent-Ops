import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { format, endOfDay } from 'date-fns';
import {
  AlertTriangle, Calendar, CheckCircle2, ChevronDown, ChevronRight,
  Download, FileSpreadsheet, Loader2, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

interface PositionLine {
  label: string;
  value: number;
  source: string;
}

interface ScheduleRow {
  ledger_scope: string;
  category: string;
  groups: number;
  net_debit_less_credit: number;
}

interface Reconciliation {
  plug_applied?: boolean;
  unreconciled_difference?: number;
  classification_filter_granularity?: string;
  unresolved_groups: number;
  unresolved_absolute_amount: number;
  one_sided_equity_counterpart?: number;

  schedule: ScheduleRow[];
  excluded_classifications: { classification: string; legs: number; amount: number }[];
  memo_sub_ledgers: PositionLine[];
}

export interface StatementOfFinancialPosition {
  as_at: string;
  generated_at: string;
  currency: string;
  assets: {
    current: PositionLine[];
    non_current: PositionLine[];
    total_current: number;
    total_non_current: number;
    total: number;
  };
  liabilities: {
    current: PositionLine[];
    non_current: PositionLine[];
    total_current: number;
    total_non_current: number;
    total: number;
  };
  equity: {
    lines: PositionLine[];
    revenue_to_date: number;
    expenses_to_date: number;
    total: number;
  };
  trial_balance?: {
    total_debits: number;
    total_credits: number;
    difference: number;
    balanced: boolean;
  };
  reconciliation?: Reconciliation;
  balance_check: {
    total_assets: number;
    total_liabilities_and_equity: number;
    difference: number;
    balanced: boolean;
    state?: 'balanced' | 'failed';
    message?: string;
  };
}

function LineRow({ line, showSources }: { line: PositionLine; showSources: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start justify-between gap-3 py-1.5 text-left"
      >
        <span className="flex items-start gap-1 min-w-0 text-xs text-muted-foreground">
          {showSources
            ? (open ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />)
            : null}
          <span className="truncate">{line.label}</span>
        </span>
        <span className={cn('font-mono text-xs shrink-0 text-right', line.value < 0 ? 'text-destructive' : 'text-foreground')}>
          {line.value < 0 ? `(${formatUGX(Math.abs(line.value))})` : formatUGX(line.value)}
        </span>
      </button>
      {showSources && open && (
        <p className="pb-2 pl-4 text-[10px] text-muted-foreground">Derived from {line.source}</p>
      )}
    </div>
  );
}

function TotalRow({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={cn(
      'flex items-center justify-between gap-3 py-2 border-t',
      emphasis ? 'border-primary/50 mt-1' : 'border-border',
    )}>
      <span className={cn('text-xs', emphasis ? 'font-bold uppercase tracking-wide' : 'font-semibold')}>{label}</span>
      <span className={cn('font-mono', emphasis ? 'text-sm font-bold' : 'text-xs font-semibold')}>
        {value < 0 ? `(${formatUGX(Math.abs(value))})` : formatUGX(value)}
      </span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-widest text-primary mt-4 mb-1">{children}</p>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mt-3 mb-1">{children}</p>
  );
}

/**
 * Presentation-layer regrouping of the liability side of the statement.
 * Nothing is recalculated: every line keeps the exact value the ledger-driven
 * RPC returned. Lines are only bucketed into business categories, keyed on the
 * reporting account code embedded in `source`
 * ("general_ledger trial balance — account L4").
 *
 * Any liability account not explicitly named falls through to "Other Payables"
 * so no balance can silently disappear from the statement.
 */
const LIABILITY_GROUP_LABELS = [
  'Landlord Float — Company Managed',
  'Landlord Float — Self Managed',
  'Partner Buffer Liability',
  'Operational Float Liability',
  'Wallet Bucket Liability',
  'Merchant Agent Liability',
  'Other Payables',
] as const;
type LiabilityGroupLabel = typeof LIABILITY_GROUP_LABELS[number];

const MARKETPLACE_LIABILITY_LABELS: LiabilityGroupLabel[] = [
  'Landlord Float — Company Managed',
  'Landlord Float — Self Managed',
  'Partner Buffer Liability',
];
const OPERATIONAL_LIABILITY_LABELS: LiabilityGroupLabel[] = [
  'Operational Float Liability',
  'Wallet Bucket Liability',
  'Merchant Agent Liability',
  'Other Payables',
];

// Reporting account code -> presented liability line.
const LIABILITY_ACCOUNT_GROUPS: Record<string, LiabilityGroupLabel> = {
  L4: 'Landlord Float — Company Managed',
  L7: 'Landlord Float — Self Managed',
  L2: 'Partner Buffer Liability',
  L6: 'Partner Buffer Liability',
  L8: 'Operational Float Liability',
  L1: 'Wallet Bucket Liability',
  L10: 'Merchant Agent Liability',
  // L3 (partner returns/rewards), L5 (agent commissions), L9 (suspense) and any
  // account not listed here fall through to Other Payables.
};

function accountCodeOf(line: PositionLine): string | null {
  const m = /account\s+([A-Z]\d+)\s*$/.exec(line.source ?? '');
  return m ? m[1] : null;
}

export interface LiabilityGroup {
  label: LiabilityGroupLabel;
  value: number;
  lines: PositionLine[];
}

export function groupLiabilities(lines: PositionLine[]) {
  const byLabel = new Map<LiabilityGroupLabel, LiabilityGroup>(
    LIABILITY_GROUP_LABELS.map(label => [label, { label, value: 0, lines: [] }]),
  );
  for (const line of lines) {
    const code = accountCodeOf(line);
    const label = (code && LIABILITY_ACCOUNT_GROUPS[code]) || 'Other Payables';
    const group = byLabel.get(label)!;
    group.value += line.value;
    group.lines.push(line);
  }
  const pick = (labels: LiabilityGroupLabel[]) => labels.map(l => byLabel.get(l)!);
  const marketplace = pick(MARKETPLACE_LIABILITY_LABELS);
  const operational = pick(OPERATIONAL_LIABILITY_LABELS);
  const sum = (gs: LiabilityGroup[]) => gs.reduce((t, g) => t + g.value, 0);
  return {
    marketplace,
    operational,
    marketplaceTotal: sum(marketplace),
    operationalTotal: sum(operational),
  };
}

function GroupRow({ group, showSources }: { group: LiabilityGroup; showSources: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = showSources && group.lines.length > 0;
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        onClick={() => expandable && setOpen(o => !o)}
        className="w-full flex items-start justify-between gap-3 py-1.5 text-left"
      >
        <span className="flex items-start gap-1 min-w-0 text-xs text-muted-foreground">
          {expandable
            ? (open ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />)
            : null}
          <span className="truncate">{group.label}</span>
        </span>
        <span className={cn('font-mono text-xs shrink-0 text-right', group.value < 0 ? 'text-destructive' : 'text-foreground')}>
          {group.value < 0 ? `(${formatUGX(Math.abs(group.value))})` : formatUGX(group.value)}
        </span>
      </button>
      {expandable && open && (
        <div className="pb-2 pl-4 space-y-0.5">
          {group.lines.map(l => (
            <p key={l.label} className="text-[10px] text-muted-foreground flex justify-between gap-3">
              <span className="truncate">{l.label}</span>
              <span className="font-mono shrink-0">{formatUGX(l.value)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}


export default function BalanceSheetPanel() {
  const [asAt, setAsAt] = useState<Date>(new Date());
  const [data, setData] = useState<StatementOfFinancialPosition | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (date: Date) => {
    setLoading(true);
    try {
      const { data: res, error } = await (supabase as any).rpc('get_statement_of_financial_position', {
        p_as_at: endOfDay(date).toISOString(),
      });
      if (error) throw error;
      setData(res as StatementOfFinancialPosition);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to generate the statement of financial position');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(asAt); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const title = `WELILE — BALANCE SHEET — As at ${format(asAt, 'dd MMMM yyyy')}`;
  const liabilityGroups = data
    ? groupLiabilities([...data.liabilities.current, ...data.liabilities.non_current])
    : null;
  const liabilityGroupDrift = data && liabilityGroups
    ? Math.round(liabilityGroups.marketplaceTotal + liabilityGroups.operationalTotal - data.liabilities.total)
    : 0;

  const exportCSV = () => {
    if (!data) return;
    const rows: (string | number)[][] = [[title], []];
    rows.push(['ASSETS', '']);
    rows.push(['Current Assets', '']);
    data.assets.current.forEach(l => rows.push([l.label, l.value]));
    rows.push(['Total Current Assets', data.assets.total_current]);
    rows.push(['Non-Current Assets', '']);
    data.assets.non_current.forEach(l => rows.push([l.label, l.value]));
    rows.push(['Total Non-Current Assets', data.assets.total_non_current]);
    rows.push(['TOTAL ASSETS', data.assets.total]);
    rows.push([]);
    rows.push(['LIABILITIES', '']);
    rows.push(['Marketplace Liabilities', '']);
    (liabilityGroups?.marketplace ?? []).forEach(g => rows.push([g.label, g.value]));
    rows.push(['Subtotal — Marketplace Liabilities', liabilityGroups?.marketplaceTotal ?? 0]);
    rows.push(['Operational & Other Liabilities', '']);
    (liabilityGroups?.operational ?? []).forEach(g => rows.push([g.label, g.value]));
    rows.push(['Subtotal — Operational & Other Liabilities', liabilityGroups?.operationalTotal ?? 0]);
    rows.push(['TOTAL LIABILITIES', data.liabilities.total]);
    rows.push([]);
    rows.push(['EQUITY', '']);
    data.equity.lines.forEach(l => rows.push([l.label, l.value]));
    rows.push(['TOTAL EQUITY', data.equity.total]);
    rows.push([]);
    rows.push(['TOTAL LIABILITIES AND EQUITY', data.balance_check.total_liabilities_and_equity]);
    rows.push(['Balance check difference', data.balance_check.difference]);
    rows.push(['Balanced', data.balance_check.balanced ? 'YES' : 'NO']);
    if (data.trial_balance) {
      rows.push([]);
      rows.push(['TRIAL BALANCE', '']);
      rows.push(['Total debits', data.trial_balance.total_debits]);
      rows.push(['Total credits', data.trial_balance.total_credits]);
      rows.push(['Difference', data.trial_balance.difference]);
    }
    if (data.reconciliation) {
      rows.push([]);
      rows.push(['UNRESOLVED ONE-SIDED LEDGER POSTINGS', '']);
      rows.push(['Transactions affected', data.reconciliation.unresolved_groups]);
      rows.push(['Absolute amount', data.reconciliation.unresolved_absolute_amount]);
      rows.push(['Suspense plug applied', 'NO — no plug is used; the balance check is a real assertion']);
      rows.push(['Unreconciled difference (assets less liabilities and equity)', data.reconciliation.unreconciled_difference ?? data.balance_check.difference]);
      data.reconciliation.schedule?.forEach(r =>
        rows.push([`${r.category} (${r.ledger_scope}) — ${r.groups} transactions`, r.net_debit_less_credit]));
      rows.push([]);
      rows.push(['MEMO — NOT IN TOTALS', '']);
      data.reconciliation.memo_sub_ledgers?.forEach(l => rows.push([l.label, l.value]));
    }

    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `welile-statement-of-financial-position-${format(asAt, 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const margin = 14;
      let y = 20;

      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, 0, pw, 12, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 8);
      pdf.text('CONFIDENTIAL', pw - margin - 25, 8);

      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(13);
      pdf.text('BALANCE SHEET', margin, y);
      y += 6;
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(`As at ${format(asAt, 'dd MMMM yyyy')}`, margin, y);
      pdf.text(`Generated: ${format(new Date(data.generated_at), 'dd MMM yyyy, HH:mm')}`, pw - margin - 60, y);
      y += 3;
      pdf.setDrawColor(220, 220, 220);
      pdf.line(margin, y, pw - margin, y);
      y += 6;

      const heading = (t: string) => {
        if (y > ph - 30) { pdf.addPage(); y = 20; }
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(37, 99, 235);
        pdf.text(t.toUpperCase(), margin, y);
        pdf.setTextColor(0, 0, 0);
        y += 5;
      };
      const row = (label: string, value: number, bold = false, indent = true) => {
        if (y > ph - 20) { pdf.addPage(); y = 20; }
        pdf.setFontSize(bold ? 9 : 8);
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setTextColor(bold ? 0 : 80, bold ? 0 : 80, bold ? 0 : 80);
        pdf.text(label, indent && !bold ? margin + 5 : margin, y);
        const str = value < 0 ? `(${formatUGX(Math.abs(value))})` : formatUGX(value);
        pdf.text(str, pw - margin, y, { align: 'right' });
        if (bold) { pdf.setDrawColor(200, 200, 200); pdf.line(margin, y + 1.5, pw - margin, y + 1.5); }
        y += bold ? 7 : 5;
      };

      heading('Assets — Current');
      data.assets.current.forEach(l => row(l.label, l.value));
      row('Total Current Assets', data.assets.total_current, true);
      heading('Assets — Non-Current');
      data.assets.non_current.forEach(l => row(l.label, l.value));
      row('Total Non-Current Assets', data.assets.total_non_current, true);
      row('TOTAL ASSETS', data.assets.total, true);

      heading('Marketplace Liabilities');
      (liabilityGroups?.marketplace ?? []).forEach(g => row(g.label, g.value));
      row('Subtotal — Marketplace Liabilities', liabilityGroups?.marketplaceTotal ?? 0, true);
      heading('Operational & Other Liabilities');
      (liabilityGroups?.operational ?? []).forEach(g => row(g.label, g.value));
      row('Subtotal — Operational & Other Liabilities', liabilityGroups?.operationalTotal ?? 0, true);
      row('TOTAL LIABILITIES', data.liabilities.total, true);

      heading('Equity');
      data.equity.lines.forEach(l => row(l.label, l.value));
      row('TOTAL EQUITY', data.equity.total, true);

      heading('Balance Check');
      row('Total Assets', data.balance_check.total_assets);
      row('Total Liabilities and Equity', data.balance_check.total_liabilities_and_equity);
      row('Difference', data.balance_check.difference, true);
      if (data.trial_balance) {
        heading('Trial Balance');
        row('Total Debits', data.trial_balance.total_debits);
        row('Total Credits', data.trial_balance.total_credits);
        row('Difference', data.trial_balance.difference, true);
      }
      if (data.reconciliation) {
        heading('Unresolved one-sided ledger postings');
        row(`Transactions affected: ${data.reconciliation.unresolved_groups.toLocaleString()}`, data.reconciliation.unresolved_absolute_amount);
        row(
          'Unreconciled difference (no suspense plug applied)',
          data.reconciliation.unreconciled_difference ?? data.balance_check.difference,
          true,
        );
        data.reconciliation.schedule?.forEach(r =>
          row(`${r.category.replace(/_/g, ' ')} · ${r.ledger_scope} · ${r.groups} txns`, r.net_debit_less_credit));
        heading('Memo — operational records and wallet caches (not in totals)');
        data.reconciliation.memo_sub_ledgers?.forEach(l => row(l.label, l.value));
      }
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...(data.balance_check.balanced ? [22, 163, 74] : [220, 38, 38]) as [number, number, number]);
      pdf.text(
        data.balance_check.balanced
          ? 'BALANCED — Total Assets = Total Liabilities + Equity'
          : 'NOT BALANCED — difference shown above; no figures have been adjusted',
        margin, y,
      );

      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, ph - 8, pw, 8, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(7);
      pdf.text('Welile Technologies Limited — Confidential Financial Report — All figures in UGX', pw / 2, ph - 3, { align: 'center' });

      const fileName = `welile-statement-of-financial-position-${format(asAt, 'yyyy-MM-dd')}.pdf`;
      const blob = pdf.output('blob');
      const file = new File([blob], fileName, { type: 'application/pdf' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Welile Balance Sheet', files: [file] });
      } else {
        pdf.save(fileName);
        toast.success('PDF downloaded');
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error('PDF export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
              <Calendar className="h-3.5 w-3.5" />
              As at {format(asAt, 'dd MMM yyyy')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 z-[200]" align="start">
            <CalendarPicker
              mode="single"
              selected={asAt}
              onSelect={(d) => { if (d) { setAsAt(d); load(d); } }}
              initialFocus
              className="p-3 pointer-events-auto"
            />
          </PopoverContent>
        </Popover>
        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => load(asAt)} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {data ? 'Refresh' : 'Generate'}
        </Button>
        <Button
          size="sm"
          variant={showSources ? 'default' : 'outline'}
          className="h-7 text-xs"
          onClick={() => setShowSources(s => !s)}
        >
          {showSources ? 'Hide account detail' : 'Show account detail'}
        </Button>
      </div>

      {loading && !data && (
        <div className="py-10 text-center text-muted-foreground text-xs">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Building the statement from the general ledger…
        </div>
      )}

      {data && (
        <>
          <div className="text-center pb-2 border-b border-border">
            <p className="text-[11px] font-bold uppercase tracking-widest">Welile — Balance Sheet</p>
            <p className="text-[10px] text-muted-foreground">Balance Sheet — As at {format(asAt, 'dd MMMM yyyy')} · All figures in {data.currency}</p>
          </div>

          <div
            className={cn(
              'rounded-lg border p-3 flex items-start gap-2',
              data.balance_check.balanced ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5',
            )}
          >
            {data.balance_check.balanced
              ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
              : <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
            <div className="min-w-0 space-y-1">
              <p className={cn('text-xs font-semibold', data.balance_check.balanced ? 'text-success' : 'text-destructive')}>
                {data.balance_check.balanced
                  ? 'Balanced — Total Assets = Total Liabilities + Equity (real ledger data, no plug)'
                  : 'BALANCE CHECK FAILED — Total Assets do not equal Total Liabilities + Equity'}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground break-words">
                {formatUGX(data.balance_check.total_assets)} vs {formatUGX(data.balance_check.total_liabilities_and_equity)} · Difference {formatUGX(data.balance_check.difference)}
              </p>
              {!data.balance_check.balanced && (
                <p className="text-[10px] text-destructive/90 break-words">
                  {data.balance_check.message
                    ?? 'No suspense plug has been applied — the difference above is real and must be resolved in the ledger.'}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Badge variant="outline" className="text-[10px]">Assets</Badge>
              <SectionHeading>Current Assets</SectionHeading>
              <div>{data.assets.current.map(l => <LineRow key={l.label} line={l} showSources={showSources} />)}</div>
              <TotalRow label="Total Current Assets" value={data.assets.total_current} />
              <SectionHeading>Non-Current Assets</SectionHeading>
              <div>{data.assets.non_current.map(l => <LineRow key={l.label} line={l} showSources={showSources} />)}</div>
              <TotalRow label="Total Non-Current Assets" value={data.assets.total_non_current} />
              <TotalRow label="Total Assets" value={data.assets.total} emphasis />
            </div>

            <div>
              <Badge variant="outline" className="text-[10px]">Liabilities & Equity</Badge>
              <SectionHeading>Current Liabilities</SectionHeading>
              <div>{data.liabilities.current.map(l => <LineRow key={l.label} line={l} showSources={showSources} />)}</div>
              <TotalRow label="Total Current Liabilities" value={data.liabilities.total_current} />
              <SectionHeading>Non-Current Liabilities</SectionHeading>
              <div>{data.liabilities.non_current.map(l => <LineRow key={l.label} line={l} showSources={showSources} />)}</div>
              <TotalRow label="Total Non-Current Liabilities" value={data.liabilities.total_non_current} />
              <TotalRow label="Total Liabilities" value={data.liabilities.total} />
              <SectionHeading>Equity</SectionHeading>
              <div>{data.equity.lines.map(l => <LineRow key={l.label} line={l} showSources={showSources} />)}</div>
              <TotalRow label="Total Equity" value={data.equity.total} />
              <TotalRow label="Total Liabilities and Equity" value={data.balance_check.total_liabilities_and_equity} emphasis />
            </div>
          </div>

          {(data.trial_balance || data.reconciliation) && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary">Trial balance and reconciliation</p>

              {data.trial_balance && (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Total debits</p>
                    <p className="font-mono text-xs font-semibold">{formatUGX(data.trial_balance.total_debits)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Total credits</p>
                    <p className="font-mono text-xs font-semibold">{formatUGX(data.trial_balance.total_credits)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Difference</p>
                    <p className={cn('font-mono text-xs font-semibold', data.trial_balance.balanced ? 'text-success' : 'text-destructive')}>
                      {formatUGX(data.trial_balance.difference)}
                    </p>
                  </div>
                </div>
              )}

              {data.reconciliation && (
                <>
                  <p className="text-[10px] text-muted-foreground">
                    {data.reconciliation.unresolved_groups.toLocaleString()} historic ledger transactions carry only one side of their entry
                    ({formatUGX(data.reconciliation.unresolved_absolute_amount)} in absolute terms) and are listed below by category.
                    Their missing side is recognised, itemised, in the equity line "Legacy One-Sided Postings"
                    {typeof data.reconciliation.one_sided_equity_counterpart === 'number'
                      ? ` (${formatUGX(data.reconciliation.one_sided_equity_counterpart)})`
                      : ''}. No suspense plug is applied: every balanced ledger entry is mapped to a real debit and a real credit, so nothing
                    unexplained is absorbed into Current Assets. Classification exclusions are applied to whole transaction groups, never to individual legs.
                  </p>


                  {data.reconciliation.schedule?.length > 0 && (
                    <div className="space-y-0.5">
                      {data.reconciliation.schedule.map(r => (
                        <div key={`${r.ledger_scope}-${r.category}`} className="flex items-center justify-between gap-3 border-b border-border/40 py-1">
                          <span className="text-[10px] text-muted-foreground truncate">
                            {r.category.replace(/_/g, ' ')} · {r.ledger_scope} · {r.groups.toLocaleString()} transactions
                          </span>
                          <span className={cn('font-mono text-[10px] shrink-0', r.net_debit_less_credit < 0 ? 'text-destructive' : 'text-foreground')}>
                            {r.net_debit_less_credit < 0
                              ? `(${formatUGX(Math.abs(r.net_debit_less_credit))})`
                              : formatUGX(r.net_debit_less_credit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {data.reconciliation.memo_sub_ledgers?.length > 0 && (
                    <>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-primary pt-1">
                        Memo — operational records and wallet caches (not in the totals)
                      </p>
                      <div className="space-y-0.5">
                        {data.reconciliation.memo_sub_ledgers.map(l => (
                          <LineRow key={l.label} line={l} showSources={showSources} />
                        ))}
                      </div>
                    </>
                  )}

                  {data.reconciliation.excluded_classifications?.length > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      Excluded ledger classifications:{' '}
                      {data.reconciliation.excluded_classifications
                        .map(c => `${c.classification} (${c.legs.toLocaleString()} legs, ${formatUGX(c.amount)})`)
                        .join(' · ')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-3 border-t border-border">
            <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs" onClick={exportCSV}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> Export CSV
            </Button>
            <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs" onClick={exportPDF} disabled={exporting}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              PDF / Print
            </Button>
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            Every figure is generated live from the general ledger and existing operational records. No values are hard-coded and nothing is adjusted to force a balance.
          </p>
        </>
      )}
    </div>
  );
}