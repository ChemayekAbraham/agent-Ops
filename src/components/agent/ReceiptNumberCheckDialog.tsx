import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Search, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useReceiptLookup } from '@/hooks/useReceiptLookup';

/**
 * Agent-facing receipt check. The agent types the receipt number they were
 * given and we confirm (via a live request) whether it exists in the system.
 * Agents only get existence + status, never payout metadata.
 */
export function ReceiptNumberCheckDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { query, setQuery, loading, result, errorMessage, search, reset } = useReceiptLookup();

  /** The dialog only unlocks once a real receipt has been confirmed. */
  const confirmed = Boolean(result?.ok && result.found);

  const handleOpenChange = (next: boolean) => {
    if (!next && !confirmed) return; // locked: no escape, no outside click, no X
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={`sm:max-w-md ${confirmed ? '' : '[&>button]:hidden'}`}
        onEscapeKeyDown={e => { if (!confirmed) e.preventDefault(); }}
        onPointerDownOutside={e => { if (!confirmed) e.preventDefault(); }}
        onInteractOutside={e => { if (!confirmed) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>Check a receipt number</DialogTitle>
          <DialogDescription>
            Enter the receipt number from the landlord payment and submit to confirm it exists in Welile.
            {confirmed
              ? ' Receipt confirmed — you can close this now.'
              : ' This step is required: the dialog stays open until a valid receipt number is confirmed.'}
          </DialogDescription>
        </DialogHeader>


        <form
          className="space-y-3"
          onSubmit={e => {
            e.preventDefault();
            void search();
          }}
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
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" disabled={loading || query.trim().length < 4}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Search className="h-4 w-4 mr-1.5" />}
              Submit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ReceiptNumberCheckDialog;
