import { useState, useMemo, useEffect, useRef } from 'react';
import houseSearchingIllustration from '@/assets/House_searching-bro-2.svg.asset.json';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, MapPin, Droplets, Zap, ShieldCheck, Car, Sofa, Home, DoorOpen, ChevronLeft, ChevronRight, Clock, ExternalLink, ZoomIn, X, List, Map as MapIcon, SlidersHorizontal, ChevronDown, ChevronUp } from 'lucide-react';
import { ArrowUpDown, BedDouble } from 'lucide-react';
import { AgentContactBar } from '@/components/tenant/AgentContactBar';
import { GetDirectionsButton } from '@/components/tenant/GetDirectionsButton';
import { ShareHouseButton } from '@/components/tenant/ShareHouseButton';
import { ShareNearbyHousesButton } from '@/components/tenant/ShareNearbyHousesButton';
import { useNearbyHouses, useHouseListingCount, HouseListing } from '@/hooks/useHouseListings';
import { HouseListingCount } from '@/components/tenant/HouseListingCount';
import { useGeolocation } from '@/hooks/useGeolocation';
import { formatUGX } from '@/lib/rentCalculations';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';
import { motion } from 'framer-motion';
import { ImageLightbox } from '@/components/marketplace/ImageLightbox';
import { regionLabel } from '@/lib/ugandaDistricts';
import { UG_REGIONS } from '@/hooks/useUgLocations';
import { useHouseFilterOptions } from '@/hooks/useHouseFilterOptions';
import { normalizeAreaName } from '@/lib/listingAreaFilter';
import { HousesMapView } from '@/components/tenant/HousesMapView';
import { LoadMoreProgress } from '@/components/tenant/LoadMoreProgress';
import { useNavigate } from 'react-router-dom';

interface AvailableHousesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Region control is dataset-backed: Uganda's four official regions only.
// Districts / sub-counties / villages come from the live listing inventory
// (see useHouseFilterOptions) so every option returns at least one house.
const REGIONS = ['All Regions', ...UG_REGIONS];

const CATEGORIES = [
  { value: 'all', label: 'All Types' },
  { value: 'single_room', label: 'Single Room' },
  { value: 'double_room', label: 'Double Room' },
  { value: 'bedsitter', label: 'Bedsitter' },
  { value: 'one_bedroom', label: '1 Bedroom' },
  { value: 'two_bedroom', label: '2 Bedrooms' },
  { value: 'three_bedroom', label: '3 Bedrooms' },
  { value: 'studio', label: 'Studio' },
  { value: 'shop', label: 'Shop / Lock-up Shop' },
  { value: 'market_stall', label: 'Market Stall' },
  { value: 'kiosk', label: 'Kiosk / Container' },
  { value: 'salon_workshop', label: 'Salon / Workshop' },
  { value: 'office_space', label: 'Office Space' },
  { value: 'warehouse_store', label: 'Warehouse / Store' },
  { value: 'commercial_premises', label: 'Other Commercial Premises' },
];


const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_asc', label: 'Price: Low to High' },
  { value: 'price_desc', label: 'Price: High to Low' },
] as const;

const AMENITY_TOGGLES: { key: 'hasWater' | 'hasElectricity' | 'hasSecurity' | 'hasParking' | 'isFurnished'; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'hasWater', label: 'Water', Icon: Droplets },
  { key: 'hasElectricity', label: 'Power', Icon: Zap },
  { key: 'hasSecurity', label: 'Security', Icon: ShieldCheck },
  { key: 'hasParking', label: 'Parking', Icon: Car },
  { key: 'isFurnished', label: 'Furnished', Icon: Sofa },
];

