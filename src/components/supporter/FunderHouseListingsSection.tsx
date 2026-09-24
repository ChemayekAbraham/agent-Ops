import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Home, ListFilter, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewReviewDialog, FunderNewSelectionBar } from '@/components/funder-new/FunderNewSelectionPanel';
import { useFunderNewLocation } from '@/components/funder-new/useFunderNewLocation';
import { useFunderNewEmptyHouses, useFunderNewReadyPlans } from '@/components/funder-new/useFunderNewOpportunities';
import type {
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewOrigin,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
} from '@/components/funder-new/types';
import { itemId, itemCoordinates, toSelectionItem } from '@/components/funder-new/utils';
import { straightLineDistance } from '@/components/funder-new/distance';

const FILTERS: FunderNewFilters = {
  search: '',
  location: '',
  amount: 'all',
  sort: 'recommended',
  rentMin: null,
  rentMax: null,
  radiusKm: 'all',
  withinFloat: false,
};

interface FeedEntry {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
}

/** House listings grid (same cards and data as /dashboard/funder-new), shown on /dashboard/funder. */
export function FunderHouseListingsSection() {
  const { user } = useAuth();
  const wallet = useWalletBalance(user?.id);
  const location = useFunderNewLocation();
  const origin: FunderNewOrigin | null = null;
  const deviceOrigin = location.coords ? { lat: location.coords.lat, lng: location.coords.lng } : null;

  const emptyQuery = useFunderNewEmptyHouses(FILTERS, origin, true);
  const readyQuery = useFunderNewReadyPlans(FILTERS, true);

  const items = useMemo<FeedEntry[]>(
    () => [
      ...(emptyQuery.data?.pages ?? []).flatMap((p) => p.items).map((item) => ({ category: 'empty' as const, item })),
      ...(readyQuery.data?.pages ?? []).flatMap((p) => p.items).map((item) => ({ category: 'ready' as const, item })),
    ],
    [emptyQuery.data, readyQuery.data],
  );

  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;
  const loading = emptyQuery.isLoading || readyQuery.isLoading;
  const error = emptyQuery.isError && readyQuery.isError;
  const hasNext = emptyQuery.hasNextPage || readyQuery.hasNextPage;
  const fetchingNext = emptyQuery.isFetchingNextPage || readyQuery.isFetchingNextPage;

  const fetchNext = () => {
    if (emptyQuery.hasNextPage) emptyQuery.fetchNextPage();
    else if (readyQuery.hasNextPage) readyQuery.fetchNextPage();
  };

  const toggleSelect = useCallback((category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    const next = toSelectionItem(category, item);
    setSelectedCategory(category);
    setSelectedItems((current) => {
      const same = current.filter((e) => e.category === category);
      const exists = same.some((e) => e.id === next.id);
      const list = exists ? same.filter((e) => e.id !== next.id) : [...same, next];
      if (list.length === 0) setSelectedCategory(null);
      return list;
    });
  }, []);

  const removeSelected = (item: FunderNewSelectionItem) => {
    setSelectedItems((current) => {
      const list = current.filter((e) => !(e.category === item.category && e.id === item.id));
      if (list.length === 0) setSelectedCategory(null);
      return list;
    });
  };

  return (
    <section className="space-y-4">
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>These homes could not be loaded</AlertTitle>
          <AlertDescription>
            Check your connection and try again.
            <Button
              variant="link"
              className="h-auto px-1 py-0"
              onClick={() => {
                emptyQuery.refetch();
                readyQuery.refetch();
              }}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border bg-primary/5 p-8 text-center">
          <ListFilter className="mx-auto h-8 w-8 text-primary/60" aria-hidden />
          <p className="mt-3 text-sm font-semibold">No homes available yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-0 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
            {items.map((entry) => {
              const id = itemId(entry.category, entry.item);
              const coords = itemCoordinates(entry.item, entry.category);
              return (
                <FunderNewHouseCard
                  key={`${entry.category}:${id}`}
                  category={entry.category}
                  item={entry.item}
                  saved={false}
                  selected={selectedItems.some((s) => s.category === entry.category && s.id === id)}
                  distance={coords ? straightLineDistance(deviceOrigin, coords) : null}
                  onSave={() => undefined}
                  onSelect={() => toggleSelect(entry.category, entry.item)}
                  onDetail={() =>
                    entry.category === 'empty'
                      ? setDetailHouse(entry.item as FunderNewEmptyHouse)
                      : setDetailPlan(entry.item as FunderNewReadyPlan)
                  }
                />
              );
            })}
          </div>
          {hasNext ? (
            <div className="flex justify-center">
              <Button className="h-11 rounded-md px-6" onClick={fetchNext} disabled={fetchingNext}>
                {fetchingNext ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Home className="h-4 w-4" aria-hidden />}
                {fetchingNext ? 'Loading' : 'Show more homes'}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(open) => {
          if (!open) setDetailHouse(null);
        }}
        isPicked={detailHouse ? selectedItems.some((i) => i.category === 'empty' && i.id === detailHouse.house_id) : false}
        onTogglePick={(house) => toggleSelect('empty', house as FunderNewEmptyHouse)}
        isPartner
        remaining={availableBalance ?? undefined}
      />
      <SelfPortfolioPlanDetailSheet
        plan={detailPlan}
        open={!!detailPlan}
        onOpenChange={(open) => {
          if (!open) setDetailPlan(null);
        }}
        isFunded={false}
      />
      <FunderNewReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        items={selectedItems}
        available={availableBalance}
        walletLoading={wallet.isLoading}
        walletError={wallet.error}
        onRemove={removeSelected}
      />
      <FunderNewSelectionBar
        items={selectedItems}
        category={selectedCategory}
        onClear={() => {
          setSelectedItems([]);
          setSelectedCategory(null);
        }}
        onReview={() => setReviewOpen(true)}
      />
    </section>
  );
}
