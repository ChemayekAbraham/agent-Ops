import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  HelpCircle,
  ListFilter,
  Search,
  SlidersHorizontal,
  Wallet,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHero } from '@/components/funder-new/FunderNewHero';
import { FunderNewMapSection } from '@/components/funder-new/FunderNewMapSection';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewCalculatorDialog } from '@/components/funder-new/FunderNewCalculatorDialog';
import { FunderNewHowItWorksDialog } from '@/components/funder-new/FunderNewHowItWorksDialog';
import { FunderNewReviewDialog, FunderNewSelectionBar } from '@/components/funder-new/FunderNewSelectionPanel';
import {
  useFunderNewEmptyHouses,
  useFunderNewMarketSummary,
  useFunderNewReadyPlans,
} from '@/components/funder-new/useFunderNewOpportunities';
import type {
  AmountBucket,
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
} from '@/components/funder-new/types';
import { categoryLabel, toSelectionItem } from '@/components/funder-new/utils';
import { formatDynamic } from '@/lib/currencyFormat';

const INITIAL_LIMIT = 6;
const EXPANDED_LIMIT = 60;
const SAVED_KEY = 'rentflow:funder-new:saved:v1';

interface SavedState {
  empty: string[];
  ready: string[];
}

const DEFAULT_SAVED: SavedState = { empty: [], ready: [] };

function readSaved(): SavedState {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    if (!raw) return DEFAULT_SAVED;
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      empty: Array.isArray(parsed.empty) ? parsed.empty.filter((id): id is string => typeof id === 'string') : [],
      ready: Array.isArray(parsed.ready) ? parsed.ready.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return DEFAULT_SAVED;
  }
}

function saveSaved(value: SavedState) {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(value));
  } catch {
    // Route-scoped saved state is a browsing aid only.
  }
}

