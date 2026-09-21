import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bookmark,
  Calculator,
  CheckCircle2,
  HelpCircle,
  Home,
  Info,
  ListFilter,
  Loader2,
  Map,
  MapPin,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewMap } from '@/components/funder-new/FunderNewMap';
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
import {
  categoryLabel,
  emptyHousePlace,
  emptyHouseTitle,
  firstPhoto,
  hasCoordinates,
  itemAmount,
  itemMonthlyReturn,
  readyPlanPlace,
  readyPlanTerm,
  readyPlanTitle,
  toSelectionItem,
} from '@/components/funder-new/utils';
import { formatDynamic, formatDynamicCompact } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';

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

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="warning" className="border-warning/40 bg-warning/10">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function HouseImage({ src, title }: { src: string | null; title: string }) {
  return src ? (
    <img src={src} alt={title} loading="lazy" className="h-36 w-full object-cover" />
  ) : (
    <div className="flex h-36 w-full items-center justify-center bg-muted">
      <Home className="h-8 w-8 text-muted-foreground" />
    </div>
  );
}

function OpportunityCard({
  category,
  item,
  saved,
  selected,
  onSave,
  onSelect,
  onDetail,
}: {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
  saved: boolean;
  selected: boolean;
  onSave: () => void;
  onSelect: () => void;
  onDetail: () => void;
}) {
  const title = category === 'empty' ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan);
  const place = category === 'empty' ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan);
  const amount = itemAmount(category, item);
  const monthlyReturn = itemMonthlyReturn(category, item);
  const coords = hasCoordinates(item, category);
  const photo = firstPhoto(category, item);
  const term = category === 'empty' ? 'Vacant verified house' : readyPlanTerm(item as FunderNewReadyPlan);

  return (
    <Card className={cn('overflow-hidden rounded-lg', selected && 'border-primary shadow-md')}>
      <button type="button" className="block w-full text-left" onClick={onDetail} aria-label={`View ${title}`}>
        <HouseImage src={photo} title={title} />
      </button>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="line-clamp-2 text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 flex-none" />
                <span className="line-clamp-1">{place}</span>
              </p>
            </div>
            <Badge variant={coords ? 'success' : 'muted'} className="flex-none">
              {coords ? 'Mapped' : 'No map'}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Amount</p>
              <p className="font-semibold">{formatDynamic(amount)}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Returns</p>
              <p className="font-semibold">{monthlyReturn ? formatDynamic(monthlyReturn) : 'On file'}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{term}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant={saved ? 'secondary' : 'outline'} size="sm" onClick={onSave}>
            <Bookmark className={cn('h-4 w-4', saved && 'fill-current')} />
            {saved ? 'Saved' : 'Save'}
          </Button>
          <Button variant={selected ? 'default' : 'soft'} size="sm" onClick={onSelect}>
            <CheckCircle2 className="h-4 w-4" />
            {selected ? 'Selected' : 'Select'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FiltersBar({ filters, onChange }: { filters: FunderNewFilters; onChange: (next: FunderNewFilters) => void }) {
  return (
    <div className="grid gap-3 rounded-lg border bg-card p-3 md:grid-cols-[1fr_180px_180px]">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          placeholder="Search by area, house, tenant, or landlord"
          className="h-11 pl-9"
        />
      </label>
      <Input
        value={filters.location}
        onChange={(event) => onChange({ ...filters, location: event.target.value })}
        placeholder="District or city"
        className="h-11"
      />
      <Select value={filters.amount} onValueChange={(value: AmountBucket) => onChange({ ...filters, amount: value })}>
        <SelectTrigger className="h-11">
          <SelectValue placeholder="Amount" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any amount</SelectItem>
          <SelectItem value="under_300k">Under UGX 300,000</SelectItem>
          <SelectItem value="300k_600k">UGX 300,000–600,000</SelectItem>
          <SelectItem value="over_600k">Above UGX 600,000</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function ReviewDialog({
  open,
  onOpenChange,
  items,
  available,
  walletLoading,
  walletError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: FunderNewSelectionItem[];
  available: number | null;
  walletLoading: boolean;
  walletError: unknown;
}) {
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const shortfall = available === null ? null : Math.max(0, total - available);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review selected homes</DialogTitle>
          <DialogDescription>
            This review does not submit funding. Funding remains behind the existing confirmation flow.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Selected" value={`${items.length}`} sub={items.length === 1 ? 'home' : 'homes'} />
            <StatCard label="Total needed" value={formatDynamic(total)} />
            <StatCard
              label="Available balance"
              value={walletError ? 'Unavailable' : walletLoading ? 'Loading' : available === null ? 'Unavailable' : formatDynamic(available)}
              sub={shortfall && shortfall > 0 ? `${formatDynamic(shortfall)} short` : shortfall === 0 ? 'Fully covered' : undefined}
            />
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {items.map((item) => (
              <div key={`${item.category}:${item.id}`} className="flex items-center gap-3 rounded-lg border p-3">
                <HouseImage src={item.imageUrl} title={item.title} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.place}</p>
                  <p className="mt-1 text-sm font-semibold">{formatDynamic(item.amount)}</p>
                </div>
                <Badge variant="outline">{categoryLabel(item.category)}</Badge>
              </div>
            ))}
          </div>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Confirmation required</AlertTitle>
            <AlertDescription>
              Browsing, saving, selecting and reviewing on this page are non-transactional. No wallet movement is submitted here.
            </AlertDescription>
          </Alert>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SelectionBar({
  items,
  category,
  available,
  walletLoading,
  walletError,
  onClear,
  onReview,
}: {
  items: FunderNewSelectionItem[];
  category: FunderNewCategory | null;
  available: number | null;
  walletLoading: boolean;
  walletError: unknown;
  onClear: () => void;
  onReview: () => void;
}) {
  if (items.length === 0 || !category) return null;
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const shortfall = available === null ? null : Math.max(0, total - available);
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 shadow-lg backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            {items.length} {categoryLabel(category).toLowerCase()} selected · {formatDynamic(total)}
          </p>
          <p className="text-xs text-muted-foreground">
            {walletError
              ? 'Available balance could not be loaded.'
              : walletLoading
                ? 'Checking available balance…'
                : shortfall && shortfall > 0
                  ? `${formatDynamic(shortfall)} more needed from your available balance.`
                  : 'Covered by your available balance.'}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button variant="ghost" onClick={onClear}>
            <X className="h-4 w-4" />
            Clear
          </Button>
          <Button onClick={onReview}>
            <ShieldCheck className="h-4 w-4" />
            Review
          </Button>
        </div>
      </div>
    </div>
  );
}

function MarketSummary() {
  const summary = useFunderNewMarketSummary();
  if (summary.isLoading) {
    return (
      <Card className="rounded-lg">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    );
  }
  if (summary.error || !summary.data) {
    return <ErrorState title="Market summary unavailable" message="Live house totals could not be loaded, so this page is not showing them as zero." />;
  }
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>Homes waiting for support</CardTitle>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              This is all the rent money still needed to put tenants into every empty house. It goes up when agents list new empty houses, and down when Supporters fund them.
            </p>
          </div>
          <Badge variant="outline" className="w-fit">Live data</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Total rent needed" value={formatDynamicCompact(summary.data.totalRentNeeded)} sub={formatDynamic(summary.data.totalRentNeeded)} />
        <StatCard label="Empty houses" value={summary.data.houseCount.toLocaleString()} />
        <StatCard label="Average per house" value={summary.data.houseCount > 0 ? formatDynamic(summary.data.avgMonthlyRent) : 'No houses'} />
      </CardContent>
    </Card>
  );
}

function OpportunitiesGrid({
  category,
  filters,
  savedIds,
  selectedIds,
  onSave,
  onSelect,
  onDetail,
  onMapItemsChange,
}: {
  category: FunderNewCategory;
  filters: FunderNewFilters;
  savedIds: string[];
  selectedIds: string[];
  onSave: (category: FunderNewCategory, id: string) => void;
  onSelect: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => void;
  onDetail: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => void;
  onMapItemsChange: (items: Array<FunderNewEmptyHouse | FunderNewReadyPlan>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? EXPANDED_LIMIT : INITIAL_LIMIT;
  const empty = useFunderNewEmptyHouses(filters, limit, category === 'empty');
  const ready = useFunderNewReadyPlans(filters, limit, category === 'ready');
  const query = category === 'empty' ? empty : ready;
  const items = (query.data?.items ?? []) as Array<FunderNewEmptyHouse | FunderNewReadyPlan>;

  useEffect(() => {
    onMapItemsChange(items);
  }, [items, onMapItemsChange]);

  useEffect(() => {
    setExpanded(false);
  }, [category, filters.amount, filters.location, filters.search]);

  if (query.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: INITIAL_LIMIT }).map((_, index) => (
          <Skeleton key={index} className="h-80 rounded-lg" />
        ))}
      </div>
    );
  }

  if (query.error) {
    return <ErrorState title={`${categoryLabel(category)} unavailable`} message="The live list could not be loaded. No values have been replaced with zero." />;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <ListFilter className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">No matching homes</p>
        <p className="mt-1 text-sm text-muted-foreground">Adjust the search, location, or amount filter.</p>
      </div>
    );
  }

  const canShowMore = !expanded && (query.data?.total ?? 0) > INITIAL_LIMIT;

  return (
    <div className="space-y-4">
      {query.data?.limitation ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Search note</AlertTitle>
          <AlertDescription>{query.data.limitation}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const id = category === 'empty'
            ? (item as FunderNewEmptyHouse).house_id
            : (item as FunderNewReadyPlan).rent_request_id;
          return (
            <OpportunityCard
              key={id}
              category={category}
              item={item}
              saved={savedIds.includes(id)}
              selected={selectedIds.includes(id)}
              onSave={() => onSave(category, id)}
              onSelect={() => onSelect(category, item)}
              onDetail={() => onDetail(category, item)}
            />
          );
        })}
      </div>
      {canShowMore ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setExpanded(true)}>
            Show more homes
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
  const [tab, setTab] = useState<FunderNewCategory>('empty');
  const [filters, setFilters] = useState<FunderNewFilters>({ search: '', location: '', amount: 'all' });
  const [saved, setSaved] = useState<SavedState>(() => readSaved());
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapItems, setMapItems] = useState<Array<FunderNewEmptyHouse | FunderNewReadyPlan>>([]);
  const [userPoint, setUserPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied' | 'unsupported'>('idle');
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    saveSaved(saved);
  }, [saved]);

  const activeSelectedIds = useMemo(
    () => selectedItems.filter((item) => item.category === tab).map((item) => item.id),
    [selectedItems, tab],
  );

  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;

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

  const openDetail = (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    if (category === 'empty') {
      setDetailHouse(item as FunderNewEmptyHouse);
      return;
    }
    setDetailPlan(item as FunderNewReadyPlan);
  };

  const openMapDetail = (id: string) => {
    const found = mapItems.find((item) => {
      return tab === 'empty'
        ? (item as FunderNewEmptyHouse).house_id === id
        : (item as FunderNewReadyPlan).rent_request_id === id;
    });
    if (found) openDetail(tab, found);
  };

  const requestLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocationStatus('unsupported');
      return;
    }
    setLocationStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserPoint({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocationStatus('idle');
      },
      () => setLocationStatus('denied'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
  };

  const selectedTotal = selectedItems.reduce((sum, item) => sum + item.amount, 0);
  const selectedShortfall = availableBalance === null ? null : Math.max(0, selectedTotal - availableBalance);

  return (
    <div className="min-h-screen bg-background pb-28 text-foreground">
      <header className="border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">RentFlow Insights review</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Find a home to support</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {user?.user_metadata?.full_name ? `${user.user_metadata.full_name}, review live homes without changing the current dashboard.` : 'Review live homes without changing the current dashboard.'}
              </p>
            </div>
            <div className="grid gap-2 sm:flex sm:items-center">
              <div className="rounded-lg border bg-card px-4 py-2">
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><Wallet className="h-3.5 w-3.5" /> Available balance</p>
                <p className="text-sm font-semibold">
                  {wallet.error ? 'Unavailable' : wallet.isLoading ? 'Loading…' : formatDynamic(wallet.withdrawable)}
                </p>
              </div>
              <Button variant="outline" onClick={() => navigate('/dashboard/funder')}>Current dashboard</Button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <MarketSummary />

        <section className="space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Find a home to support</h2>
              <p className="text-sm text-muted-foreground">Save homes for later or select one group for review.</p>
            </div>
            <Badge variant="secondary" className="w-fit">
              <SlidersHorizontal className="mr-1 h-3.5 w-3.5" /> Save and Select are separate
            </Badge>
          </div>

          <FiltersBar filters={filters} onChange={setFilters} />

          <Tabs value={tab} onValueChange={(value) => setTab(value as FunderNewCategory)}>
            <TabsList className="grid w-full grid-cols-2 md:w-fit">
              <TabsTrigger value="empty">Empty houses</TabsTrigger>
              <TabsTrigger value="ready">Houses with ready tenants</TabsTrigger>
            </TabsList>
            <TabsContent value="empty">
              <OpportunitiesGrid
                category="empty"
                filters={filters}
                savedIds={saved.empty}
                selectedIds={selectedCategory === 'empty' ? activeSelectedIds : []}
                onSave={toggleSave}
                onSelect={toggleSelect}
                onDetail={openDetail}
                onMapItemsChange={setMapItems}
              />
            </TabsContent>
            <TabsContent value="ready">
              <OpportunitiesGrid
                category="ready"
                filters={filters}
                savedIds={saved.ready}
                selectedIds={selectedCategory === 'ready' ? activeSelectedIds : []}
                onSave={toggleSave}
                onSelect={toggleSelect}
                onDetail={openDetail}
                onMapItemsChange={setMapItems}
              />
            </TabsContent>
          </Tabs>

          <Card className="rounded-lg">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2"><Map className="h-4 w-4" /> Optional map</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">The map stays below the first six cards and never asks for your location unless you choose it.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Button variant="outline" onClick={() => setMapOpen((open) => !open)}>
                    {mapOpen ? 'Hide map' : 'Show map'}
                  </Button>
                  <Button variant="soft" onClick={requestLocation} disabled={locationStatus === 'loading'}>
                    {locationStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
                    My area
                  </Button>
                </div>
              </div>
            </CardHeader>
            {locationStatus === 'denied' || locationStatus === 'unsupported' ? (
              <CardContent className="pt-0">
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>Location not available</AlertTitle>
                  <AlertDescription>Use the filters and house cards instead. The map still shows homes that already have saved coordinates.</AlertDescription>
                </Alert>
              </CardContent>
            ) : null}
            {mapOpen ? (
              <CardContent className="h-[420px] pt-0">
                <FunderNewMap category={tab} items={mapItems} onOpenDetail={openMapDetail} userPoint={userPoint} />
              </CardContent>
            ) : null}
          </Card>
        </section>

        <Accordion type="multiple" className="rounded-lg border bg-card px-4">
          <AccordionItem value="how">
            <AccordionTrigger>How support works</AccordionTrigger>
            <AccordionContent className="text-sm text-muted-foreground">
              Select either empty houses or houses with ready tenants, review the exact amount and available balance, then use the existing confirmation flow when you are ready to fund.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="calculator">
            <AccordionTrigger>Calculator</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard label="Selected amount" value={formatDynamic(selectedTotal)} />
                <StatCard label="Available balance" value={availableBalance === null ? 'Unavailable' : formatDynamic(availableBalance)} />
                <StatCard label="Shortfall" value={selectedShortfall === null ? 'Unavailable' : formatDynamic(selectedShortfall)} />
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="help">
            <AccordionTrigger>Help</AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm text-muted-foreground">
              <p>Empty houses and ready tenants are reviewed separately so one selection never subtracts from the other.</p>
              <p>Errors are shown as unavailable instead of zero.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </main>

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(open) => { if (!open) setDetailHouse(null); }}
        isPicked={detailHouse ? selectedItems.some((item) => item.category === 'empty' && item.id === detailHouse.house_id) : false}
        onTogglePick={(house) => toggleSelect('empty', house as FunderNewEmptyHouse)}
        isPartner
        remaining={availableBalance ?? undefined}
      />
      <SelfPortfolioPlanDetailSheet plan={detailPlan} open={!!detailPlan} onOpenChange={(open) => { if (!open) setDetailPlan(null); }} isFunded={false} />
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        items={selectedItems}
        available={availableBalance}
        walletLoading={wallet.isLoading}
        walletError={wallet.error}
      />
      <SelectionBar
        items={selectedItems}
        category={selectedCategory}
        available={availableBalance}
        walletLoading={wallet.isLoading}
        walletError={wallet.error}
        onClear={() => {
          setSelectedItems([]);
          setSelectedCategory(null);
        }}
        onReview={() => setReviewOpen(true)}
      />
    </div>
  );
}
