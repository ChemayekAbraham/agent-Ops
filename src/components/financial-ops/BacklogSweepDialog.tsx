import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, History, CheckCircle2, AlertTriangle, Zap, FileDown } from 'lucide-react';

const UGX = (n: number) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;

type Outcome =
  | 'debited' | 'partial' | 'skipped_no_recipient' | 'skipped_ambiguous'
  | 'skipped_no_balance' | 'skipped_already_routed' | 'skipped_withdrawal_settled' | 'error';

interface ReportRow {
  gmail_transaction_id: string;
  transaction_id: string | null;
  from_name: string | null;
  from_email: string | null;
  counterparty: string | null;
  internal_date: string | null;
  amount: number;
  outcome: Outcome;
  match_method?: 'phone' | 'name' | null;
  target_user_name?: string | null;
  debited_amount?: number | null;
  available_balance?: number | null;
  detail?: string | null;
  via_proxy?: boolean;
  proxy_for_name?: string | null;
}

interface SweepResult {
  ok: boolean;
  dry_run: boolean;
  summary: {
    candidates: number; debited: number; partial: number;
    skipped: number; errors: number; total_debited: number;
  };
  report: ReportRow[];
  error?: string;
}

const OUTCOME_META: Record<Outcome, { label: string; cls: string }> = {
  debited: { label: 'Debited', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  partial: { label: 'Partial', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  skipped_no_recipient: { label: 'No recipient', cls: 'bg-muted text-muted-foreground' },
  skipped_ambiguous: { label: 'Ambiguous', cls: 'bg-muted text-muted-foreground' },
  skipped_no_balance: { label: 'No balance', cls: 'bg-muted text-muted-foreground' },
  skipped_already_routed: { label: 'Already routed', cls: 'bg-muted text-muted-foreground' },
  skipped_withdrawal_settled: { label: 'Withdrawal settled', cls: 'bg-muted text-muted-foreground' },
  error: { label: 'Error', cls: 'bg-destructive/15 text-destructive' },
};

export function BacklogSweepLauncher() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);

  const runSweep = async (dryRun: boolean) => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke('sweep-payout-debits', {
        body: { dry_run: dryRun, days_back: 30, max_rows: 200 },
      });
      if (error) throw error;
      const res = data as SweepResult;
      if (!res?.ok) throw new Error(res?.error || 'Sweep failed');
      setResult(res);
      toast({
        title: dryRun ? 'Dry run complete' : 'Sweep complete',
        description: `${res.summary.debited + res.summary.partial} debited · ${res.summary.skipped} skipped · ${res.summary.errors} errors`,
      });
    } catch (e: any) {
      toast({ title: 'Sweep failed', description: e?.message ?? String(e), variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  };

  const exportCsv = () => {
    if (!result?.report?.length) return;
    const head = ['date', 'from', 'counterparty', 'recipient', 'match', 'amount', 'debited', 'available', 'outcome', 'detail'];
    const lines = result.report.map((r) => [
      r.internal_date ?? '',
      (r.from_name || r.from_email || '').replace(/[",]/g, ' '),
      (r.counterparty ?? '').replace(/[",]/g, ' '),
      (r.target_user_name ?? '').replace(/[",]/g, ' '),
      r.match_method ?? '',
      r.amount,
      r.debited_amount ?? '',
      r.available_balance ?? '',
      r.outcome,
      (r.detail ?? '').replace(/[",]/g, ' '),
    ].join(','));
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `payout-sweep-${new Date().toISOString().slice(0, 10)}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of every row swept -- names, amounts, balances -- not
    // logged before this. Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, row_count: result.report.length },
        });
      } catch (e) {
        console.warn('[BacklogSweepDialog] audit log insert failed:', e);
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 flex-1 sm:flex-none min-w-[120px]">
          <Zap className="h-4 w-4" /> Sweep backlog
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" /> Backlog payout sweep
          </DialogTitle>
          <DialogDescription>
            Finds previously parsed outgoing payout emails (last 30 days) that were never
            auto-debited and safely charges each one against the recipient's wallet.
            Idempotent, single-recipient only, and clamped to available balance.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => runSweep(true)} disabled={running} variant="outline" className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Dry run (preview)
          </Button>
          <Button onClick={() => runSweep(false)} disabled={running} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Run sweep & debit
          </Button>
          {result?.report?.length ? (
            <Button onClick={exportCsv} variant="ghost" className="gap-2 ml-auto">
              <FileDown className="h-4 w-4" /> Export report
            </Button>
          ) : null}
        </div>

        {result && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              {result.dry_run && (
                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" /> Dry run — nothing posted
                </Badge>
              )}
              <Badge variant="secondary">Candidates: {result.summary.candidates}</Badge>
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                Debited: {result.summary.debited}
              </Badge>
              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Partial: {result.summary.partial}
              </Badge>
              <Badge variant="secondary">Skipped: {result.summary.skipped}</Badge>
              {result.summary.errors > 0 && (
                <Badge variant="destructive">Errors: {result.summary.errors}</Badge>
              )}
              <Badge variant="outline">Total: {UGX(result.summary.total_debited)}</Badge>
            </div>

            {result.report.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No un-debited payout emails found in the window. Backlog is clean.
              </p>
            ) : (
              <div className="rounded-lg border divide-y">
                {result.report.map((r) => {
                  const meta = OUTCOME_META[r.outcome];
                  return (
                    <div key={r.gmail_transaction_id} className="p-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge className={meta.cls}>{meta.label}</Badge>
                      <span className="font-medium">
                        {r.target_user_name || r.counterparty || '—'}
                      </span>
                      {r.via_proxy && (
                        <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-600 dark:text-amber-300">
                          proxy for {r.proxy_for_name || 'partner'}
                        </Badge>
                      )}
                      <span className="text-muted-foreground">
                        {UGX(r.amount)}
                        {r.debited_amount != null && r.debited_amount !== r.amount
                          ? ` → ${UGX(r.debited_amount)}`
                          : ''}
                      </span>
                      {r.match_method && (
                        <span className="text-[11px] text-muted-foreground">({r.match_method} match)</span>
                      )}
                      {r.internal_date && (
                        <span className="text-[11px] text-muted-foreground ml-auto">
                          {new Date(r.internal_date).toLocaleString()}
                        </span>
                      )}
                      {r.detail && (
                        <span className="w-full text-[11px] text-muted-foreground">{r.detail}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