function HouseImageCarousel({ images, title, houseId }: { images: string[] | null; title: string; houseId: string }) {
  const [idx, setIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  if (!images || images.length === 0) {
    return (
      <div className="w-full h-44 rounded-xl bg-muted flex items-center justify-center">
        <Home className="h-10 w-10 text-muted-foreground/30" />
      </div>
    );
  }

  return (
    <div className="relative w-full h-44 rounded-xl overflow-hidden bg-muted">
      <img
        src={images[idx]}
        alt={title}
        className="w-full h-full object-cover cursor-zoom-in"
        loading="lazy"
        onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
        aria-label="View full screen"
        className="absolute top-1.5 right-1.5 bg-black/60 text-white rounded-full p-1.5 active:scale-95 transition-transform"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={(e) => { e.stopPropagation(); setIdx(i => (i - 1 + images.length) % images.length); }}
            className="absolute left-1 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next photo"
            onClick={(e) => { e.stopPropagation(); setIdx(i => (i + 1) % images.length); }}
            className="absolute right-1 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-1">
            {images.map((_, i) => (
              <span key={i} className={`w-1.5 h-1.5 rounded-full ${i === idx ? 'bg-card' : 'bg-white/50'}`} />
            ))}
          </div>
        </>
      )}
      <ImageLightbox
        images={images.map((url, i) => ({ id: `${i}`, image_url: url }))}
        initialIndex={idx}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        productName={title}
        memoryKey={`house:${houseId}`}
      />
    </div>
  );
}

