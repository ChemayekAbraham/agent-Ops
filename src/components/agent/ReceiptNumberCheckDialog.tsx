import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Search, Loader2, CheckCircle2, AlertCircle, Receipt } from 'lucide-react';
import { useReceiptLookup } from '@/hooks/useReceiptLookup';
import { usePendingLandlordReceipts, type PendingLandlordReceipt } from '@/hooks/usePendingLandlordReceipts';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

/** "12 min ago", "3 hours ago" — how long a payment has been waiting. */
function ago(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

type RowState = {
  value: string;
  loading: boolean;
  error: string | null;
  confirmed: boolean;
};

/**
 * One row per landlord payment still waiting for its receipt number. The agent
 * types the number the landlord got by SMS; the server matches it against the
 * receipt issued for that exact payment and files it.
 */
function PendingRow({
  payout,
  state,
  setState,
  onConfirmed,
}: {
  payout: PendingLandlordReceipt;
  state: RowState;
  setState: (next: RowState) => void;
  onConfirmed: () => void;
}) {
  const submit = async () => {
    setState({ ...state, loading: true, error: null });
    try {
      const { data, error } = await supabase.functions.invoke('confirm-landlord-payout-receipt', {
        body: { payout_id: payout.id, receipt_number: state.value },
      });
      if (error) {
        let message = 'Could not confirm. Try again.';
        try {
          const ctx = (error as { context?: Response }).context;
          if (ctx) {
            const body = await ctx.json();
            if (body?.error) message = body.error;
          }
        } catch { /* keep the generic message */ }
        setState({ ...state, loading: false, error: message });
        return;
      }
      const res = data as { ok?: boolean; matched?: boolean; already_confirmed?: boolean; message?: string };
      if (res?.matched || res?.already_confirmed) {
        setState({ ...state, loading: false, error: null, confirmed: true });
        onConfirmed();
        return;
      }
      setState({
        ...state,
        loading: false,
        error: res?.message || 'That number does not match this landlord payment.',
      });
    } catch (e) {
      setState({
        ...state,
        loading: false,
        error: e instanceof Error ? e.message : 'Could not confirm. Try again.',
      });
    }
  };

  return (
    <div className="rounded-xl border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{payout.landlord_name || 'Landlord'}</p>
          <p className="text-[11px] text-muted-foreground">
            {formatUGX(payout.amount)} · paid {ago(payout.disbursed_at ?? payout.created_at)}
          </p>
        </div>
        {state.confirmed ? (
          <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 shrink-0">Confirmed</Badge>
        ) : (
          <Badge variant="outline" className="shrink-0">Receipt needed</Badge>
        )}
      </div>

      {!state.confirmed && (
        <>
          <div className="flex gap-2">
            <Input
              value={state.value}
              onChange={e => setState({ ...state, value: e.target.value.toUpperCase(), error: null })}
              placeholder="WLR-XXXXXX or link code"
              className="font-mono h-9"
              autoComplete="off"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (state.value.trim().length >= 4 && !state.loading) void submit();
                }
              }}
            />
            <Button
              size="sm"
              className="h-9"
              disabled={state.loading || state.value.trim().length < 4}
              onClick={() => void submit()}
            >
              {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm'}
            </Button>
          </div>
          {state.error && (
            <p className="text-[11px] text-destructive flex items-start gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {state.error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Agent-facing landlord receipt confirmation.
 *
 * Two modes in one dialog (we can never stack several dialogs, so everything
 * lives here):
 *  - Payments waiting: every recent landlord payout of this agent that still
 *    needs a receipt number, listed with the landlord's name and amount.
 *  - Nothing waiting: the plain receipt-number check, so the agent can still
 *    verify any receipt on demand.
 */
export function ReceiptNumberCheckDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { query, setQuery, loading, result, errorMessage, search, reset } = useReceiptLookup();
  const { pending, pendingCount, loading: pendingLoading, refetch } = usePendingLandlordReceipts(open);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  /** Grace period before the "not yet" escape appears, so the prompt is read. */
  const [canDismiss, setCanDismiss] = useState(false);

  useEffect(() => {
    if (!open) { setCanDismiss(false); return; }
    const id = setTimeout(() => setCanDismiss(true), 15000);
    return () => clearTimeout(id);
  }, [open]);

  const state = (id: string): RowState =>
    rows[id] ?? { value: '', loading: false, error: null, confirmed: false };

  const outstanding = useMemo(
    () => pending.filter(p => !state(p.id).confirmed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, rows],
  );

  const lookupConfirmed = Boolean(result?.ok && result.found);
  /** Locked while a real payment still needs its receipt. */
  const locked = pendingCount > 0 ? outstanding.length > 0 && !canDismiss : !lookupConfirmed;

  const handleOpenChange = (next: boolean) => {
    if (!next && locked) return;
    if (!next) { reset(); setRows({}); }
    onOpenChange(next);
  };

  const hasPending = pendingCount > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={`sm:max-w-md ${locked ? '[&>button]:hidden' : ''}`}
        onEscapeKeyDown={e => { if (locked) e.preventDefault(); }}
        onPointerDownOutside={e => { if (locked) e.preventDefault(); }}
        onInteractOutside={e => { if (locked) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-primary" />
            {hasPending
              ? `${outstanding.length || pendingCount} landlord payment${(outstanding.length || pendingCount) === 1 ? '' : 's'} need a receipt`
              : 'Check a receipt number'}
          </DialogTitle>
          <DialogDescription>
            {hasPending
              ? 'Enter the receipt number each landlord received by SMS after being paid. This reminder comes back every few minutes until every payment has its receipt.'
              : 'Enter a receipt number to confirm it exists in Welile.'}
          </DialogDescription>
        </DialogHeader>

        {pendingLoading && (
          <div className="py-6 text-center">
            <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
          </div>
        )}

        {!pendingLoading && hasPending && (
          <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
            {pending.map(p => (
              <PendingRow
                key={p.id}
                payout={p}
                state={state(p.id)}
                setState={next => setRows(prev => ({ ...prev, [p.id]: next }))}
                onConfirmed={() => { void refetch(); }}
              />
            ))}

            {outstanding.length === 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <p className="text-xs">All landlord payments here now have a receipt. Thank you.</p>
              </div>
            )}
          </div>
        )}

        {!pendingLoading && !hasPending && (
          <form
            className="space-y-3"
            onSubmit={e => { e.preventDefault(); void search(); }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="receipt-number">Receipt number or receipt link code</Label>
              <Input
                id="receipt-number"
                value={query}
                onChange={e => setQuery(e.target.value.toUpperCase())}
                placeholder="WLR-XXXXXX or link code"
                className="font-mono"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">
                The landlord gets this by SMS after being paid. Up to 5 checks per minute.
              </p>
            </div>

            {errorMessage && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{errorMessage}</p>
              </div>
            )}

            {result?.ok && result.found === false && (
              <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
                <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  We could not find <span className="font-mono font-semibold">{result.query}</span>. Check the
                  number and try again.
                </p>
              </div>
            )}

            {result?.ok && result.found && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <div className="text-xs">
                  <p className="font-semibold">
                    Receipt found —{' '}
                    <span className="font-mono">
                      {'receipt_number' in result ? result.receipt_number : ''}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    Status: {'status' in result ? result.status : '—'}
                    {'is_mine' in result && result.is_mine ? ' · issued on your payout' : ''}
                  </p>
                </div>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              {!locked && (
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Close
                </Button>
              )}
              <Button type="submit" disabled={loading || query.trim().length < 4}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Search className="h-4 w-4 mr-1.5" />}
                Submit
              </Button>
            </DialogFooter>
          </form>
        )}

        {hasPending && (
          <DialogFooter className="gap-2 sm:gap-2">
            {!locked ? (
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Waiting for the landlord's SMS? You can close this shortly and it will come back.
              </p>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ReceiptNumberCheckDialog;
