import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search, Receipt, Loader2, ExternalLink, Copy, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useReceiptLookup } from '@/hooks/useReceiptLookup';

function formatUGX(n: number) {
  return `UGX ${Number(n || 0).toLocaleString()}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs font-medium text-right break-all">{value ?? '—'}</span>
    </div>
  );
}

/**
 * CFO / FinOps receipt-number tracker for landlord float payouts.
 * Accepts the WLR- receipt number, the receipt code, the public short link
 * code, or the agent-submitted provider transaction id.
 */
export function ReceiptNumberLookupPanel({ className }: { className?: string }) {
  const { query, setQuery, loading, result, errorMessage, search } = useReceiptLookup();
  const [expanded, setExpanded] = useState(true);

  const full = result && result.ok && result.found && result.scope === 'full' ? result : null;
  const snapshot = (full?.snapshot ?? {}) as Record<string, any>;
  const shortLink = full?.receipt_code ? `${window.location.origin}/r/${full.receipt_code}` : null;

  return (
    <Card className={className}>
      <div className="p-4 space-y-3">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center gap-2 text-left"
        >
          <Receipt className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold">Track a receipt number</span>
          <Badge variant="secondary" className="ml-auto text-[10px]">Landlord payouts</Badge>
        </button>

        {expanded && (
          <>
            <p className="text-xs text-muted-foreground">
              Search by receipt number (WLR-…), receipt code, short-link code, or the provider transaction ID
              submitted by the agent. Limited to 5 searches per minute.
            </p>

            <form
              className="flex gap-2"
              onSubmit={e => {
                e.preventDefault();
                void search();
              }}
            >
              <Input
                value={query}
                onChange={e => setQuery(e.target.value.toUpperCase())}
                placeholder="WLR-XXXXXX"
                className="font-mono text-sm"
                autoComplete="off"
              />
              <Button type="submit" disabled={loading || query.trim().length < 4}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="ml-1.5 hidden sm:inline">Search</span>
              </Button>
            </form>

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
                  No receipt matches <span className="font-mono font-semibold">{result.query}</span>. Either the
                  payout was never confirmed as disbursed, or the number is mistyped.
                </p>
              </div>
            )}

            {result?.ok && result.found && result.scope === 'basic' && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <p className="text-xs">
                  Receipt <span className="font-mono font-semibold">{result.receipt_number}</span> exists
                  ({result.status}).
                </p>
              </div>
            )}

            {full && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold">{full.receipt_number}</p>
                    <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
                      {formatUGX(full.amount)}
                    </p>
                  </div>
                  <Badge variant={full.status === 'completed' ? 'default' : 'destructive'}>{full.status}</Badge>
                </div>

                <div className="pt-1">
                  <Row label="Landlord" value={snapshot.landlord_name ?? full.landlord_id} />
                  <Row label="Landlord phone" value={full.landlord_phone} />
                  <Row label="Tenant" value={snapshot.tenant_name ?? full.tenant_id} />
                  <Row label="Property" value={snapshot.property_label} />
                  <Row label="Processed by" value={snapshot.processed_by_name ?? full.processed_by} />
                  <Row label="Agent" value={snapshot.agent_name ?? full.agent_id} />
                  <Row label="Processor" value={snapshot.processor ?? snapshot.mobile_money_provider} />
                  <Row label="Provider reference" value={full.payout?.provider_reference} />
                  <Row label="Payout status" value={full.payout?.status} />
                  <Row
                    label="Disbursed"
                    value={full.payout?.disbursed_at ? format(new Date(full.payout.disbursed_at), 'dd MMM yyyy HH:mm') : '—'}
                  />
                  <Row
                    label="Receipt issued"
                    value={full.generated_at ? format(new Date(full.generated_at), 'dd MMM yyyy HH:mm') : '—'}
                  />
                  <Row
                    label="SMS"
                    value={
                      full.sms_sent_at
                        ? `Sent ${format(new Date(full.sms_sent_at), 'dd MMM HH:mm')} (${full.sms_attempts ?? 0} attempt${(full.sms_attempts ?? 0) === 1 ? '' : 's'})`
                        : full.sms_last_error
                          ? `Failed — ${full.sms_last_error}`
                          : 'Not sent'
                    }
                  />
                </div>

                {shortLink && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="outline" asChild>
                      <a href={`/r/${full.receipt_code}`} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                        Open receipt
                      </a>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await navigator.clipboard.writeText(shortLink);
                        toast.success('Receipt link copied');
                      }}
                    >
                      <Copy className="h-3.5 w-3.5 mr-1.5" />
                      Copy link
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export default ReceiptNumberLookupPanel;
