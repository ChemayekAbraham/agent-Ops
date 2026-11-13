import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { useEffect, useState } from 'react';
import { Bookmark, Home, Loader2, RefreshCw, Trash2, Users } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { formatUGX } from '@/lib/rentCalculations';
import { itemId, toSelectionItem } from './utils';
import { loadFunderSavedItems, type SavedFunderEntry } from './loadFunderSavedItems';
import { FunderBookedHousesSection } from './FunderBookedHousesSection';
import { useFunderSavedTabs } from '@/hooks/useFunderSavedTabs';
import { FUNDER_SAVED_TABS, type FunderSavedTab } from '@/lib/funderSavedTabs';
import { CoSupportInviteRow } from '@/components/co-support/CoSupportWaitingSection';
import { coSupportErrorMessage } from '@/lib/coSupport';

export function FunderSavedItemsDialog({ open, onOpenChange, initialTab: requestedTab }: { open: boolean; onOpenChange: (open: boolean) => void; initialTab?: FunderSavedTab | null }) {
  const tabs = useFunderSavedTabs(open, requestedTab);
  // The last pill is remembered while the dialog stays open.
  const [picked, setPicked] = useState<FunderSavedTab | null>(null);
  useEffect(() => { if (!open) setPicked(null); }, [open]);
  // Fix the opening pill once its counts are in, so it does not move when a count changes
  // (e.g. cancelling the last co-support while looking at the Co-support pill).
  useEffect(() => {
    if (open && picked === null && tabs.ready) setPicked(tabs.initialTab);
  }, [open, picked, tabs.ready, tabs.initialTab]);
  const tab: FunderSavedTab = picked ?? tabs.initialTab;
  // Agent Care: partner amounts use pay(rent) (= rent while the switch is off).
  const { pay: partnerPay } = useSelfSupportFeePolicy();
  const { user } = useAuth();
  const { saved, toggleSave, reconcile } = useFunderSavedItems();
  const client = useQueryClient();
  const [detail, setDetail] = useState<SavedFunderEntry | null>(null);
  const query = useQuery({
    queryKey: ['funder-saved-availability', user?.id, saved],
    enabled: open && !!user,
    queryFn: async ({ signal }) => ({ entries: await loadFunderSavedItems(saved, signal), checked: saved }),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  useEffect(() => {
    if (!open || !query.data || query.isFetching || query.isError) return;
    const available = { empty: [] as string[], ready: [] as string[] };
    query.data.entries.forEach(({ category, item }) => available[category].push(itemId(category, item)));
    reconcile(available, query.data.checked);
  }, [open, query.data, query.isFetching, query.isError, reconcile]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => { void client.invalidateQueries({ queryKey: ['funder-saved-availability', user?.id] }); };
    window.addEventListener('supporter-contribution-changed', refresh);
    return () => window.removeEventListener('supporter-contribution-changed', refresh);
  }, [open, client, user?.id]);
  useEffect(() => { setDetail(null); }, [user?.id]);
  const entries = query.data?.entries.filter(({ category, item }) => saved[category].includes(itemId(category, item))) ?? [];
  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Bookmark className="h-5 w-5 text-primary" />Saved Items</DialogTitle>
          <DialogDescription>Co-supports, bookmarked houses and Rent Plans, and houses booked for you</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Saved Items" className="-mx-1 flex shrink-0 gap-2 overflow-x-auto px-1 pb-1">
          {FUNDER_SAVED_TABS.map(({ id, label }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPicked(id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-muted'}`}
              >
                {label}
                <span className={`min-w-5 rounded-full px-1.5 text-xs font-semibold ${active ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'}`}>{tabs.counts[id]}</span>
              </button>
            );
          })}
        </div>
        <div className="min-h-0 space-y-5 overflow-y-auto">
        {open && tab === 'co_support' ? (
          <section aria-label="Co-support" className="space-y-3">
            {tabs.coSupportLoading ? <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading</div>
              : tabs.coSupportError ? <p className="py-6 text-center text-sm text-destructive">{coSupportErrorMessage(tabs.coSupportError)}</p>
              : tabs.coSupportRows.length === 0 ? <div className="py-8 text-center"><Users className="mx-auto h-9 w-9 text-primary/50" /><p className="mt-3 font-medium">No co-supports yet</p><p className="mt-1 text-sm text-muted-foreground">When you share a Rent Plan or a house with a partner, it shows here.</p></div>
              : <ul className="space-y-2">{tabs.coSupportRows.map((invite) => <CoSupportInviteRow key={invite.id} invite={invite} />)}</ul>}
          </section>
        ) : null}
        {open && tab === 'booked' ? (
          <FunderBookedHousesSection
            onOpenHouse={(house) => {
              setDetail({ category: 'empty', item: house });
              onOpenChange(false);
            }}
          />
        ) : null}
        {tab === 'bookmarked' ? <>
        <section aria-labelledby="bookmarked-h" className="space-y-1">
        <h3 id="bookmarked-h" className="font-semibold">Bookmarked</h3>
        {query.isPending || query.isFetching ? <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Checking availability</div>
          : query.isError ? <div className="space-y-3 py-6 text-center"><p className="text-sm text-destructive">Could not check availability. Your saved items have been kept.</p><Button variant="outline" onClick={() => void query.refetch()}><RefreshCw className="h-4 w-4" />Try again</Button></div>
          : entries.length === 0 ? <div className="py-8 text-center"><Bookmark className="mx-auto h-9 w-9 text-primary/50" /><p className="mt-3 font-medium">No bookmarked items available</p></div>
          : <div className="divide-y divide-border">
            {entries.map((entry) => {
              const info = toSelectionItem(entry.category, entry.item, partnerPay);
              return <article key={`${entry.category}:${info.id}`} className="flex items-center gap-3 py-4">
                <Button variant="ghost" className="h-20 w-20 shrink-0 overflow-hidden rounded-lg p-0" onClick={() => { setDetail(entry); onOpenChange(false); }} aria-label={`View ${info.title}`}>
                  {info.imageUrl ? <img src={info.imageUrl} alt={info.title} className="h-full w-full object-cover" /> : <Home className="h-7 w-7 text-primary" />}
                </Button>
                <div className="min-w-0 flex-1"><p className="text-xs font-medium text-primary">{entry.category === 'empty' ? 'Empty house' : 'Rent Plan'}</p><p className="break-words font-semibold">{info.title}</p><p className="break-words text-xs text-muted-foreground">{info.place}</p><p className="mt-1 text-sm font-semibold">{formatUGX(info.amount)}</p><Button variant="link" className="h-auto p-0 text-xs" onClick={() => { setDetail(entry); onOpenChange(false); }}>View details</Button></div>
                <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive" title="Remove saved item" aria-label={`Remove ${info.title} from saved items`} onClick={() => toggleSave(entry.category, info.id)}><Trash2 className="h-4 w-4" /></Button>
              </article>;
            })}
          </div>}
        </section>
        </> : null}
        </div>
      </DialogContent>
    </Dialog>
    <EmptyHouseDetailSheet house={detail?.category === 'empty' ? detail.item as Parameters<typeof EmptyHouseDetailSheet>[0]['house'] : null} open={detail?.category === 'empty'} onOpenChange={(value) => { if (!value) setDetail(null); }} isPartner />
    <SelfPortfolioPlanDetailSheet plan={detail?.category === 'ready' ? detail.item as Parameters<typeof SelfPortfolioPlanDetailSheet>[0]['plan'] : null} open={detail?.category === 'ready'} onOpenChange={(value) => { if (!value) setDetail(null); }} isFunded={false} />
  </>;
}