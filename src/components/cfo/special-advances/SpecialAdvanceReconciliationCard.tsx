import { CheckCircle2, AlertTriangle, Scale, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { useSpecialAdvanceReconciliation } from '@/hooks/useSpecialAdvances';
import { describeSpecialAdvanceError } from '@/lib/specialAdvances';

export function SpecialAdvanceReconciliationCard({ onOpenAdvance }: { onOpenAdvance?: (ref: string) => void }) {
  const reconQuery = useSpecialAdvanceReconciliation();
  const recon = reconQuery.data;

  if (reconQuery.isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
        Checking sub-ledger and balance-sheet reconciliation...
      </div>
    );
  }

  if (reconQuery.isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive text-center">
        {describeSpecialAdvanceError(reconQuery.error)}
      </div>
    );
  }

  if (!recon) return null;

  const hasA25 = recon.a25_ledger_balance !== undefined;
  const mismatchedAdvances = recon.mismatched_advances ?? [];
  const mismatchedAllowances = recon.mismatched_allowances ?? [];
  const hasMismatches = mismatchedAdvances.length > 0 || mismatchedAllowances.length > 0;

  return (
    <div className="space-y-4">
      {/* Overview reconciliation header card */}
      <section className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Scale className="h-4 w-4" />
            </span>
            <div>
              <h4 className="text-sm font-bold text-foreground">Special Advances Reconciliation</h4>
              <p className="text-[11px] text-muted-foreground">General Ledger accounts vs operational agreements</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge
              variant={recon.balanced ? 'outline' : 'destructive'}
              className={`text-xs px-2.5 py-0.5 font-semibold ${recon.balanced ? 'border-emerald-600/30 text-emerald-600 bg-emerald-500/10' : ''}`}
            >
              {recon.balanced ? (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Reconciled
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> Imbalance detected
                </span>
              )}
            </Badge>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => void reconQuery.refetch()}
              title="Refresh reconciliation"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* 3 Metric Cards: A24, A25, Net */}
        <div className={`grid grid-cols-1 gap-3 sm:grid-cols-${hasA25 ? '3' : '1'}`}>
          {/* Card 1: A24 Gross Receivable */}
          <div className="rounded-xl border border-border/80 bg-muted/20 p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">Account A24 (Gross Receivable)</span>
              <span className="text-[10px] text-muted-foreground font-mono">DR balance</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Ledger balance:</span>
                <span className="font-semibold tabular-nums text-foreground">{formatUGX(recon.a24_ledger_balance)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subledger (active advances):</span>
                <span className="font-semibold tabular-nums text-foreground">{formatUGX(recon.subledger_outstanding)}</span>
              </div>
              <div className="flex justify-between border-t border-border/60 pt-1">
                <span className="text-muted-foreground">Difference:</span>
                <span className={`font-bold tabular-nums ${recon.difference === 0 ? 'text-muted-foreground' : 'text-destructive'}`}>
                  {formatUGX(recon.difference)}
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: A25 Allowance */}
          {hasA25 && (
            <div className="rounded-xl border border-border/80 bg-muted/20 p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground">Account A25 (Impairment Allowance)</span>
                <span className="text-[10px] text-muted-foreground font-mono">CR balance</span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ledger balance:</span>
                  <span className="font-semibold tabular-nums text-foreground">{formatUGX(recon.a25_ledger_balance ?? 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subledger allowance:</span>
                  <span className="font-semibold tabular-nums text-foreground">{formatUGX(recon.allowance_subledger ?? 0)}</span>
                </div>
                <div className="flex justify-between border-t border-border/60 pt-1">
                  <span className="text-muted-foreground">Difference:</span>
                  <span className={`font-bold tabular-nums ${(recon.allowance_difference ?? 0) === 0 ? 'text-muted-foreground' : 'text-destructive'}`}>
                    {formatUGX(recon.allowance_difference ?? 0)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Card 3: Net Receivable */}
          {hasA25 && recon.net_receivable !== undefined && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-foreground">Net Special Advances Receivable</span>
                <span className="text-[10px] text-primary font-medium">A24 less A25</span>
              </div>
              <div className="space-y-1 pt-1">
                <div className="flex justify-between items-baseline">
                  <span className="text-muted-foreground">Net carrying value:</span>
                  <span className="text-base font-bold tabular-nums text-primary">
                    {formatUGX(recon.net_receivable)}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground pt-1">
                  Carried on Statement of Financial Position under Other Assets.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Mismatched Advances list if any */}
      {mismatchedAdvances.length > 0 && (
        <section className="rounded-xl border border-destructive/40 bg-card overflow-hidden">
          <div className="bg-destructive/10 px-4 py-2 text-xs font-semibold text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            <span>Mismatched Advances (Gross A24)</span>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left">Reference</th>
                <th className="px-3 py-1.5 text-left">Status</th>
                <th className="px-3 py-1.5 text-right">Subledger</th>
                <th className="px-3 py-1.5 text-right">Ledger balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 tabular-nums">
              {mismatchedAdvances.map((m, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 font-mono text-primary">{m.reference}</td>
                  <td className="px-3 py-1.5">{m.status}</td>
                  <td className="px-3 py-1.5 text-right">{formatUGX(m.subledger_outstanding)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-destructive">{formatUGX(m.ledger_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Mismatched Allowances list if any */}
      {mismatchedAllowances.length > 0 && (
        <section className="rounded-xl border border-destructive/40 bg-card overflow-hidden">
          <div className="bg-destructive/10 px-4 py-2 text-xs font-semibold text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            <span>Mismatched Allowances (A25 Contra-Asset)</span>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left">Reference</th>
                <th className="px-3 py-1.5 text-left">Status</th>
                <th className="px-3 py-1.5 text-right">Subledger allowance</th>
                <th className="px-3 py-1.5 text-right">Ledger allowance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 tabular-nums">
              {mismatchedAllowances.map((m, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 font-mono text-primary">{m.reference}</td>
                  <td className="px-3 py-1.5">{m.status}</td>
                  <td className="px-3 py-1.5 text-right">{formatUGX(m.allowance_subledger)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-destructive">{formatUGX(m.allowance_ledger)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export default SpecialAdvanceReconciliationCard;
