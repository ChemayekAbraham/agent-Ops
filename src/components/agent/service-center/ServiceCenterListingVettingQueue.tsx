import { useState } from 'react';
import { CheckCircle2, Eye, Home, Loader2, MapPin, Phone, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { HouseDetailsDialog } from '@/components/agent/service-center/HouseDetailsDialog';
import {
  ServiceCenterListing,
  useServiceCenterListingQueue,
  useServiceCenterReviewListing,
} from '@/hooks/useServiceCenterListingQueue';
import { matchesVettingQuery } from '@/components/agent/service-center/matchesVettingQuery';

/**
 * Listings vetting queue — a Service Centre manager checks every house their
 * agents list before Landlord Ops performs the final verification.
 */
export function ServiceCenterListingVettingQueue({ searchQuery = '' }: { searchQuery?: string } = {}) {
  const { data = [], isLoading, error } = useServiceCenterListingQueue();
  const review = useServiceCenterReviewListing();
  const { toast } = useToast();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [detailsRow, setDetailsRow] = useState<ServiceCenterListing | null>(null);

  /** Landlord Ops reads this comment during final verification, so it is required. */
  const MIN_COMMENT = 10;
  const commentFor = (id: string) => (comments[id] ?? '').trim();

  const act = async (row: ServiceCenterListing, decision: 'pass' | 'return', comment?: string) => {
    setBusyId(row.id);
    try {
      await review.mutateAsync({ listingId: row.id, decision, comment });
      toast({
        title: decision === 'pass' ? 'Sent to Landlord Ops' : 'Returned to agent',
        description:
          decision === 'pass'
            ? `${row.title ?? 'The house'} now awaits final verification.`
            : `${row.agent_name ?? 'The agent'} must fix and resubmit this listing.`,
      });
      setComments((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
    } catch (e: any) {
      toast({ title: 'Could not save', description: e?.message ?? 'Please try again.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const filtered = data.filter((row) =>
    matchesVettingQuery(searchQuery, row.agent_name, row.agent_phone, row.landlord_name, row.landlord_phone, row.title, row.village, row.district),
  );

  if (isLoading) {
    return <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>;
  }

  if (error) {
    return (
      <Card><CardContent className="p-4">
        <p className="text-sm font-semibold text-destructive">Could not load the listings vetting queue</p>
        <p className="mt-1 break-words text-xs text-destructive/90">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Home className="h-4 w-4" /> Houses awaiting your vetting
        </h3>
        <Badge variant={filtered.length ? 'default' : 'outline'}>{filtered.length}</Badge>
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          {searchQuery.trim()
            ? 'No houses match that search.'
            : 'No houses waiting on you. New listings from your agents will appear here first.'}
        </CardContent></Card>
      ) : (
        filtered.map((row) => (
          <Card key={row.id}>
            <CardContent className="space-y-2.5 p-3">
               <button type="button" onClick={() => setDetailsRow(row)} className="flex w-full items-start gap-3 text-left">
                {row.images?.[0] ? (
                  <img
                    src={row.images[0]}
                    alt={row.title ?? 'House photo'}
                    loading="lazy"
                    className="h-16 w-16 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Home className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{row.title ?? 'Untitled house'}</p>
                  <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    {[row.village, row.address, row.district].filter(Boolean).join(', ') || 'No location captured'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatUGX(Number(row.rent_amount ?? 0))}
                    {row.bedrooms ? ` · ${row.bedrooms} bedroom${row.bedrooms === 1 ? '' : 's'}` : ''}
                    {row.latitude && row.longitude ? ' · GPS captured' : ' · no GPS'}
                  </p>
                  <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                    <Eye className="h-3 w-3" /> View photos & full details
                    {row.images?.length ? ` (${row.images.length} photo${row.images.length === 1 ? '' : 's'})` : ''}
                  </span>
                </div>
              </button>

              <div className="grid gap-1 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground sm:grid-cols-2">
                <span>Listed by <span className="font-medium text-foreground">{row.agent_name ?? 'Unknown agent'}</span></span>
                {row.agent_phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{row.agent_phone}</span>}
                <span>Landlord <span className="font-medium text-foreground">{row.landlord_name ?? 'Not linked'}</span></span>
                {row.landlord_phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{row.landlord_phone}</span>}
              </div>

              <div className="space-y-2">
                <Textarea
                  value={comments[row.id] ?? ''}
                  onChange={(e) => setComments((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  placeholder="Your comment (required) — what you checked, or what the agent must fix. Landlord Ops will read this."
                  rows={3}
                  className="text-sm"
                />
                <p className="text-[11px] text-muted-foreground">
                  {commentFor(row.id).length < MIN_COMMENT
                    ? `Write at least ${MIN_COMMENT} characters to pass or return (${commentFor(row.id).length}/${MIN_COMMENT}).`
                    : 'Comment saved with your decision for Landlord Ops.'}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={busyId === row.id || commentFor(row.id).length < MIN_COMMENT}
                    onClick={() => act(row, 'pass', commentFor(row.id))}
                  >
                    {busyId === row.id
                      ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                    Pass to Landlord Ops
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    disabled={busyId === row.id || commentFor(row.id).length < MIN_COMMENT}
                    onClick={() => act(row, 'return', commentFor(row.id))}
                  >
                    <XCircle className="mr-1.5 h-3.5 w-3.5" /> Return to agent
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      <HouseDetailsDialog
        open={!!detailsRow}
        onOpenChange={(v) => { if (!v) setDetailsRow(null); }}
        listingId={detailsRow?.id}
        title={detailsRow?.title}
        images={detailsRow?.images}
        extras={[
          { label: 'Listed by', value: detailsRow?.agent_name },
          { label: 'Agent phone', value: detailsRow?.agent_phone },
          { label: 'Landlord', value: detailsRow?.landlord_name ?? 'Not linked' },
          { label: 'Landlord phone', value: detailsRow?.landlord_phone },
        ]}
      />
    </div>
  );
}