function VerificationBadge({ verified, status }: { verified?: boolean; status: string }) {
  const isPending = !verified || status === 'pending';
  
  if (isPending) {
    return (
      <Badge variant="outline" className="text-[10px] bg-warning/15 text-warning border-warning/30 gap-1">
        <Clock className="h-3 w-3" /> Pending Verification
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-[10px] bg-success/15 text-success border-success/30 gap-1">
      <ShieldCheck className="h-3 w-3" /> Verified
    </Badge>
  );
}

function HouseCard({ listing, highlighted = false, onOpen }: { listing: HouseListing; highlighted?: boolean; onOpen: (listing: HouseListing) => void }) {
  const categoryLabel = CATEGORIES.find(c => c.value === listing.house_category)?.label || listing.house_category;
  const dist = listing.distance_km;
  const cover = listing.image_urls && listing.image_urls.length > 0 ? listing.image_urls[0] : null;
  const open = () => onOpen(listing);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      data-house-card=""
      data-house-id={listing.id}
      role="button"
      tabIndex={0}
      aria-label={`View details for ${listing.title}`}
      aria-current={highlighted ? 'true' : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      }}
      className={
        'rounded-2xl border bg-card overflow-hidden transition-shadow cursor-pointer active:scale-[0.98] touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
        (highlighted
          ? 'border-primary shadow-lg ring-2 ring-primary/40 ring-offset-2 ring-offset-background'
          : 'border-border shadow-sm')
      }
    >
      {/* House image */}
      <div className="relative w-full h-40 bg-muted">
        {cover ? (
          <img src={cover} alt={listing.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Home className="h-10 w-10 text-muted-foreground/30" />
          </div>
        )}
        {dist !== undefined && dist < 9999 && (
          <span className="absolute top-2 left-2 text-[10px] font-medium text-white bg-primary/80 px-2 py-0.5 rounded-full">
            ~{dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`}
          </span>
        )}
        <Badge variant="secondary" className="absolute top-2 right-2 text-[10px]">{categoryLabel}</Badge>
        <div className="absolute bottom-2 right-2">
          <VerificationBadge verified={listing.verified} status={listing.status} />
        </div>
      </div>

      {/* Title · location · price */}
      <div className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-base truncate">{listing.title}</h3>
            <div className="flex items-center gap-1 mt-0.5">
              <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground truncate">
                {listing.address}, {listing.region}
                {listing.district ? `, ${listing.district}` : ''}
              </p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-black text-success leading-none">{formatUGX(listing.daily_rate)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">per day</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 text-[11px] font-medium text-primary">
          Tap to view details <ChevronRight className="h-3 w-3" />
        </div>
      </div>
    </motion.div>
  );
}

export function AvailableHousesSheet({ open, onOpenChange }: AvailableHousesSheetProps) {
  const geo = useGeolocation(true);
  
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('All Regions');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedDistrict, setSelectedDistrict] = useState('all');
  const [selectedSubCounty, setSelectedSubCounty] = useState('all');
  const [selectedVillage, setSelectedVillage] = useState('all');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [minPrice, setMinPrice] = useState<number | undefined>(undefined);
  const [maxPrice, setMaxPrice] = useState<number | undefined>(undefined);
  const [minRooms, setMinRooms] = useState<number>(0);
  const [amenities, setAmenities] = useState<{
    hasWater: boolean; hasElectricity: boolean; hasSecurity: boolean; hasParking: boolean; isFurnished: boolean;
  }>({ hasWater: false, hasElectricity: false, hasSecurity: false, hasParking: false, isFurnished: false });
  const [sort, setSort] = useState<'newest' | 'price_asc' | 'price_desc'>('newest');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // Bottom sentinel — when it scrolls into view we ask for the next page.
  const sentinelRef = useRef<HTMLDivElement>(null);

  // By default we list EVERY available house across the whole country — NOT
  // only houses near the tenant's GPS. Location is the tenant's choice via the
  // region/district/sub-county/village filters below. We therefore don't feed
  // GPS into the list query (that would distance-scope and distance-sort it, so
  // a tenant sitting far from most listings would see very few). Results come
  // back newest-first and are narrowed only when the tenant picks a filter.
  const { listings, loading, loadingMore, hasMore, loadMore, metrics } = useNearbyHouses({
    latitude: null,
    longitude: null,
    category: selectedCategory !== 'all' ? selectedCategory : undefined,
    region: selectedRegion !== 'All Regions' ? selectedRegion : undefined,
    district: selectedDistrict !== 'all' ? selectedDistrict : undefined,
    subCounty: selectedSubCounty !== 'all' ? selectedSubCounty : undefined,
    village: selectedVillage !== 'all' ? selectedVillage : undefined,
    search: searchText.trim() || undefined,
    minDailyRate: minPrice,
    maxDailyRate: maxPrice,
    minRooms: minRooms || undefined,
    hasWater: amenities.hasWater || undefined,
    hasElectricity: amenities.hasElectricity || undefined,
    hasSecurity: amenities.hasSecurity || undefined,
    hasParking: amenities.hasParking || undefined,
    isFurnished: amenities.isFurnished || undefined,
    sort,
    // Page through EVERY matching listing — no fixed cap.
    paginate: true,
    // Load a large first page so the District / Sub-County / Village
    // dropdowns (which derive their options from the currently-loaded
    // rows) see the full result set immediately. Anything smaller silently
    // hides districts that aren't in the newest N houses.
    pageSize: 500,
    enabled: open,
  });

  // Exact listed-house counts (verified + not-yet-verified) for the active
  // filter set — replaces the loaded-rows "24+" counter.
  const listingCounts = useHouseListingCount({
    region: selectedRegion !== 'All Regions' ? selectedRegion : undefined,
    district: selectedDistrict !== 'all' ? selectedDistrict : undefined,
    subCounty: selectedSubCounty !== 'all' ? selectedSubCounty : undefined,
    village: selectedVillage !== 'all' ? selectedVillage : undefined,
    category: selectedCategory !== 'all' ? selectedCategory : undefined,
    search: searchText.trim() || undefined,
    minDailyRate: minPrice,
    maxDailyRate: maxPrice,
    minRooms: minRooms || undefined,
    hasWater: amenities.hasWater || undefined,
    hasElectricity: amenities.hasElectricity || undefined,
    hasSecurity: amenities.hasSecurity || undefined,
    hasParking: amenities.hasParking || undefined,
    isFurnished: amenities.isFurnished || undefined,
    enabled: open,
  });

  // Inventory-backed options: only areas / types that actually have browsable
  // houses right now, each already validated against the official ug_* dataset
  // and carrying a live count. One cached request per (region, district,
  // sub-county) scope — never a per-row lookup.
  const { options: filterOptions } = useHouseFilterOptions(
    { region: selectedRegion !== 'All Regions' ? selectedRegion : null, district: selectedDistrict, subCounty: selectedSubCounty },
    open,
  );

  // Selecting a broader area resets the narrower ones so we never keep a stale
  // district/sub-county/village that no longer belongs to the new selection.
  const handleRegionChange = (value: string) => {
    setSelectedRegion(value);
    setSelectedDistrict('all');
    setSelectedSubCounty('all');
    setSelectedVillage('all');
  };
  const handleDistrictChange = (value: string) => {
    setSelectedDistrict(value);
    setSelectedSubCounty('all');
    setSelectedVillage('all');
  };
  const handleSubCountyChange = (value: string) => {
    setSelectedSubCounty(value);
    setSelectedVillage('all');
  };

  const districtOptions = filterOptions.districts;
  const subCountyOptions = filterOptions.subCounties;
  const villageOptions = filterOptions.villages;

  // Region choices keep the official four, annotated with what is listed there.
  const regionCount = useMemo(() => {
    const m = new Map<string, number>();
    filterOptions.regions.forEach(r => m.set(normalizeAreaName(r.value), r.count));
    return m;
  }, [filterOptions.regions]);

  // Only offer property types that exist in the current area scope.
  const categoryOptions = useMemo(() => {
    if (filterOptions.categories.length === 0) return CATEGORIES;
    const counts = new Map(filterOptions.categories.map(c => [c.value, c.count]));
    return [
      CATEGORIES[0],
      ...CATEGORIES.slice(1)
        .filter(c => counts.has(c.value))
        .map(c => ({ ...c, label: `${c.label} (${counts.get(c.value)})` })),
    ];
  }, [filterOptions.categories]);

  const filtered = listings;

  const hasGPS = !!(geo.latitude && geo.longitude);

  // Pagination diagnostics overlay — off by default. Enable in any environment:
  //   localStorage.setItem('welile-debug-pagination','1')
  const showPaginationDebug = (() => {
    try { return localStorage.getItem('welile-debug-pagination') === '1'; } catch { return false; }
  })();

  // Paginated rendering: 10 houses per page with numbered navigation.
  const PAGE_SIZE = 10;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  // Reset to page 1 when the result set changes (new filters / search).
  useEffect(() => {
    setCurrentPage(1);
    resultsRef.current?.scrollTo({ top: 0 });
  }, [selectedRegion, selectedCategory, selectedDistrict, selectedSubCounty, selectedVillage, searchText, minPrice, maxPrice, minRooms, amenities, sort]);

  // Auto-fetch more rows from the server when the user gets within one page of
  // the end of the currently-loaded set, so page navigation stays seamless.
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    if (currentPage >= totalPages - 1) loadMore();
  }, [currentPage, totalPages, hasMore, loadingMore, loadMore]);

  // Clamp the current page if the dataset shrinks below it.
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  const goToPage = (p: number) => {
    const next = Math.min(Math.max(1, p), totalPages);
    setCurrentPage(next);
    resultsRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[95vh] rounded-t-3xl p-0 flex flex-col"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // Focus the primary control (search input) when the sheet opens.
          requestAnimationFrame(() => searchInputRef.current?.focus());
        }}
        onCloseAutoFocus={(e) => {
          // Defer focus restoration to the parent (which remembers the exact
          // triggering card) so Escape/overlay/close-button all behave the same.
          e.preventDefault();
        }}
      >
        <div
          ref={resultsRef}
          className={
            view === 'map'
              ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
              : 'flex-1 min-h-0 overflow-y-auto overscroll-contain'
          }
        >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border space-y-3 bg-background">
          <img
            src={houseSearchingIllustration.url}
            alt="House searching illustration"
            className="mx-auto h-44 w-auto object-contain"
          />
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="flex items-center gap-2">
              <Home className="h-5 w-5 text-primary" />
              {selectedRegion !== 'All Regions'
                ? `Houses in ${selectedRegion}`
                : 'Available Houses'}
            </SheetTitle>
            <div className="flex items-center gap-2 shrink-0">
              {(() => {
                const amenityCount = Object.values(amenities).filter(Boolean).length;
                const activeCount =
                  (searchText.trim().length > 0 ? 1 : 0) +
                  (selectedRegion !== 'All Regions' ? 1 : 0) +
                  (selectedCategory !== 'all' ? 1 : 0) +
                  (selectedDistrict !== 'all' ? 1 : 0) +
                  (selectedSubCounty !== 'all' ? 1 : 0) +
                  (selectedVillage !== 'all' ? 1 : 0) +
                  (minPrice || maxPrice ? 1 : 0) +
                  (minRooms > 0 ? 1 : 0) +
                  amenityCount +
                  (sort !== 'newest' ? 1 : 0);
                return (
                  <button
                    type="button"
                    onClick={() => setFiltersOpen(o => !o)}
                    aria-expanded={filtersOpen}
                    aria-controls="available-houses-filters"
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold text-foreground hover:bg-muted transition"
                  >
                    <SlidersHorizontal className="h-3 w-3" />
                    Filters
                    {activeCount > 0 && (
                      <span className="ml-0.5 inline-flex items-center justify-center h-3.5 min-w-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-none">
                        {activeCount}
                      </span>
                    )}
                    {filtersOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                );
              })()}
              <div className="flex items-center rounded-full border border-border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setView('list')}
                aria-pressed={view === 'list'}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold transition ${view === 'list' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                <List className="h-3 w-3" /> List
              </button>
              <button
                type="button"
                onClick={() => setView('map')}
                aria-pressed={view === 'map'}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold transition ${view === 'map' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                <MapIcon className="h-3 w-3" /> Map
              </button>
              </div>
            </div>
          </div>

          <ShareNearbyHousesButton
            variant="full"
            latitude={geo.latitude}
            longitude={geo.longitude}
            area={geo.city}
            region={selectedRegion !== 'All Regions' ? selectedRegion : undefined}
          />

          {filtersOpen && (
          <div id="available-houses-filters" className="space-y-3">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              // Dismiss on-screen keyboards, then move focus to the first
              // result so screen readers and keyboard users land on content.
              searchInputRef.current?.blur();
              const firstResult = resultsRef.current?.querySelector<HTMLElement>(
                '[data-house-card] a, [data-house-card] button, [data-house-card]'
              );
              if (firstResult) {
                firstResult.scrollIntoView({ block: 'start', behavior: 'smooth' });
                if (typeof firstResult.focus === 'function') {
                  try { firstResult.focus({ preventScroll: true }); } catch { /* ignore */ }
                }
              }
            }}
            className="relative"
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="search"
              enterKeyHint="search"
              placeholder="Search by keyword — area, address, or house name..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="pl-10"
              aria-label="Search houses by keyword"
            />
            {/* Hidden submit so pressing Enter triggers onSubmit reliably. */}
            <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
              Search
            </button>
          </form>

          <div className="flex gap-2">
            <Select value={selectedRegion} onValueChange={handleRegionChange}>
              <SelectTrigger className="flex-1 h-9 text-xs">
                <SelectValue placeholder="Region" />
              </SelectTrigger>
              <SelectContent>
                {REGIONS.map(r => {
                  const n = regionCount.get(normalizeAreaName(r));
                  return (
                    <SelectItem key={r} value={r}>
                      {regionLabel(r)}{r !== 'All Regions' && n ? ` (${n})` : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="flex-1 h-9 text-xs">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map(c => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(searchText.trim().length > 0 || selectedRegion !== 'All Regions' || selectedCategory !== 'all' || selectedDistrict !== 'all' || selectedSubCounty !== 'all' || selectedVillage !== 'all' || minPrice || maxPrice || minRooms > 0 || Object.values(amenities).some(Boolean) || sort !== 'newest') && (
              <button
                type="button"
                onClick={() => {
                  setSearchText('');
                  setSelectedRegion('All Regions');
                  setSelectedCategory('all');
                  setSelectedDistrict('all');
                  setSelectedSubCounty('all');
                  setSelectedVillage('all');
                  setMinPrice(undefined);
                  setMaxPrice(undefined);
                  setMinRooms(0);
                  setAmenities({ hasWater: false, hasElectricity: false, hasSecurity: false, hasParking: false, isFurnished: false });
                  setSort('newest');
                  // Keep keyboard focus usable by returning it to the primary control.
                  requestAnimationFrame(() => searchInputRef.current?.focus());
                }}
                aria-label="Clear search and filters"
                className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-border bg-background text-xs font-medium text-foreground hover:bg-muted active:scale-95 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            )}
          </div>

          {/* Price range (daily rate) — quick chips + custom min/max */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Daily rent</p>
            <div className="flex gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="Min UGX/day"
                value={minPrice ?? ''}
                onChange={e => setMinPrice(e.target.value ? Number(e.target.value) : undefined)}
                className="h-9 text-xs flex-1"
                aria-label="Minimum daily rate"
              />
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="Max UGX/day"
                value={maxPrice ?? ''}
                onChange={e => setMaxPrice(e.target.value ? Number(e.target.value) : undefined)}
                className="h-9 text-xs flex-1"
                aria-label="Maximum daily rate"
              />
            </div>
          </div>

          {/* Rooms + Sort */}
          <div className="flex gap-2">
            <Select value={String(minRooms)} onValueChange={v => setMinRooms(Number(v))}>
              <SelectTrigger className="flex-1 h-9 text-xs">
                <BedDouble className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
                <SelectValue placeholder="Any rooms" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Any rooms</SelectItem>
                <SelectItem value="1">1+ rooms</SelectItem>
                <SelectItem value="2">2+ rooms</SelectItem>
                <SelectItem value="3">3+ rooms</SelectItem>
                <SelectItem value="4">4+ rooms</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger className="flex-1 h-9 text-xs">
                <ArrowUpDown className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Amenity toggles */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Must have</p>
            <div className="flex flex-wrap gap-1.5">
              {AMENITY_TOGGLES.map(({ key, label, Icon }) => {
                const active = amenities[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setAmenities(a => ({ ...a, [key]: !a[key] }))}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-medium transition ${active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dataset-backed area filters (ug_districts → ug_subcounties), plus
              village from the listings themselves. Cascades Region → District →
              Sub-county → Village so tenants drill to a precise area. */}
          {(districtOptions.length > 0 || subCountyOptions.length > 0 || villageOptions.length > 0) && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Select value={selectedDistrict} onValueChange={handleDistrictChange}>
                <SelectTrigger className="h-9 w-full min-w-0 text-[11px] [&>span]:block [&>span]:truncate [&>span]:text-left">
                  <SelectValue placeholder="District" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Districts</SelectItem>
                  {districtOptions.map(d => (
                    <SelectItem key={d.value} value={d.value}>{d.value} ({d.count})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={selectedSubCounty}
                onValueChange={handleSubCountyChange}
                disabled={subCountyOptions.length === 0}
              >
                <SelectTrigger className="h-9 w-full min-w-0 text-[11px] [&>span]:block [&>span]:truncate [&>span]:text-left">
                  <SelectValue placeholder="Sub-county" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sub-counties</SelectItem>
                  {subCountyOptions.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.value} ({s.count})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={selectedVillage}
                onValueChange={setSelectedVillage}
                disabled={villageOptions.length === 0}
              >
                <SelectTrigger className="h-9 w-full min-w-0 text-[11px] [&>span]:block [&>span]:truncate [&>span]:text-left">
                  <SelectValue placeholder="Village" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Villages</SelectItem>
                  {villageOptions.map(v => (
                    <SelectItem key={v.value} value={v.value}>{v.value} ({v.count})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          </div>
          )}
          {filtersOpen && (
            <div className="sticky bottom-0 -mx-1 px-1 pt-2 pb-1 bg-gradient-to-t from-background via-background to-transparent">
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                className="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-semibold shadow-sm hover:bg-primary/90 active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <SlidersHorizontal className="h-4 w-4" /> Apply filters
              </button>
            </div>
          )}
        </SheetHeader>

        {view === 'map' ? (
          <div className="flex-1 min-h-0">
            <HousesMapView
              listings={filtered}
              userCoords={hasGPS ? { lat: geo.latitude!, lng: geo.longitude! } : null}
              onSelectHouse={(l) => { onOpenChange(false); navigate(`/house/${l.id}`); }}
              onSwitchToList={() => setView('list')}
            />
          </div>
        ) : (
        <div className="px-4 py-4">
          <div className="mx-auto w-full max-w-2xl lg:max-w-6xl space-y-3">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-2xl" />
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <Home className="h-12 w-12 text-muted-foreground/30 mx-auto" />
              <p className="text-muted-foreground font-medium">No houses found</p>
              <p className="text-xs text-muted-foreground">
                Try a different region or category
              </p>
            </div>
          ) : (
            <>
              <HouseListingCount
                className="text-xs text-muted-foreground"
                counts={listingCounts}
                loadedCount={filtered.length}
                locationLabel={
                  selectedVillage !== 'all'
                    ? `in ${selectedVillage}`
                    : selectedSubCounty !== 'all'
                      ? `in ${selectedSubCounty}`
                      : selectedDistrict !== 'all'
                        ? `in ${selectedDistrict}`
                        : selectedRegion !== 'All Regions'
                          ? `in ${selectedRegion}`
                          : undefined
                }
                suffix="newest first"
              />
              {showPaginationDebug && (
                <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  <div>src={metrics.source} · pages={metrics.pagesFetched} · cache={metrics.cacheHit ? 'hit' : 'miss'} · {metrics.complete ? 'complete' : 'more'}</div>
                  <div>rows shown={metrics.totalRows} · raw fetched={metrics.rawRowsFetched} · dups={metrics.duplicatesDetected} · no-photo={metrics.photolessFiltered}</div>
                  <div>firstPage={metrics.firstPageMs ?? '—'}ms · lastPage={metrics.lastPageMs ?? '—'}ms · total={metrics.totalMs}ms</div>
                </div>
              )}
              {/* Paged list — 10 cards per page. Wide screens flow into a 2–3
                  column grid so the sheet fills its width. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {pageItems.map((listing, i) => (
                  <HouseCard
                    key={listing.id}
                    listing={listing}
                    highlighted={i === 0 && currentPage === 1 && searchText.trim().length > 0}
                    onOpen={(l) => { onOpenChange(false); navigate(`/house/${l.short_code || l.id}`); }}
                  />
                ))}
              </div>
              <div ref={sentinelRef} className="w-full" aria-hidden="true" />
              {(() => {
                // Compact page-number strip with ellipses around the current page.
                const pages: (number | 'ellipsis')[] = [];
                const push = (v: number | 'ellipsis') => pages.push(v);
                const window = 1;
                for (let p = 1; p <= totalPages; p++) {
                  if (
                    p === 1 ||
                    p === totalPages ||
                    (p >= currentPage - window && p <= currentPage + window)
                  ) push(p);
                  else if (pages[pages.length - 1] !== 'ellipsis') push('ellipsis');
                }
                const disabledPrev = currentPage <= 1;
                const disabledNext = currentPage >= totalPages && !hasMore;
                return (
                  <div className="flex flex-col items-center gap-2 pt-4 pb-24 md:pb-4">
                    <div className="flex items-center gap-1 flex-wrap justify-center">
                      <button
                        type="button"
                        onClick={() => goToPage(currentPage - 1)}
                        disabled={disabledPrev}
                        aria-label="Previous page"
                        className="inline-flex items-center gap-1 min-h-9 px-3 rounded-full border border-border bg-card text-sm font-semibold disabled:opacity-40 disabled:pointer-events-none active:scale-95 transition"
                      >
                        <ChevronLeft className="h-4 w-4" /> Prev
                      </button>
                      {pages.map((p, idx) =>
                        p === 'ellipsis' ? (
                          <span key={`e-${idx}`} className="px-2 text-muted-foreground text-sm">…</span>
                        ) : (
                          <button
                            key={p}
                            type="button"
                            onClick={() => goToPage(p)}
                            aria-current={p === currentPage ? 'page' : undefined}
                            aria-label={`Page ${p}`}
                            className={
                              'min-h-9 min-w-9 px-3 rounded-full text-sm font-semibold active:scale-95 transition border ' +
                              (p === currentPage
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-card text-foreground border-border hover:bg-muted')
                            }
                          >
                            {p}
                          </button>
                        ),
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (currentPage >= totalPages && hasMore) {
                            loadMore();
                            setCurrentPage(currentPage + 1);
                          } else {
                            goToPage(currentPage + 1);
                          }
                        }}
                        disabled={disabledNext}
                        aria-label="Next page"
                        className="inline-flex items-center gap-1 min-h-9 px-3 rounded-full border border-border bg-card text-sm font-semibold disabled:opacity-40 disabled:pointer-events-none active:scale-95 transition"
                      >
                        Next <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Page {currentPage} of {hasMore ? `${totalPages}+` : totalPages} · Showing {pageItems.length} of {listingCounts.verified.toLocaleString()} verified houses
                    </p>
                  </div>
                );
              })()}
              {loadingMore && (
                <LoadMoreProgress
                  loadedCount={filtered.length}
                  pagesFetched={metrics.pagesFetched}
                  hasMore={hasMore}
                  skeletonCount={2}
                  skeletonClassName="h-40 w-full rounded-2xl"
                />
              )}
            </>
          )}
          </div>
        </div>
        )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
