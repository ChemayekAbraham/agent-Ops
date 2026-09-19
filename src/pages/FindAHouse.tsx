import { useState, useMemo, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Helmet } from 'react-helmet-async';
import { ImageLightbox } from '@/components/marketplace/ImageLightbox';
import houseSearchingIllustration from '@/assets/House_searching-bro-3.svg.asset.json';
import { useSearchParams, useNavigate, useLocation, useParams } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { Skeleton } from '@/components/ui/skeleton';
import { LoadMoreProgress } from '@/components/tenant/LoadMoreProgress';
import { Button } from '@/components/ui/button';
import {
  Search, MapPin, ShieldCheck, Home,
  ChevronLeft, ChevronRight, ChevronDown, Check,
  SlidersHorizontal, X, Droplets, Zap, Car, Sofa, Loader2,
  ArrowUpDown, BedDouble,
  Map as MapIcon, List as ListIcon, ArrowLeft
} from 'lucide-react';

import HouseRatingBadge from '@/components/house/HouseRatingBadge';
import { useNearbyHouses, useHouseListingCount, HouseListing } from '@/hooks/useHouseListings';
import { useHouseMapPins } from '@/hooks/useHouseMapPins';
import { HouseListingCount } from '@/components/tenant/HouseListingCount';
import { useGeolocation } from '@/hooks/useGeolocation';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';

import { regionLabel } from '@/lib/ugandaDistricts';
import { UG_REGIONS, useUgDistricts, useUgSubcountiesByDistrict } from '@/hooks/useUgLocations';
import { normalizeAreaName, matchesArea } from '@/lib/listingAreaFilter';

import { distanceToHouse } from '@/lib/houseGeo';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

// Leaflet + tiles are heavy; only load the map bundle when the user opens it.
const HouseMapView = lazy(() =>
  import('@/components/tenant/HouseMapView').then((m) => ({ default: m.HouseMapView }))
);

// Region control is dataset-backed: Uganda's four official regions only.
// District/sub-county come from the ug_* reference tables. Legacy region values
// (SEO landing pages, older shared links) are still honoured as a search term
// and rendered as the current option so those links keep working.
const REGIONS = ['All Regions', ...UG_REGIONS];

/**
 * Popular city / district shortcuts kept for shared links, SEO landing pages and
 * the GPS auto-default (reverse-geocoding returns a city, not a region). They are
 * matched with the broad location OR filter, exactly as before.
 */
const POPULAR_AREAS = [
  'Kampala', 'Wakiso', 'Mukono', 'Jinja', 'Mbale',
  'Mbarara', 'Gulu', 'Lira', 'Fort Portal', 'Masaka',
  'Entebbe', 'Nansana', 'Kira', 'Bweyogerere',
];
const REGION_OPTIONS = [...REGIONS, ...POPULAR_AREAS];

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

const SITE_URL = 'https://welileapp.com';

// Location landing pages: /find-a-house/:regionSlug -> region-scoped SEO page.
// Keep the slug list narrow and matched to the REGIONS array so Google gets
// crisp, high-intent pages (e.g. "houses for rent in Kampala") without
// exploding the sitemap. New entries here also need to be added to
// scripts/generate-sitemap.ts.
export const REGION_LANDING_SLUGS: Record<string, string> = {
  kampala: 'Kampala',
  wakiso: 'Wakiso',
  mukono: 'Mukono',
  jinja: 'Jinja',
  mbale: 'Mbale',
  mbarara: 'Mbarara',
  gulu: 'Gulu',
  lira: 'Lira',
  'fort-portal': 'Fort Portal',
  masaka: 'Masaka',
  entebbe: 'Entebbe',
  nansana: 'Nansana',
  kira: 'Kira',
  bweyogerere: 'Bweyogerere',
  central: 'Central',
  eastern: 'Eastern',
  northern: 'Northern',
  western: 'Western',
};

type SortKey = 'newest' | 'price_asc' | 'price_desc' | 'nearest';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_asc', label: 'Price: Low to High' },
  { value: 'price_desc', label: 'Price: High to Low' },
  { value: 'nearest', label: 'Nearest first' },
];

const PRICE_CHIPS: { label: string; min?: number; max?: number }[] = [
  { label: 'Any price' },
  { label: 'Under 3k/day', max: 3000 },
  { label: '3k – 5k/day', min: 3000, max: 5000 },
  { label: '5k – 10k/day', min: 5000, max: 10000 },
  { label: '10k – 20k/day', min: 10000, max: 20000 },
  { label: '20k+/day', min: 20000 },
];

const AMENITY_TOGGLES: { key: 'hasWater' | 'hasElectricity' | 'hasSecurity' | 'hasParking' | 'isFurnished'; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'hasWater', label: 'Water', Icon: Droplets },
  { key: 'hasElectricity', label: 'Power', Icon: Zap },
  { key: 'hasSecurity', label: 'Security', Icon: ShieldCheck },
  { key: 'hasParking', label: 'Parking', Icon: Car },
  { key: 'isFurnished', label: 'Furnished', Icon: Sofa },
];

