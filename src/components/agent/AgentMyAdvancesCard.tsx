import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Banknote, TrendingDown, Clock, CheckCircle2, AlertTriangle,
  Download, FileText, FileSpreadsheet, CalendarIcon, X, Zap,
} from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { differenceInDays, format, isAfter, isBefore, isEqual, startOfDay, endOfDay } from 'date-fns';
import { toast } from 'sonner';
import { generateAdvanceStatementPdf, type AdvanceStatementRow } from '@/lib/advanceStatementPdf';
import { downloadXlsx } from '@/lib/xlsxExport';
import { cn } from '@/lib/utils';
import { VoluntaryRepayAdvanceDialog } from './VoluntaryRepayAdvanceDialog';

const STATUS_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive'; icon: any }> = {
  active: { label: 'Active', variant: 'default', icon: Clock },
  overdue: { label: 'Overdue', variant: 'destructive', icon: AlertTriangle },
  completed: { label: 'Completed', variant: 'secondary', icon: CheckCircle2 },
};

/**
 * Agent-facing view of advances issued to THEM (the `agent_advances` table).
 * RLS already scopes selects to `agent_id = auth.uid()`, so agents see only
 * their own. Shows outstanding balance, daily deduction and days remaining so
 * the agent always knows what is being recovered from their wallet.
 */
