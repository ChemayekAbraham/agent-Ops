import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  useLandlordPriorityBreakdown,
  useLandlordPriorityItems,
  type CounterWindow,
  type LandlordPriorityBucket,
  type LandlordPriorityItem,
} from '@/hooks/useWelileOpsCounters';
import { Home, Users, ChevronRight, Phone, MapPin, ListChecks, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

interface Props {
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onOpenLandlord: (id: string) => void;
  onOpenAgent: (id: string) => void;
}

const BUCKET_TITLE: Record<LandlordPriorityBucket, string> = {
  priority1: 'Priority 1 — Empty houses (no tenant placed)',
  priority2: 'Priority 2 — Placed tenants',
  listed_empty: 'Priority 1 — Listed but still empty',
  unlisted: 'Priority 1 — Registered, no house listed yet',
};

export function LandlordPriorityClassification({ win, refetchIntervalMs, onOpenLandlord, onOpenAgent }: Props) {
  const { data, isLoading } = useLandlordPriorityBreakdown(win, refetchIntervalMs);
  const [bucket, setBucket] = useState<LandlordPriorityBucket | null>(null);

  if (isLoading || !data) {
    return <Skeleton className="h-28 w-full mt-2" />;
  }

  const placedPct = data.total_landlords > 0 ? Math.round((data.priority2_placed / data.total_landlords) * 100) : 0;

  return (
    <div className="rounded-xl border border-border bg-card p-3 mt-2">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
          <Home className="h-3.5 w-3.5 text-[#9234EA]" /> Landlords by agents — priority classification
        </span>
        <Badge variant="outline" className="text-[10px]">{data.total_landlords.toLocaleString()} registered</Badge>
      </div>

      {/* P1 vs P2 split */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setBucket('priority1')}
          className="rounded-lg border border-[#9234EA]/30 bg-[#9234EA]/10 p-2.5 text-left hover:ring-1 hover:ring-[#9234EA]/40 transition"
        >
          <p className="text-[9px] font-bold uppercase tracking-wide text-[#9234EA] leading-none">Priority 1 · Empty houses</p>
          <p className="text-2xl font-bold leading-none text-[#9234EA] mt-1">{data.priority1_empty.toLocaleString()}</p>
          <p className="text-[10px] text-muted-foreground mt-1">no tenant placed yet →</p>
        </button>
        <button
          type="button"
          onClick={() => setBucket('priority2')}
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-left hover:ring-1 hover:ring-emerald-500/40 transition"
        >
          <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-600 leading-none">Priority 2 · Placed tenants</p>
          <p className="text-2xl font-bold leading-none text-emerald-600 mt-1">{data.priority2_placed.toLocaleString()}</p>
          <p className="text-[10px] text-muted-foreground mt-1">{placedPct}% of registered →</p>
        </button>
      </div>

      {/* P1 sub-breakdown */}
      <div className="grid grid-cols-2 gap-2 mt-2">
        <button
          type="button"
          onClick={() => setBucket('listed_empty')}
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-left hover:ring-1 hover:ring-amber-500/40 transition"
        >
          <p className="text-[10px] font-semibold text-amber-700 flex items-center gap-1"><ListChecks className="h-3 w-3" /> Listed, still empty</p>
          <p className="text-base font-bold text-amber-700 leading-none mt-0.5">{data.p1_listed_empty.toLocaleString()}</p>
        </button>
        <button
          type="button"
          onClick={() => setBucket('unlisted')}
          className="rounded-lg border border-border bg-muted/40 p-2 text-left hover:ring-1 hover:ring-primary/40 transition"
        >
          <p className="text-[10px] font-semibold text-muted-foreground flex items-center gap-1"><UserPlus className="h-3 w-3" /> No house listed yet</p>
          <p className="text-base font-bold leading-none mt-0.5">{data.p1_unlisted.toLocaleString()}</p>
        </button>
      </div>

      <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
        Every registered landlord without a placed tenant is Priority 1. The {data.p1_unlisted.toLocaleString()} with no house listed
        are the biggest opportunity — agents must list their empty houses to move them into the funnel.
      </p>

      <LandlordBucketDialog
        bucket={bucket}
        win={win}
        refetchIntervalMs={refetchIntervalMs}
        onClose={() => setBucket(null)}
        onOpenLandlord={(id) => { setBucket(null); onOpenLandlord(id); }}
        onOpenAgent={(id) => { setBucket(null); onOpenAgent(id); }}
      />
    </div>
  );
}

export function LandlordBucketDialog({
  bucket, win, refetchIntervalMs, onClose, onOpenLandlord, onOpenAgent,
}: {
  bucket: LandlordPriorityBucket | null;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  onOpenLandlord: (id: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const { data, isLoading } = useLandlordPriorityItems(bucket, win, !!bucket, refetchIntervalMs);
  const items: LandlordPriorityItem[] = data ?? [];

  return (
    <Dialog open={!!bucket} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">{bucket ? BUCKET_TITLE[bucket] : ''}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-1">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No landlords in this group.</p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((l) => (
                <li key={l.landlord_id} className="rounded-lg border border-border bg-card p-3">
                  <div
                    className="flex items-center gap-2 cursor-pointer"
                    onClick={() => onOpenLandlord(l.landlord_id)}
                  >
                    <span className="font-semibold text-sm truncate flex-1">{l.landlord_name || 'Unnamed landlord'}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </div>
                  {l.landlord_phone && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Phone className="h-3 w-3" /> {l.landlord_phone}
                    </p>
                  )}
                  {l.property_address && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <MapPin className="h-3 w-3" /> {l.property_address}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <Badge
                      variant="outline"
                      className={cn('text-[10px]', l.placed ? 'text-emerald-600 border-emerald-500/40' : 'text-[#9234EA] border-[#9234EA]/40')}
                    >
                      {l.placed ? <Users className="h-3 w-3 mr-1" /> : <Home className="h-3 w-3 mr-1" />}
                      {l.placed ? 'Placed' : 'Empty'}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {l.listing_count.toLocaleString()} listed · {l.empty_listing_count.toLocaleString()} empty
                    </span>
                    {l.agent_id && (
                      <button
                        type="button"
                        onClick={() => onOpenAgent(l.agent_id as string)}
                        className="text-[10px] font-semibold text-primary hover:underline ml-auto"
                      >
                        by {l.agent_name || 'agent'}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Registered {fmtDate(l.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}