function HouseImageCarousel({ images, title, onImageClick, layout = 'vertical' }: { images: string[] | null; title: string; onImageClick?: (index: number) => void; layout?: 'vertical' | 'horizontal' }) {
  const [idx, setIdx] = useState(0);
  const sizeClass = layout === 'horizontal'
    ? 'aspect-[4/3] md:aspect-auto md:h-full md:min-h-[280px]'
    : 'aspect-[4/3]';
  if (!images || images.length === 0) {
    return (
      <div className={`w-full ${sizeClass} bg-muted rounded-xl flex items-center justify-center`}>
        <Home className="h-12 w-12 text-muted-foreground/20" />
      </div>
    );
  }
  return (
    <div className={`relative w-full ${sizeClass} overflow-hidden bg-muted rounded-xl group`}>
      <img
        src={images[idx]}
        alt={title}
        className="w-full h-full object-cover cursor-pointer transition-transform duration-500 group-hover:scale-105"
        loading="lazy"
        decoding="async"
        onClick={() => onImageClick?.(idx)}
      />
      {images.length > 1 && (
        <>
          <button type="button" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); setIdx(i => (i - 1 + images.length) % images.length); }}
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/90 text-foreground rounded-full p-1.5 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity active:scale-95">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); setIdx(i => (i + 1) % images.length); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/90 text-foreground rounded-full p-1.5 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity active:scale-95">
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1">
            {images.slice(0, 5).map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === idx ? 'bg-white w-4' : 'bg-white/50 w-1.5'}`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}


function PublicHouseCard({ listing, isFirst, onOpenDetails, userLat, userLng }: { listing: HouseListing; isFirst?: boolean; onOpenDetails?: (listing: HouseListing) => void; userLat?: number | null; userLng?: number | null }) {
  const categoryLabel = CATEGORIES.find(c => c.value === listing.house_category)?.label || listing.house_category;
  const dist = listing.distance_km;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState(0);

  const lightboxImages = useMemo(() =>
    (listing.image_urls || []).map((url, i) => ({ id: `${listing.id}-${i}`, image_url: url })),
    [listing.image_urls, listing.id]
  );

  const openLightbox = useCallback((index: number) => {
    setLightboxIdx(index);
    setLightboxOpen(true);
  }, []);

  // "New" badge for listings created within the last 14 days.
  const isNew = useMemo(() => {
    if (!listing.created_at) return false;
    return Date.now() - new Date(listing.created_at).getTime() < 14 * 86400000;
  }, [listing.created_at]);

  const amenities = [
    listing.has_water && 'Water',
    listing.has_electricity && 'Power',
    listing.has_security && 'Security',
    listing.has_parking && 'Parking',
    listing.is_furnished && 'Furnished',
  ].filter(Boolean) as string[];

  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      data-house-card=""
      data-house-id={listing.id}
      className="pb-6 border-b border-border/40 last:border-b-0"
      itemScope itemType="https://schema.org/Accommodation"
    >
      {/* Image */}
      <div
        className="relative cursor-pointer"
        onClick={() => onOpenDetails?.(listing)}
      >
        <HouseImageCarousel images={listing.image_urls} title={listing.title} onImageClick={openLightbox} layout="vertical" />

        {/* Top-left badges — Airbnb style */}
        <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
          {isNew && (
            <span className="bg-white text-foreground text-[11px] font-bold px-2.5 py-1 rounded-full shadow-sm">✨ New</span>
          )}
          {listing.verified && listing.status !== 'pending' && (
            <span className="bg-white text-foreground text-[11px] font-bold px-2.5 py-1 rounded-full shadow-sm flex items-center gap-1">
              <ShieldCheck className="h-3 w-3 text-success" /> Verified
            </span>
          )}
        </div>

        {/* Heart/rating — top right */}
        <HouseRatingBadge houseId={listing.id} houseLat={listing.latitude} houseLng={listing.longitude} className="absolute top-3 right-3" />
      </div>

      {/* Text below image — Airbnb layout */}
      <div className="mt-2.5 space-y-0.5" onClick={() => onOpenDetails?.(listing)} role="button" tabIndex={0}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold text-[15px] leading-tight line-clamp-1" itemProp="name">
            {listing.title}
          </h2>
          {dist !== undefined && dist < 9999 && (
            <span className="text-xs text-muted-foreground font-medium shrink-0">
              ~{dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`}
            </span>
          )}
        </div>

        <p className="text-sm text-muted-foreground" itemProp="address">
          {listing.region}{listing.district ? `, ${listing.district}` : ''}
        </p>

        <p className="text-sm text-muted-foreground">
          {categoryLabel} · {listing.number_of_rooms} room{listing.number_of_rooms > 1 ? 's' : ''}
          {amenities.length > 0 && ` · ${amenities.join(' · ')}`}
        </p>

        <div className="flex items-baseline gap-1.5 pt-1">
          <span className="font-semibold text-[15px]" itemProp="price">{formatUGX(listing.daily_rate)}</span>
          <span className="text-sm text-muted-foreground">/ day</span>
        </div>
      </div>

      {/* Fullscreen Lightbox */}
      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIdx}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        productName={listing.title}
        memoryKey={`house:${listing.id}`}
      />
    </motion.article>
  );
}