function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/10">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function HouseGrid({
  category,
  filters,
  savedIds,
  selectedIds,
  highlightIds,
  onSave,
  onSelect,
  onDetail,
  onItemsChange,
}: {
  category: FunderNewCategory;
  filters: FunderNewFilters;
  savedIds: string[];
  selectedIds: string[];
  highlightIds: string[];
  onSave: (category: FunderNewCategory, id: string) => void;
  onSelect: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => void;
  onDetail: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => void;
  onItemsChange: (items: Array<FunderNewEmptyHouse | FunderNewReadyPlan>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? EXPANDED_LIMIT : INITIAL_LIMIT;
  const empty = useFunderNewEmptyHouses(filters, limit, category === 'empty');
  const ready = useFunderNewReadyPlans(filters, limit, category === 'ready');
  const query = category === 'empty' ? empty : ready;
  const items = (query.data?.items ?? []) as Array<FunderNewEmptyHouse | FunderNewReadyPlan>;

  useEffect(() => {
    onItemsChange(items);
  }, [items, onItemsChange]);

  useEffect(() => {
    setExpanded(false);
  }, [category, filters.amount, filters.location, filters.search]);

  if (query.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: INITIAL_LIMIT }).map((_, index) => (
          <Skeleton key={index} className="h-[26rem] rounded-2xl" />
        ))}
      </div>
    );
  }

  if (query.error) {
    return (
      <ErrorState
        title={`${categoryLabel(category)} unavailable`}
        message="This list could not be loaded, so nothing has been replaced with zero. Try again in a moment."
      />
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-3xl border bg-primary/5 p-10 text-center">
        <ListFilter className="mx-auto h-9 w-9 text-primary/60" />
        <p className="mt-4 text-base font-semibold">No homes match yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Try a different area, amount, or clear your filters.</p>
      </div>
    );
  }

  const canShowMore = !expanded && (query.data?.total ?? 0) > INITIAL_LIMIT;

  return (
    <div className="space-y-5">
      <div
        className={query.isFetching ? 'grid gap-4 opacity-70 transition-opacity sm:grid-cols-2 lg:grid-cols-3' : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3'}
      >
        {items.map((item) => {
          const id =
            category === 'empty'
              ? (item as FunderNewEmptyHouse).house_id
              : (item as FunderNewReadyPlan).rent_request_id;
          return (
            <FunderNewHouseCard
              key={id}
              category={category}
              item={item}
              saved={savedIds.includes(id)}
              selected={selectedIds.includes(id)}
              highlighted={highlightIds.includes(id)}
              onSave={() => onSave(category, id)}
              onSelect={() => onSelect(category, item)}
              onDetail={() => onDetail(category, item)}
            />
          );
        })}
      </div>
      {canShowMore ? (
        <div className="flex justify-center">
          <Button variant="outline" className="h-12 rounded-full px-8" onClick={() => setExpanded(true)}>
            View all homes
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function FunderDashboardNew() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const wallet = useWalletBalance(user?.id);
  const summary = useFunderNewMarketSummary();
  const [tab, setTab] = useState<FunderNewCategory>('empty');
  const [filters, setFilters] = useState<FunderNewFilters>({ search: '', location: '', amount: 'all' });
  const [saved, setSaved] = useState<SavedState>(() => readSaved());
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [listItems, setListItems] = useState<Array<FunderNewEmptyHouse | FunderNewReadyPlan>>([]);
  const [mapHouses, setMapHouses] = useState<FunderNewEmptyHouse[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  useEffect(() => {
    saveSaved(saved);
  }, [saved]);

  const activeSelectedIds = useMemo(
    () => selectedItems.filter((item) => item.category === tab).map((item) => item.id),
    [selectedItems, tab],
  );

  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;
  const filtersActive = filters.search.trim() !== '' || filters.location.trim() !== '' || filters.amount !== 'all';

  const toggleSave = (category: FunderNewCategory, id: string) => {
    setSaved((current) => {
      const list = current[category];
      const nextList = list.includes(id) ? list.filter((savedId) => savedId !== id) : [...list, id];
      return { ...current, [category]: nextList };
    });
  };

  const toggleSelect = (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    const next = toSelectionItem(category, item);
    setSelectedCategory((current) => (current && current !== category ? category : current ?? category));
    setSelectedItems((current) => {
      const sameCategory = current.filter((entry) => entry.category === category);
      const exists = sameCategory.some((entry) => entry.id === next.id);
      const nextList = exists ? sameCategory.filter((entry) => entry.id !== next.id) : [...sameCategory, next];
      if (nextList.length === 0) setSelectedCategory(null);
      return nextList;
    });
  };

  const removeSelected = (item: FunderNewSelectionItem) => {
    setSelectedItems((current) => {
      const nextList = current.filter((entry) => !(entry.category === item.category && entry.id === item.id));
      if (nextList.length === 0) setSelectedCategory(null);
      return nextList;
    });
  };

  const openDetail = (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    if (category === 'empty') {
      setDetailHouse(item as FunderNewEmptyHouse);
      return;
    }
    setDetailPlan(item as FunderNewReadyPlan);
  };

  const openDetailById = (id: string) => {
    const found = listItems.find((item) =>
      tab === 'empty'
        ? (item as FunderNewEmptyHouse).house_id === id
        : (item as FunderNewReadyPlan).rent_request_id === id,
    );
    if (found) openDetail(tab, found);
  };

  const scrollToMap = useCallback(() => {
    document.getElementById('funder-new-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className="min-h-screen bg-background pb-32 text-foreground">
      <header className="border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                RentFlow Insights review
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Find a home to support</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {user?.user_metadata?.full_name
                  ? `${user.user_metadata.full_name}, review live homes without changing the current dashboard.`
                  : 'Review live homes without changing the current dashboard.'}
              </p>
            </div>
            <div className="grid gap-2 sm:flex sm:items-center">
              <div className="rounded-xl border bg-card px-4 py-2">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Wallet className="h-3.5 w-3.5" /> Available balance
                </p>
                <p className="text-sm font-semibold">
                  {wallet.error ? 'Unavailable' : wallet.isLoading ? 'Loading…' : formatDynamic(wallet.withdrawable)}
                </p>
              </div>
              <Button variant="outline" className="rounded-xl" onClick={() => navigate('/dashboard/funder')}>
                Current dashboard
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-10 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <FunderNewHero
          summary={summary.data}
          isLoading={summary.isLoading}
          hasError={!!summary.error}
          onExploreMap={scrollToMap}
          onHowItWorks={() => setHowOpen(true)}
        />

        <FunderNewMapSection
          houses={mapHouses}
          filters={filters}
          summary={summary.data}
          selectedIds={selectedItems.filter((item) => item.category === 'empty').map((item) => item.id)}
          availableBalance={availableBalance ?? 0}
          onSearchChange={(search) => setFilters((current) => ({ ...current, search }))}
          onOpenHouse={(house) => openDetail('empty', house)}
          onHousesDiscovered={(houses) => {
            setMapHouses((current) => {
              const merged = new Map(current.map((house) => [house.house_id, house]));
              houses.forEach((house) => merged.set(house.house_id, house));
              return [...merged.values()];
            });
          }}
        />

        <section className="space-y-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Homes you can support</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Save homes for later, or select the ones you want to review together.
              </p>
            </div>
            <Button variant="ghost" className="h-11 w-fit rounded-full" onClick={() => setHowOpen(true)}>
              <HelpCircle className="h-4 w-4" />
              How it works
            </Button>
          </div>

          {/* Search + filters toolbar */}
          <div className="space-y-3 rounded-3xl border bg-card p-3 shadow-sm sm:p-4">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filters.search}
                onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                placeholder="Search by area, house type, or location"
                className="h-12 rounded-xl pl-11 text-base"
                aria-label="Search homes"
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <Input
                value={filters.location}
                onChange={(event) => setFilters({ ...filters, location: event.target.value })}
                placeholder="District or city"
                className="h-12 w-full rounded-xl text-base sm:w-52"
                aria-label="Filter by district or city"
              />
              <Select
                value={filters.amount}
                onValueChange={(value: AmountBucket) => setFilters({ ...filters, amount: value })}
              >
                <SelectTrigger className="h-12 w-full rounded-xl sm:w-56" aria-label="Filter by funding amount">
                  <SlidersHorizontal className="mr-2 h-4 w-4 text-muted-foreground" />
                  <SelectValue placeholder="Any amount" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any amount</SelectItem>
                  <SelectItem value="under_300k">Under UGX 300,000</SelectItem>
                  <SelectItem value="300k_600k">UGX 300,000–600,000</SelectItem>
                  <SelectItem value="over_600k">Above UGX 600,000</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="soft"
                className="h-12 w-full rounded-xl sm:w-auto"
                onClick={() => setCalculatorOpen(true)}
              >
                <Calculator className="h-4 w-4" />
                Return calculator
              </Button>
              {filtersActive ? (
                <Button
                  variant="ghost"
                  className="h-12 w-full rounded-xl sm:w-auto"
                  onClick={() => setFilters({ search: '', location: '', amount: 'all' })}
                >
                  <X className="h-4 w-4" />
                  Clear filters
                </Button>
              ) : null}
            </div>
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as FunderNewCategory)} className="space-y-4">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl p-1 sm:w-fit">
              <TabsTrigger value="empty" className="rounded-lg px-4 py-2 text-sm">
                Empty houses
              </TabsTrigger>
              <TabsTrigger value="ready" className="rounded-lg px-4 py-2 text-sm">
                Houses with ready tenants
              </TabsTrigger>
            </TabsList>

            <TabsContent value="empty" className="space-y-4">
              <p className="text-sm text-muted-foreground">Vacant verified houses waiting for a tenant.</p>
              <HouseGrid
                category="empty"
                filters={filters}
                savedIds={saved.empty}
                selectedIds={selectedCategory === 'empty' ? activeSelectedIds : []}
                highlightIds={saved.empty}
                onSave={toggleSave}
                onSelect={toggleSelect}
                onDetail={openDetail}
                onItemsChange={setListItems}
              />
            </TabsContent>

            <TabsContent value="ready" className="space-y-4">
              <p className="text-sm text-muted-foreground">Homes where a tenant is already lined up.</p>
              <HouseGrid
                category="ready"
                filters={filters}
                savedIds={saved.ready}
                selectedIds={selectedCategory === 'ready' ? activeSelectedIds : []}
                highlightIds={saved.ready}
                onSave={toggleSave}
                onSelect={toggleSelect}
                onDetail={openDetail}
                onItemsChange={setListItems}
              />
            </TabsContent>
          </Tabs>

          <Badge variant="secondary" className="rounded-full">
            Empty houses and ready tenants are reviewed separately
          </Badge>
        </section>
      </main>

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(open) => {
          if (!open) setDetailHouse(null);
        }}
        isPicked={
          detailHouse
            ? selectedItems.some((item) => item.category === 'empty' && item.id === detailHouse.house_id)
            : false
        }
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
      <FunderNewCalculatorDialog
        open={calculatorOpen}
        onOpenChange={setCalculatorOpen}
        category={tab}
        items={listItems}
        onOpenHouse={(id) => {
          setCalculatorOpen(false);
          openDetailById(id);
        }}
      />
      <FunderNewHowItWorksDialog open={howOpen} onOpenChange={setHowOpen} />
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
    </div>
  );
}
