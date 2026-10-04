import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2, Scale } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useMerchantFloatLedgerVariance } from '@/hooks/useMerchantFloat';

/**
 * PHASE 10 — merchant float truth check.
 *
 * The books (`general_ledger`, read through `v_user_wallet_strict`) are the
 * source of truth. `merchant_float_reconciliations` entries are display-only
 * notes and can never make this panel look correct: the figures below come
 * straight from the stored wallet cache versus the ledger-derived float.
 */
export function MerchantFloatTruthPanel() {
  const { data, isLoading, error } = useMerchantFloatLedgerVariance();

  const rows = data ?? [];
  const mismatched = rows.filter((r) => r.varianceState !== 'aligned');
  const worst = mismatched.slice(0, 12);

  if (error) return null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Scale className="h-4 w-4 text-primary" />
          Agent float: board vs books
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The books are the truth. A fix note never changes the books — if a row below disagrees, the
          books must be corrected, not the display.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Checking…</p>
        ) : mismatched.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
            <p className="text-xs text-muted-foreground">
              All {rows.length} cash-out desks match the books.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
              <p className="text-xs font-medium text-destructive">
                {mismatched.length} desk{mismatched.length === 1 ? '' : 's'} do not match the books.
              </p>
            </div>
            <div className="space-y-2">
              {worst.map((r) => (
                <div key={r.deskId} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground truncate">
                      {r.agentName || r.label || 'Cash-out desk'}
                    </p>
                    <Badge variant="destructive" className="text-[10px] shrink-0">
                      {r.varianceState === 'stored_above_ledger' ? 'Board too high' : 'Board too low'}
                    </Badge>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-2 text-[10px]">
                    <Figure label="Board shows" value={r.storedFloat} />
                    <Figure label="Books show" value={r.ledgerFloat} />
                    <Figure label="Gap" value={r.variance} highlight />
                  </div>
                  {r.adjustmentCount > 0 && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {r.adjustmentCount} display-only fix{r.adjustmentCount === 1 ? '' : 'es'} recorded
                      ({formatUGX(r.displayOnlyAdjustments)}) — none of them moved money.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <p className="uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 font-mono text-[11px] font-bold tabular-nums ${
          highlight ? 'text-destructive' : 'text-foreground'
        }`}
      >
        {formatUGX(value)}
      </p>
    </div>
  );
}

export default MerchantFloatTruthPanel;