/**
 * Window-scroll virtualized list of house cards. Only the cards in (or near) the
 * viewport are mounted, so the page stays fast even with hundreds of listings —
 * crucial because each card mounts a Google Map iframe + multiple images.
 * Heights are measured dynamically since cards vary (amenities, description, thumbnails).
 */
function VirtualHouseList({ listings, onOpenDetails, userLat, userLng }: { listings: HouseListing[]; onOpenDetails?: (listing: HouseListing) => void; userLat?: number | null; userLng?: number | null }) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useWindowVirtualizer({
    count: listings.length,
    estimateSize: () => 380,
    overscan: 3,
    gap: 12,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index) => listings[index].id,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {items.map((vi) => {
        const listing = listings[vi.index];
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)` }}
          >
            <PublicHouseCard listing={listing} isFirst={vi.index === 0} onOpenDetails={onOpenDetails} userLat={userLat} userLng={userLng} />
          </div>
        );
      })}
    </div>
  );
}

export default function FindAHouse() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { regionSlug } = useParams<{ regionSlug?: string }>();
  const landingRegion = regionSlug ? REGION_LANDING_SLUGS[regionSlug.toLowerCase()] : undefined;
  const isLandingPage = !!landingRegion;
  const geo = useGeolocation(true);
  const [searchText, setSearchText] = useState(() => searchParams.get('q') || '');
  const [selectedRegion, setSelectedRegion] = useState(() => {
    if (landingRegion) return landingRegion;
    const r = searchParams.get('region');
    // Any stored region/area term is honoured (legacy links stored districts
    // and cities here); it is matched with the broad location OR filter.
    return r && r.trim() ? r : 'All Regions';
  });
  const [selectedCategory, setSelectedCategory] = useState(() => searchParams.get('category') || 'all');
  // Cascading location filters (region -> district -> sub-county/area -> village).
  // Options are derived from the loaded listings so they only show areas that
  // actually have houses. Works for both tenant and funder views.
  const [selectedDistrict, setSelectedDistrict] = useState(() => searchParams.get('district') || 'all');
  const [selectedSubCounty, setSelectedSubCounty] = useState(() => searchParams.get('subcounty') || 'all');
  const [selectedVillage, setSelectedVillage] = useState(() => searchParams.get('village') || 'all');
  // If the URL already carries a region (restored filtered list / shared link),
  // skip the geolocation auto-default so we don't override the chosen region.
  const [geoDefaultApplied, setGeoDefaultApplied] = useState(() => {
    if (landingRegion) return true;
    const r = searchParams.get('region');
    return !!(r && r.trim());
  });
  const [copied, setCopied] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(() => (searchParams.get('sort') as SortKey) || 'newest');
  const [minPrice, setMinPrice] = useState<number | undefined>(() => {
    const v = searchParams.get('min');
    return v ? Number(v) : undefined;
  });
  const [maxPrice, setMaxPrice] = useState<number | undefined>(() => {
    const v = searchParams.get('max');
    return v ? Number(v) : undefined;
  });
  const [minRooms, setMinRooms] = useState<number>(() => {
    const v = searchParams.get('rooms');
    return v ? Number(v) : 0;
  });
  const [amenities, setAmenities] = useState<{
    hasWater: boolean; hasElectricity: boolean; hasSecurity: boolean; hasParking: boolean; isFurnished: boolean;
  }>(() => {
    const list = searchParams.get('amenities')?.split(',').filter(Boolean) || [];
    return {
      hasWater: list.includes('hasWater'),
      hasElectricity: list.includes('hasElectricity'),
      hasSecurity: list.includes('hasSecurity'),
      hasParking: list.includes('hasParking'),
      isFurnished: list.includes('isFurnished'),
    };
  });
  const [showFilters, setShowFilters] = useState(false);
  // Search + location bar can be collapsed to give listings more room.
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  // Master collapse for the entire sticky filter bar.
  const [filterBarOpen, setFilterBarOpen] = useState(false);
  // Client-side pagination over the filtered set.
  const PAGE_SIZE = 12;
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(searchText, 250);
  const [showMap, setShowMap] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Lightweight full-dataset pins for the map — only fetched when map is open.
  const { data: mapPins } = useHouseMapPins({
    region: selectedRegion !== 'All Regions' ? selectedRegion : undefined,
    category: selectedCategory !== 'all' ? selectedCategory : undefined,
    district: selectedDistrict !== 'all' ? selectedDistrict : undefined,
    enabled: showMap,
  });

  // Funder context flows in from the funders dashboard "See all" link.
  const cameFromFunder = (location.state as { from?: string } | null)?.from === 'funder';

  // Serialize the active filters so a house detail page can link back to this
  // exact filtered list (breadcrumb "Filtered houses").
  const buildListSearch = useCallback(() => {
    const p = new URLSearchParams();
    if (searchText.trim()) p.set('q', searchText.trim());
    if (selectedRegion !== 'All Regions') p.set('region', selectedRegion);
    if (selectedDistrict !== 'all') p.set('district', selectedDistrict);
    if (selectedSubCounty !== 'all') p.set('subcounty', selectedSubCounty);
    if (selectedVillage !== 'all') p.set('village', selectedVillage);
    if (selectedCategory !== 'all') p.set('category', selectedCategory);
    if (sortKey !== 'newest') p.set('sort', sortKey);
    if (minPrice) p.set('min', String(minPrice));
    if (maxPrice) p.set('max', String(maxPrice));
    if (minRooms > 0) p.set('rooms', String(minRooms));
    const activeAmenityKeys = Object.entries(amenities).filter(([, v]) => v).map(([k]) => k);
    if (activeAmenityKeys.length) p.set('amenities', activeAmenityKeys.join(','));
    return p.toString();
  }, [searchText, selectedRegion, selectedDistrict, selectedSubCounty, selectedVillage, selectedCategory, sortKey, minPrice, maxPrice, minRooms, amenities]);

  const openDetails = useCallback((listing: HouseListing) => {
    navigate(`/house/${listing.short_code || listing.id}`, {
      state: { from: cameFromFunder ? 'funder' : undefined, listSearch: buildListSearch() },
    });
  }, [navigate, cameFromFunder, buildListSearch]);

  // A shared link can pin the area so whoever opens it sees houses near the
  // sharer's location, not their own. lat/lng/region come from the share button.
  const sharedLat = (() => { const v = Number(searchParams.get('lat')); return Number.isFinite(v) && v !== 0 ? v : null; })();
  const sharedLng = (() => { const v = Number(searchParams.get('lng')); return Number.isFinite(v) && v !== 0 ? v : null; })();
  const sharedRegion = searchParams.get('region');
  const hasSharedLocation = sharedLat !== null && sharedLng !== null;

  const effectiveLat = hasSharedLocation ? sharedLat : geo.latitude;
  const effectiveLng = hasSharedLocation ? sharedLng : geo.longitude;

  const toggleAmenity = (key: keyof typeof amenities) => {
    setAmenities(a => ({ ...a, [key]: !a[key] }));
  };

  const clearFilters = () => {
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
    setSortKey('newest');
  };

  // Selecting a broader area resets the narrower ones so we never keep a stale
  // district/village that no longer belongs to the new selection.
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

  useEffect(() => {
    if (!geoDefaultApplied && sharedRegion && REGION_OPTIONS.includes(sharedRegion)) {
      setSelectedRegion(sharedRegion);
      setGeoDefaultApplied(true);
      return;
    }
    if (!geoDefaultApplied && geo.city && !geo.loading) {
      const matched = REGION_OPTIONS.find(r => r.toLowerCase() === geo.city!.toLowerCase());
      if (matched) setSelectedRegion(matched);
      setGeoDefaultApplied(true);
    }
  }, [geo.city, geo.loading, geoDefaultApplied, sharedRegion]);

  const { listings, loading, loadingMore, hasMore, loadMore, metrics } = useNearbyHouses({
    latitude: effectiveLat,
    longitude: effectiveLng,
    // "All Regions" must show every house across the whole country (not just
    // houses near the user's GPS), so we pass a country-sized radius. A specific
    // region stays at 200km around the user.
    radiusKm: selectedRegion === 'All Regions' ? 100000 : 200,
    category: selectedCategory !== 'all' ? selectedCategory : undefined,
    region: selectedRegion !== 'All Regions' ? selectedRegion : undefined,
    district: selectedDistrict !== 'all' ? selectedDistrict : undefined,
    subCounty: selectedSubCounty !== 'all' ? selectedSubCounty : undefined,
    village: selectedVillage !== 'all' ? selectedVillage : undefined,
    search: debouncedSearch.trim() || undefined,
    minDailyRate: minPrice,
    maxDailyRate: maxPrice,
    minRooms: minRooms || undefined,
    hasWater: amenities.hasWater || undefined,
    hasElectricity: amenities.hasElectricity || undefined,
    hasSecurity: amenities.hasSecurity || undefined,
    hasParking: amenities.hasParking || undefined,
    isFurnished: amenities.isFurnished || undefined,
    sort: sortKey === 'nearest' ? undefined : sortKey,
    // Page through EVERY matching listing — no fixed cap.
    paginate: true,
    // Show the first screen of cards fast; infinite scroll loads more as
    // the user scrolls. Map view can lazy-load a lightweight pins query
    // when opened (id + lat/lng only).
    pageSize: 24,
    // Start fetching immediately — don't wait for GPS. When geolocation
    // resolves, the list re-sorts by distance client-side.
    enabled: true,
  });

  // Exact listed-house counts (verified + not-yet-verified) for the active
  // filter set — replaces the loaded-rows "24+" counter that undervalued us.
  const listingCounts = useHouseListingCount({
    region: selectedRegion !== 'All Regions' ? selectedRegion : undefined,
    district: selectedDistrict !== 'all' ? selectedDistrict : undefined,
    subCounty: selectedSubCounty !== 'all' ? selectedSubCounty : undefined,
    village: selectedVillage !== 'all' ? selectedVillage : undefined,
    category: selectedCategory !== 'all' ? selectedCategory : undefined,
    minDailyRate: minPrice,
    maxDailyRate: maxPrice,
    minRooms: minRooms || undefined,
    hasWater: amenities.hasWater || undefined,
    hasElectricity: amenities.hasElectricity || undefined,
    hasSecurity: amenities.hasSecurity || undefined,
    hasParking: amenities.hasParking || undefined,
    isFurnished: amenities.isFurnished || undefined,
    search: debouncedSearch.trim() || undefined,
  });

  // Infinite scroll: a bottom sentinel loads the next page as it nears the
  // viewport. `loadMore` self-guards against overlapping/finished requests.
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '800px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  const filtered = useMemo(() => {
    let result = [...listings];
    // Same matching rules as the server query (ids where upgraded, normalised
    // text otherwise) so the list, the map and the counters agree.
    result = result.filter(l => matchesArea(l, {
      district: selectedDistrict !== 'all' ? selectedDistrict : undefined,
      subCounty: selectedSubCounty !== 'all' ? selectedSubCounty : undefined,
      village: selectedVillage !== 'all' ? selectedVillage : undefined,
    }));
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(l =>
        l.region.toLowerCase().includes(q) ||
        l.address.toLowerCase().includes(q) ||
        (l.district || '').toLowerCase().includes(q) ||
        l.title.toLowerCase().includes(q)
      );
    }
    if (minPrice !== undefined) {
      result = result.filter(l => l.daily_rate >= minPrice);
    }
    if (maxPrice !== undefined) {
      result = result.filter(l => l.daily_rate <= maxPrice);
    }
    if (minRooms > 0) {
      result = result.filter(l => l.number_of_rooms >= minRooms);
    }
    if (amenities.hasWater) result = result.filter(l => l.has_water);
    if (amenities.hasElectricity) result = result.filter(l => l.has_electricity);
    if (amenities.hasSecurity) result = result.filter(l => l.has_security);
    if (amenities.hasParking) result = result.filter(l => l.has_parking);
    if (amenities.isFurnished) result = result.filter(l => l.is_furnished);
    switch (sortKey) {
      case 'price_desc':
        result.sort((a, b) => b.daily_rate - a.daily_rate);
        break;
      case 'newest':
        result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        break;
      case 'nearest':
        result.sort((a, b) => {
          const da = a.distance_km ?? (effectiveLat && effectiveLng ? distanceToHouse(a, effectiveLat, effectiveLng) : null) ?? 99999;
          const db = b.distance_km ?? (effectiveLat && effectiveLng ? distanceToHouse(b, effectiveLat, effectiveLng) : null) ?? 99999;
          return da - db;
        });
        break;
      case 'price_asc':
      default:
        result.sort((a, b) => a.daily_rate - b.daily_rate);
        break;
    }
    return result;
  }, [listings, debouncedSearch, minPrice, maxPrice, minRooms, amenities, sortKey, effectiveLat, effectiveLng, selectedDistrict, selectedSubCounty, selectedVillage]);

  // Reset to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, minPrice, maxPrice, minRooms, amenities, sortKey, selectedRegion, selectedCategory, selectedDistrict, selectedSubCounty, selectedVillage]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  const goToPage = useCallback((next: number) => {
    const target = Math.max(1, next);
    setPage(target);
    // Fetch more from the server when the tenant walks past the loaded set.
    if (target >= totalPages && hasMore) loadMore();
    document.getElementById('house-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [totalPages, hasMore, loadMore]);

  // District / sub-county options come from the official ug_* dataset (shared
  // cached hooks — one request per level, cached for the session). Village stays
  // derived from the loaded listings, compared case-insensitively so legacy rows
  // are never dropped.
  const isOfficialRegion = (UG_REGIONS as readonly string[]).includes(selectedRegion);
  const { data: ugDistricts = [] } = useUgDistricts(isOfficialRegion ? selectedRegion : null);
  const selectedDistrictId = useMemo(
    () => ugDistricts.find(d => normalizeAreaName(d.name) === normalizeAreaName(selectedDistrict))?.id ?? null,
    [ugDistricts, selectedDistrict],
  );
  const { data: ugSubcounties = [] } = useUgSubcountiesByDistrict(selectedDistrictId);

  const districtOptions = useMemo(() => ugDistricts.map(d => d.name), [ugDistricts]);
  const subCountyOptions = useMemo(
    // Two counties in a district can carry the same sub-county name; dedupe by
    // name since matching is name/id based, not county based.
    () => Array.from(new Set(ugSubcounties.map(s => s.name))).sort((a, b) => a.localeCompare(b)),
    [ugSubcounties],
  );

  const villageOptions = useMemo(() => {
    const set = new Set<string>();
    listings.forEach(l => {
      if (selectedDistrict !== 'all' && normalizeAreaName(l.district) !== normalizeAreaName(selectedDistrict)) return;
      if (selectedSubCounty !== 'all' && normalizeAreaName(l.sub_county) !== normalizeAreaName(selectedSubCounty)) return;
      const v = (l.village || '').trim();
      if (v) set.add(v);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [listings, selectedDistrict, selectedSubCounty]);

  const activeFilterCount =
    (searchText.trim().length > 0 ? 1 : 0) +
    (selectedRegion !== 'All Regions' ? 1 : 0) +
    (selectedCategory !== 'all' ? 1 : 0) +
    (selectedDistrict !== 'all' ? 1 : 0) +
    (selectedSubCounty !== 'all' ? 1 : 0) +
    (selectedVillage !== 'all' ? 1 : 0) +
    (minPrice || maxPrice ? 1 : 0) +
    (minRooms > 0 ? 1 : 0) +
    Object.values(amenities).filter(Boolean).length +
    (sortKey !== 'newest' ? 1 : 0);

  const sortLabel = SORT_OPTIONS.find(s => s.value === sortKey)?.label ?? '';

  const hasGPS = !!(effectiveLat && effectiveLng);

  const shareUrl = user
    ? `${SITE_URL}/find-a-house?ref=${user.id}`
    : `${SITE_URL}/find-a-house`;

  const handleShare = async () => {
    const shareData = {
      title: 'Find Affordable Houses — Daily Rent | Welile',
      text: 'Find affordable houses near you with daily rent. Pay as you stay!',
      url: shareUrl,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch {}
    } else {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast({ title: 'Link copied!', description: 'Share it with friends & family.' });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const pageTitle = isLandingPage
    ? `Houses for Rent in ${landingRegion} — Daily Rent from UGX | Welile`
    : hasGPS && geo.city
      ? `Houses for Rent Near ${geo.city} — Daily Rent | Welile`
      : 'Find a House Near You — Daily Rent | Welile';

  const pageDescription = isLandingPage
    ? `Browse verified houses for rent in ${landingRegion}, Uganda. Pay daily — no big deposits. Single rooms, bedsitters and family homes with photos, prices and Google Maps locations.`
    : 'Browse affordable rental houses near you. Pay daily rent — no big deposits. Verified listings with Google Maps locations across Uganda.';

  const lowestPrice = filtered.length > 0 ? filtered[0].daily_rate : null;
  const seoDescription = lowestPrice
    ? isLandingPage
      ? `Houses for rent in ${landingRegion} from ${formatUGX(lowestPrice)}/day. ${filtered.length} verified listings on Welile. No deposits — pay daily and move in today.`
      : `Rent houses from ${formatUGX(lowestPrice)}/day in Uganda. No deposits. ${filtered.length} verified listings. Pay daily — move in today!`
    : pageDescription;

  const canonicalPath = isLandingPage ? `/find-a-house/${regionSlug!.toLowerCase()}` : '/find-a-house';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: pageTitle,
    description: seoDescription,
    url: `${SITE_URL}/find-a-house`,
    publisher: {
      '@type': 'Organization',
      name: 'Welile Technologies Limited',
      url: SITE_URL,
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: filtered.length,
      itemListElement: filtered.slice(0, 10).map((l, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'Accommodation',
          name: l.title,
          description: `${l.house_category?.replace(/_/g, ' ')} · ${l.number_of_rooms} rooms · ${formatUGX(l.daily_rate)}/day`,
          address: { '@type': 'PostalAddress', addressLocality: l.region, addressCountry: 'UG', streetAddress: l.address },
          ...(l.latitude && l.longitude ? {
            geo: { '@type': 'GeoCoordinates', latitude: l.latitude, longitude: l.longitude }
          } : {}),
          ...(l.image_urls?.[0] ? { image: l.image_urls[0] } : {}),
          offers: {
            '@type': 'Offer',
            price: l.daily_rate,
            priceCurrency: 'UGX',
            availability: 'https://schema.org/InStock',
            priceValidUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          },
        },
      })),
    },
  };

  return (
    <>
      <Helmet>
        <title>{pageTitle}</title>
        <meta name="description" content={seoDescription} />
        {isLandingPage ? (
          <link rel="canonical" href={`${SITE_URL}/find-a-house/${regionSlug!.toLowerCase()}`} />
        ) : (
          <link rel="canonical" href="https://welileapp.com/find-a-house" />
        )}
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={seoDescription} />
        <meta property="og:url" content={`${SITE_URL}${canonicalPath}`} />
        <meta property="og:type" content="website" />
        {filtered[0]?.image_urls?.[0] && <meta property="og:image" content={filtered[0].image_urls[0]} />}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={pageTitle} />
        <meta name="twitter:description" content={seoDescription} />
        <meta name="robots" content="index, follow" />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <div className="min-h-screen bg-background">
        {/* Skip links for keyboard / screen-reader users */}
        <a
          href="#house-list"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:font-bold focus:shadow-lg focus-visible:ring-4 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Skip to house list
        </a>
        <a
          href="#first-map-cta"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-44 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:font-bold focus:shadow-lg focus-visible:ring-4 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Skip to Google Maps links
        </a>
        {/* Header */}
        <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border">
          <div className="max-w-2xl mx-auto px-4 pt-3 flex justify-center">
            <img
              src={houseSearchingIllustration.url}
              alt="Illustration of a person searching for a house to rent"
              className="h-24 w-auto sm:h-28"
              loading="lazy"
            />
          </div>
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate('/dashboard/tenant')}
                aria-label="Go back"
                className="shrink-0 -ml-2 h-9 w-9"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <Home className="h-5 w-5 text-primary shrink-0" />
              <h1 className="font-bold text-lg truncate">
                {isLandingPage
                  ? `Houses for Rent in ${landingRegion}`
                  : hasGPS && geo.city
                    ? `Houses Near ${geo.city}`
                    : 'Find a House'}
              </h1>
            </div>
          </div>
        </header>

        {/* Filters */}
        <div className="sticky top-[53px] z-30 bg-background/95 backdrop-blur-md border-b border-border">
          <div className="max-w-2xl mx-auto px-4 py-2">
            <button
              type="button"
              onClick={() => setFilterBarOpen(o => !o)}
              aria-expanded={filterBarOpen}
              className="w-full flex items-center justify-between gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <span className="inline-flex items-center gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {filterBarOpen ? 'Hide search & filters' : 'Show search & filters'}
                {!filterBarOpen && activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                    {activeFilterCount}
                  </span>
                )}
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${filterBarOpen ? 'rotate-180' : ''}`} />
            </button>
            {filterBarOpen && (
              <div className="mt-2 space-y-2">
            <button
              type="button"
              onClick={() => setSearchBarOpen(o => !o)}
              aria-expanded={searchBarOpen}
              aria-controls="find-a-house-searchbar"
              className="w-full flex items-center justify-between gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <span className="inline-flex items-center gap-1.5">
                <Search className="h-3.5 w-3.5" />
                {searchBarOpen ? 'Hide search & location' : 'Search & location'}
                {!searchBarOpen && activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                    {activeFilterCount}
                  </span>
                )}
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${searchBarOpen ? 'rotate-180' : ''}`} />
            </button>
            {searchBarOpen && (
            <div id="find-a-house-searchbar" className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by region, district, or address..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="pl-10 pr-9"
              />
              {searchText !== debouncedSearch && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
              )}
            </div>
            <div className="flex gap-2">
              <Select value={selectedRegion} onValueChange={handleRegionChange}>
                <SelectTrigger className="flex-1 h-9 text-xs"><SelectValue placeholder="Region" /></SelectTrigger>
                <SelectContent>
                  {(REGION_OPTIONS.includes(selectedRegion) ? REGION_OPTIONS : [...REGION_OPTIONS, selectedRegion])
                    .map(r => <SelectItem key={r} value={r}>{regionLabel(r)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                <SelectTrigger className="flex-1 h-9 text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* Cascading location filters: district -> area/sub-county -> village.
                Only render a level when there are houses with that data. */}
            {(districtOptions.length > 0 || subCountyOptions.length > 0 || villageOptions.length > 0) && (
              <div className="flex gap-2">
                {districtOptions.length > 0 && (
                  <Select value={selectedDistrict} onValueChange={handleDistrictChange}>
                    <SelectTrigger className="flex-1 h-9 text-xs min-w-0"><SelectValue placeholder="District" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All districts</SelectItem>
                      {districtOptions.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {subCountyOptions.length > 0 && (
                  <Select value={selectedSubCounty} onValueChange={handleSubCountyChange}>
                    <SelectTrigger className="flex-1 h-9 text-xs min-w-0"><SelectValue placeholder="Town / Area" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All areas</SelectItem>
                      {subCountyOptions.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {villageOptions.length > 0 && (
                  <Select value={selectedVillage} onValueChange={setSelectedVillage}>
                    <SelectTrigger className="flex-1 h-9 text-xs min-w-0"><SelectValue placeholder="Village / Zone" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All villages</SelectItem>
                      {villageOptions.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
            </div>
            )}
            {/* Filter toggle row */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant={showFilters || activeFilterCount > 0 ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowFilters(s => !s)}
                className="h-9 gap-1.5 w-full"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-background/30 text-[10px] font-bold">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </div>

            {/* Expandable filter panel */}
            {showFilters && (
              <div id="find-a-house-filters" className="space-y-4 pt-2">
                {/* Daily rent */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Daily rent</p>
                  <div className="flex flex-wrap gap-1.5">
                    {PRICE_CHIPS.map(chip => {
                      const active = (chip.min ?? undefined) === minPrice && (chip.max ?? undefined) === maxPrice;
                      return (
                        <button
                          key={chip.label}
                          type="button"
                          onClick={() => { setMinPrice(chip.min); setMaxPrice(chip.max); }}
                          aria-pressed={active}
                          className={`px-2.5 py-1 rounded-full border text-[11px] font-medium transition ${active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
                        >
                          {chip.label}
                        </button>
                      );
                    })}
                  </div>
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
                  <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
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

                {/* Must have */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Must have</p>
                  <div className="flex flex-wrap gap-1.5">
                    {AMENITY_TOGGLES.map(({ key, label, Icon }) => {
                      const active = amenities[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggleAmenity(key)}
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

                {/* Clear + Apply */}
                <div className="flex flex-col gap-2 pt-1">
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="inline-flex items-center justify-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" /> Clear all filters
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowFilters(false)}
                    className="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-semibold shadow-sm hover:bg-primary/90 active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <SlidersHorizontal className="h-4 w-4" /> Apply filters
                  </button>
                </div>
              </div>
            )}
              </div>
            )}
          </div>
        </div>

        {/* Listings */}
        <main
          id="house-list"
          tabIndex={-1}
          className={`${showMap ? 'max-w-7xl' : 'max-w-5xl'} mx-auto px-4 py-4 space-y-3 pb-20`}
        >
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full rounded-2xl" />
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 space-y-3">
              <Home className="h-12 w-12 text-muted-foreground/30 mx-auto" />
              <p className="text-muted-foreground font-medium">No houses found</p>
              <p className="text-xs text-muted-foreground">Try a different region, price, or fewer filters</p>
              {activeFilterCount > 0 && (
                <Button variant="outline" size="sm" onClick={clearFilters} className="gap-1.5">
                  <X className="h-4 w-4" /> Clear filters
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
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
                  suffix={`${sortLabel.toLowerCase()}${loadingMore ? ' · loading more…' : ''}`}
                />
              </div>

              {showMap ? (
                <div className="flex flex-col md:flex-row gap-3">
                  {/* Map — full width on mobile, sticky side pane on desktop */}
                  <div className="md:order-2 md:w-[44%] md:sticky md:top-4 h-[55vh] md:h-[calc(100vh-7rem)] rounded-2xl overflow-hidden border border-border shrink-0">
                    <Suspense fallback={<Skeleton className="h-full w-full" />}>
                      <HouseMapView
                        listings={filtered}
                        mapPins={mapPins}
                        userCoords={
                          effectiveLat != null && effectiveLng != null
                            ? { lat: effectiveLat, lng: effectiveLng }
                            : null
                        }
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        onOpenDetails={openDetails}
                      />
                    </Suspense>
                  </div>
                  {/* List — hidden on mobile while the map is open (toggle), shown beside map on desktop */}
                  <div className="hidden md:block md:order-1 md:flex-1 min-w-0">
                    <VirtualHouseList listings={paginated} onOpenDetails={openDetails} userLat={effectiveLat} userLng={effectiveLng} />
                  </div>
                </div>
              ) : (
                <VirtualHouseList listings={paginated} onOpenDetails={openDetails} userLat={effectiveLat} userLng={effectiveLng} />
              )}

              {/* Pagination */}
              <nav aria-label="House list pages" className="flex items-center justify-between gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="gap-1"
                >
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <span className="text-xs text-muted-foreground font-medium">
                  Page {currentPage} of {totalPages}
                  {hasMore ? '+' : ''}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage >= totalPages && !hasMore}
                  className="gap-1"
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>
              {loadingMore && (
                <LoadMoreProgress
                  loadedCount={filtered.length}
                  pagesFetched={metrics.pagesFetched}
                  hasMore={hasMore}
                  skeletonCount={2}
                  skeletonClassName="h-48 w-full rounded-2xl"
                />
              )}
            </>
          )}
        </main>

      </div>
    </>
  );
}