export function AgentMyAdvancesCard() {
  const { user } = useAuth();
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [payAheadFor, setPayAheadFor] = useState<any | null>(null);

  const { data: advances = [], isLoading } = useQuery({
    queryKey: ['my-issued-advances', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('id, principal, outstanding_balance, arrears_balance, status, issued_at, expires_at, created_at, cycle_days, access_fee, prepaid_installments_remaining, deduction_paused, pause_reason')
        .eq('agent_id', user!.id)
        // Cancelled advances are closed by the CFO and no longer owed; without
        // this they fell through to the 'Active' badge with a 0 balance.
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  // Filter by date range (issued_at / created_at)
  const filteredAdvances = advances.filter((adv: any) => {
    const dateStr = adv.issued_at || adv.created_at;
    if (!dateStr) return true;
    const d = new Date(dateStr);
    if (dateFrom && isBefore(d, startOfDay(dateFrom))) return false;
    if (dateTo && isAfter(d, endOfDay(dateTo))) return false;
    return true;
  });

  // Hide entirely when the agent has no advances at all.
  if (!isLoading && advances.length === 0) return null;

  const totalOutstanding = filteredAdvances
    .filter((a: any) => a.status !== 'completed')
    .reduce((s: number, a: any) => s + Number(a.outstanding_balance || 0), 0);

  const hasActiveFilter = !!(dateFrom || dateTo);
  const clearFilters = () => { setDateFrom(undefined); setDateTo(undefined); };

  // Build a normalised row set (derived daily / days-left / access fee) shared
  // by both the PDF and Excel exporters so downloads match the on-screen card.
  const buildRows = (source: any[]): AdvanceStatementRow[] =>
    source.map((adv: any) => {
      const daysLeft = Math.max(0, differenceInDays(new Date(adv.expires_at), new Date()));
      const interest = Math.max(0, Number(adv.outstanding_balance) - Number(adv.principal));
      const dailyDeduction = adv.status !== 'completed'
        ? (daysLeft > 0 ? Math.round(Number(adv.outstanding_balance) / daysLeft) : Number(adv.outstanding_balance))
        : 0;
      return {
        principal: Number(adv.principal || 0),
        outstanding_balance: Number(adv.outstanding_balance || 0),
        status: adv.status,
        issued_at: adv.issued_at,
        expires_at: adv.expires_at,
        created_at: adv.issued_at || adv.created_at,
        daily_deduction: dailyDeduction,
        days_left: daysLeft,
        access_fee: interest,
      };
    });

  const ownerName = (user?.user_metadata?.full_name as string) || 'Welile Agent';
  const ownerPhone = (user?.user_metadata?.phone as string) || null;
  const stamp = new Date().toISOString().slice(0, 10);

  const periodLabel = () => {
    if (!dateFrom && !dateTo) return '';
    const from = dateFrom ? format(dateFrom, 'dd MMM yyyy') : 'Start';
    const to = dateTo ? format(dateTo, 'dd MMM yyyy') : 'Today';
    return `Period: ${from} – ${to}`;
  };

  const handlePdf = async () => {
    try {
      const blob = await generateAdvanceStatementPdf({
        ownerName,
        ownerPhone,
        totalOutstanding,
        rows: buildRows(filteredAdvances),
        periodLabel: periodLabel() || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `advance-statement-${stamp}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err: any) {
      toast.error('Could not generate PDF', { description: err?.message });
    }
  };

  const handleExcel = async () => {
    try {
      const rows = buildRows(filteredAdvances);
      await downloadXlsx(
        `advance-statement-${stamp}.xlsx`,
        ['Principal (UGX)', 'Outstanding (UGX)', 'Status', 'Daily (UGX)', 'Days left', 'Access fee (UGX)', 'Issued'],
        rows.map((r) => [
          r.principal,
          r.outstanding_balance,
          r.status,
          r.status === 'completed' ? 0 : r.daily_deduction,
          r.status === 'completed' ? 0 : r.days_left,
          r.access_fee,
          r.issued_at ? new Date(r.issued_at).toLocaleDateString('en-UG') : '',
        ]),
        'Advances',
      );
    } catch (err: any) {
      toast.error('Could not generate Excel file', { description: err?.message });
    }
  };

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="rounded-full bg-primary/15 p-1.5">
              <Banknote className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold leading-none truncate">My Advances</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Funds advanced to you</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {totalOutstanding > 0 && (
              <div className="text-right">
                <p className="text-[9px] uppercase tracking-wide font-bold text-muted-foreground leading-none">Outstanding</p>
                <p className="text-xs sm:text-sm font-black tabular-nums text-amber-600 whitespace-nowrap leading-tight">{formatUGX(totalOutstanding)}</p>
              </div>
            )}
            {!isLoading && advances.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                    <Download className="h-3.5 w-3.5" /> Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handlePdf} className="gap-2 text-xs">
                    <FileText className="h-3.5 w-3.5" /> Download PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExcel} className="gap-2 text-xs">
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Download Excel
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Date range filters */}
        {!isLoading && advances.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 text-xs justify-start", !dateFrom && "text-muted-foreground")}>
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateFrom ? format(dateFrom, 'dd MMM yyyy') : 'From date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 text-xs justify-start", !dateTo && "text-muted-foreground")}>
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateTo ? format(dateTo, 'dd MMM yyyy') : 'To date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateTo} onSelect={setDateTo} initialFocus className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>
            {hasActiveFilter && (
              <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={clearFilters}>
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
            {hasActiveFilter && (
              <span className="text-[11px] text-muted-foreground ml-auto">
                {filteredAdvances.length} of {advances.length}
              </span>
            )}
          </div>
        )}

        {isLoading ? (
          <p className="text-xs text-muted-foreground py-2">Loading your advances…</p>
        ) : filteredAdvances.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            No advances match the selected period.
          </p>
        ) : (
          <div className="space-y-2">
            {filteredAdvances.map((adv: any) => {
              const meta = STATUS_META[adv.status] || STATUS_META.active;
              const Icon = meta.icon;
              const daysLeft = Math.max(0, differenceInDays(new Date(adv.expires_at), new Date()));
              const interest = Math.max(0, Number(adv.outstanding_balance) - Number(adv.principal));
              const dailyDeduction = adv.status !== 'completed'
                ? (daysLeft > 0 ? Math.round(Number(adv.outstanding_balance) / daysLeft) : Number(adv.outstanding_balance))
                : 0;
              return (
                <div key={adv.id} className="rounded-xl bg-muted/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold tabular-nums truncate">{formatUGX(adv.principal)}</span>
                    <Badge variant={meta.variant} className="gap-1 text-[10px]">
                      <Icon className="h-3 w-3" /> {meta.label}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-center">
                    <div>
                      <p className="text-[8px] uppercase tracking-wide font-bold text-muted-foreground leading-none">Owed</p>
                      <p className="text-[11px] font-bold tabular-nums break-all leading-tight mt-0.5">{formatUGX(adv.outstanding_balance)}</p>
                    </div>
                    <div>
                      <p className="text-[8px] uppercase tracking-wide font-bold text-muted-foreground leading-none flex items-center justify-center gap-0.5">
                        <TrendingDown className="h-2.5 w-2.5" /> Daily
                      </p>
                      <p className="text-[11px] font-bold tabular-nums text-red-500 break-all leading-tight mt-0.5">
                        {adv.status === 'completed' ? '—' : formatUGX(dailyDeduction)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[8px] uppercase tracking-wide font-bold text-muted-foreground leading-none">Days left</p>
                      <p className="text-[11px] font-bold tabular-nums leading-tight mt-0.5">{adv.status === 'completed' ? '—' : `${daysLeft}d`}</p>
                    </div>
                  </div>
                  {interest > 0 && adv.status !== 'completed' && (
                    <p className="text-[10px] text-muted-foreground">
                      Includes {formatUGX(interest)} access fee
                    </p>
                  )}
                  {adv.deduction_paused && adv.status !== 'completed' && (
                    <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      Deductions are on hold while this advance is under review. Nothing will be taken from your wallet until it resumes.
                    </p>
                  )}
                  {Number(adv.arrears_balance || 0) > 0 && adv.status !== 'completed' && (
                    <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      ⚠ {formatUGX(Number(adv.arrears_balance))} in missed repayments will be auto-recovered from your next earning(s) before they reach your wallet.
                    </p>
                  )}
                  {Number(adv.prepaid_installments_remaining || 0) > 0 && adv.status !== 'completed' && (
                    <p className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                      ✓ You are paid ahead by {adv.prepaid_installments_remaining} day{Number(adv.prepaid_installments_remaining) === 1 ? '' : 's'} — daily deductions will resume after.
                    </p>
                  )}
                  {adv.status !== 'completed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-8 gap-1.5 text-xs"
                      onClick={() => setPayAheadFor(adv)}
                    >
                      <Zap className="h-3.5 w-3.5" /> Pay ahead
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {payAheadFor && (
        <VoluntaryRepayAdvanceDialog
          open={!!payAheadFor}
          onOpenChange={(o) => { if (!o) setPayAheadFor(null); }}
          advance={payAheadFor}
        />
      )}
    </Card>
  );
}

export default AgentMyAdvancesCard;