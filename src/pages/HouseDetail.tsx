import { useState, useEffect, useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { ImageLightbox } from '@/components/marketplace/ImageLightbox';
import { useParams, useNavigate, useLocation, useSearchParams, Link } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

import { supabase } from '@/integrations/supabase/client';
import { HouseListing } from '@/hooks/useHouseListings';
import { formatUGX } from '@/lib/rentCalculations';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

import { WhatsAppAgentButton } from '@/components/tenant/WhatsAppAgentButton';
import { ShareHouseButton } from '@/components/tenant/ShareHouseButton';
import { useHouseReviews } from '@/hooks/useHouseReviews';
import WriteHouseReviewForm from '@/components/reviews/WriteHouseReviewForm';
import HouseReviewsList from '@/components/reviews/HouseReviewsList';
import SaveHouseButton from '@/components/house/SaveHouseButton';
import { useMapLinkAnnouncer } from '@/hooks/useMapLinkAnnouncer';
import HouseQASection from '@/components/house/HouseQASection';
import PriceComparison from '@/components/house/PriceComparison';
import VisitBadge from '@/components/house/VisitBadge';
import NearbyAmenities from '@/components/house/NearbyAmenities';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';
import { motion } from 'framer-motion';
import {
  Home, DoorOpen, Droplets, Zap, ShieldCheck, Car, Sofa,
  ChevronLeft, ChevronRight, Clock, ExternalLink, Share2, Check, ArrowLeft, Star,
  Eye, Navigation, Copy, MessageCircle, Video,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { parseHouseVideo } from '@/lib/houseVideoUrl';

const SITE_URL = 'https://welileapp.com';

const CATEGORIES = [
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

// Valid FindAHouse filter keys and value sets. Keep in sync with FindAHouse.tsx.
const VALID_FILTER_KEYS = new Set(['q', 'region', 'category', 'sort', 'verified', 'max', 'amenities']);
const VALID_REGIONS = new Set([
  'All Regions', 'Central', 'Eastern', 'Northern', 'Western',
  'Kampala', 'Wakiso', 'Mukono', 'Jinja', 'Mbale',
  'Mbarara', 'Gulu', 'Lira', 'Fort Portal', 'Masaka',
  'Entebbe', 'Nansana', 'Kira', 'Bweyogerere',
]);
const VALID_CATEGORIES = new Set([
  'all', 'single_room', 'double_room', 'bedsitter', 'one_bedroom',
  'two_bedroom', 'three_bedroom', 'studio', 'shop',
]);
const VALID_SORTS = new Set(['price_asc', 'price_desc', 'newest', 'nearest']);
const VALID_AMENITIES = new Set([
  'has_water', 'has_electricity', 'has_security', 'has_parking', 'is_furnished',
]);

/**
 * Parse and validate a query string saved from the FindAHouse filter bar.
 * Returns a normalized query string (without the leading '?') when every key and
 * value is recognised, otherwise reports invalid so the UI can fall back to
 * /find-a-house with default filters.
 */
function validateListSearch(raw: string): { valid: true; search: string } | { valid: false } {
  if (!raw || !raw.trim()) return { valid: false };
  try {
    const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    const normalized = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      if (!VALID_FILTER_KEYS.has(key)) return { valid: false };
      const trimmed = value.trim();
      if (!trimmed) continue;
      switch (key) {
        case 'q':
          normalized.set('q', trimmed);
          break;
        case 'region':
          if (!VALID_REGIONS.has(trimmed)) return { valid: false };
          if (trimmed !== 'All Regions') normalized.set('region', trimmed);
          break;
        case 'category':
          if (!VALID_CATEGORIES.has(trimmed)) return { valid: false };
          if (trimmed !== 'all') normalized.set('category', trimmed);
          break;
        case 'sort':
          if (!VALID_SORTS.has(trimmed)) return { valid: false };
          normalized.set('sort', trimmed);
          break;
        case 'verified':
          if (trimmed !== '1') return { valid: false };
          normalized.set('verified', '1');
          break;
        case 'max':
          if (!/^[1-9]\d*$/.test(trimmed)) return { valid: false };
          normalized.set('max', trimmed);
          break;
        case 'amenities': {
          const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
          if (!parts.length) continue;
          if (parts.some(p => !VALID_AMENITIES.has(p))) return { valid: false };
          normalized.set('amenities', parts.join(','));
          break;
        }
      }
    }
    const search = normalized.toString();
    return search ? { valid: true, search } : { valid: false };
  } catch {
    return { valid: false };
  }
}

export default function HouseDetail() {
  const announceMap = useMapLinkAnnouncer();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  // Validate the preserved FindAHouse filters so that a malformed or empty deep
  // link cannot break navigation. When invalid, the breadcrumb/back button fall
  // back to /find-a-house with its default filters.
  const navState = location.state as { from?: string; listSearch?: string } | null;
  const fromFunder = navState?.from === 'funder' || searchParams.get('from') === 'funder';
  const rawListSearch = navState?.listSearch || searchParams.get('list') || '';
  const validated = validateListSearch(rawListSearch);
  const listSearch = validated.valid ? validated.search : '';
  const cameFromFilteredList = validated.valid;
  const filteredListTo = {
    pathname: '/find-a-house',
    search: listSearch ? `?${listSearch}` : '',
  };
  const goToFilteredList = () => {
    navigate(filteredListTo, { state: { from: 'funder', listSearch } });
  };


  const [mapCopied, setMapCopied] = useState(false);
  const [listing, setListing] = useState<(HouseListing & { agent_phone?: string | null; agent_name?: string | null }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [imgIdx, setImgIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  
  const { reviews, summary, myReview, loading: reviewsLoading, refetch: refetchReviews } = useHouseReviews(id);

  useEffect(() => {
    if (!id) return;
    async function fetchListing() {
      setLoading(true);
      // If id looks like a UUID, query by id; otherwise try short_code
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      // Explicit non-PII column list: caretaker / LC1 chairperson contact
      // fields are not granted to anonymous visitors, so `select('*')` would
      // be rejected for logged-out users. These columns cover everything the
      // public listing page renders.
      const PUBLIC_LISTING_COLS =
        'id, landlord_id, agent_id, title, description, house_category, number_of_rooms, monthly_rent, daily_rate, access_fee, platform_fee, total_monthly_cost, region, district, sub_county, village, address, latitude, longitude, has_water, has_electricity, has_security, has_parking, is_furnished, amenities, image_urls, status, tenant_id, landlord_accepted, verified, verified_by, verified_at, created_at, updated_at, geo_point, caretaker_user_id, is_agent_caretaker, landlord_has_smartphone, lc1_chairperson_village, listing_bonus_paid, listing_bonus_paid_at, video_url, short_code, placement_bonus_paid_at, is_hidden, listed_bonus_paid, listed_bonus_paid_at, reserved_by, reserved_at, suspended_tenant_id';
      const query = isUuid
        ? supabase.from('house_listings').select(PUBLIC_LISTING_COLS).eq('id', id).single()
        : supabase.from('house_listings').select(PUBLIC_LISTING_COLS).eq('short_code', id).single();

      const { data } = await query;

      if (data) {
        const { data: agent } = await supabase
          .from('profiles')
          .select('phone, full_name')
          .eq('id', data.agent_id)
          .single();

        setListing({
          ...(data as any),
          agent_phone: agent?.phone ?? null,
          agent_name: agent?.full_name ?? null,
        });
      }
      setLoading(false);
    }
    fetchListing();
  }, [id]);

  const shareUrl = `${SITE_URL}/house/${listing?.short_code || id}`;
  const images = listing?.image_urls || [];
  const houseVideo = parseHouseVideo(listing?.video_url);
  const lightboxImages = useMemo(() =>
    images.map((url, i) => ({ id: `detail-${i}`, image_url: url })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listing?.id, images.length]
  );

  const handleShare = async () => {
    const richUrl = shareUrl;
    const shareData = {
      title: listing ? `${listing.title} — Daily Rent | Welile` : 'House for Rent | Welile',
      text: listing
        ? `Check out this house: ${listing.title} in ${listing.region} for ${formatUGX(listing.daily_rate)}/day on Welile!`
        : 'Check out this house on Welile!',
      url: richUrl,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch {}
    } else {
      await handleCopyLink();
    }
  };

  const handleCopyLink = async () => {
    const richUrl = shareUrl;
    const shareText = listing
      ? `🏠 Check out this house on Welile!\n\n*${listing.title}*\n📍 ${listing.region}\n💰 ${formatUGX(listing.daily_rate)}/day\n\n👉 ${richUrl}`
      : richUrl;
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      toast({ title: 'Link copied!', description: 'Paste it anywhere to share this house.' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' });
    }
  };

  // Deep link that re-opens THIS house AND preserves the originating filtered
  // list so the recipient gets the same breadcrumb-back behaviour.
  const filteredDeepLink = `${SITE_URL}/house/${listing?.short_code || id}?from=funder${listSearch ? `&list=${encodeURIComponent(listSearch)}` : ''}`;

  const handleShareFilteredLink = async () => {
    const shareData = {
      title: listing ? `${listing.title} — Daily Rent | Welile` : 'House for Rent | Welile',
      text: listing
        ? `Check out this house (with my saved house filters): ${listing.title} in ${listing.region} on Welile!`
        : 'Check out this house on Welile!',
      url: filteredDeepLink,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); return; } catch { /* fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(filteredDeepLink);
      setCopied(true);
      toast({ title: 'Filtered link copied!', description: 'Opens this house with the same list filters.' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' });
    }
  };

  const ogLocation = listing
    ? [listing.region, listing.district].filter(Boolean).join(', ')
    : '';
  const ogTitle = listing
    ? `${listing.title} in ${listing.region} — ${formatUGX(listing.daily_rate)}/day | Welile`
    : 'House for Rent | Welile';
  const ogDescription = listing
    ? `${listing.title} — ${listing.house_category?.replace(/_/g, ' ')}, ${listing.number_of_rooms} room${listing.number_of_rooms === 1 ? '' : 's'} in ${ogLocation}. ${formatUGX(listing.daily_rate)}/day. Pay as you stay with Welile!`
    : 'Find affordable daily-rent houses on Welile.';
  const ogImage = listing?.image_urls?.[0] || `${SITE_URL}/og-image.png`;

  // Structured data so individual houses get rich results (price, photo) in Google.
  const houseJsonLd = listing
    ? {
        '@context': 'https://schema.org',
        '@type': 'RealEstateListing',
        name: listing.title,
        description: ogDescription,
        url: shareUrl,
        datePosted: listing.created_at ? new Date(listing.created_at).toISOString().slice(0, 10) : undefined,
        numberOfRooms: listing.number_of_rooms,
        ...(listing.image_urls?.length ? { image: listing.image_urls } : {}),
        address: {
          '@type': 'PostalAddress',
          addressLocality: listing.region,
          addressRegion: listing.district || listing.region,
          addressCountry: 'UG',
          streetAddress: listing.address,
        },
        ...(listing.latitude && listing.longitude
          ? { geo: { '@type': 'GeoCoordinates', latitude: listing.latitude, longitude: listing.longitude } }
          : {}),
        amenityFeature: [
          listing.has_water && { '@type': 'LocationFeatureSpecification', name: 'Running Water', value: true },
          listing.has_electricity && { '@type': 'LocationFeatureSpecification', name: 'Electricity', value: true },
          listing.has_security && { '@type': 'LocationFeatureSpecification', name: 'Security', value: true },
          listing.has_parking && { '@type': 'LocationFeatureSpecification', name: 'Parking', value: true },
          listing.is_furnished && { '@type': 'LocationFeatureSpecification', name: 'Furnished', value: true },
        ].filter(Boolean),
        offers: {
          '@type': 'Offer',
          price: listing.daily_rate,
          priceCurrency: 'UGX',
          availability: listing.tenant_id ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
          priceValidUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          url: shareUrl,
        },
      }
    : null;

  const breadcrumbJsonLd = listing
    ? {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Find a House', item: `${SITE_URL}/find-a-house` },
          { '@type': 'ListItem', position: 2, name: listing.title, item: shareUrl },
        ],
      }
    : null;

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Skeleton className="h-72 w-full" />
        <div className="p-4 space-y-4">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-4">
        <Home className="h-12 w-12 text-muted-foreground/30" />
        <p className="text-muted-foreground font-medium">House not found</p>
        <Button variant="outline" onClick={() => navigate('/find-a-house')}>Browse Houses</Button>
      </div>
    );
  }

  const categoryLabel = CATEGORIES.find(c => c.value === listing.house_category)?.label || listing.house_category;
  const isPending = !listing.verified || listing.status === 'pending';
  const mapLink = listing.latitude && listing.longitude
    ? `https://www.google.com/maps/search/?api=1&query=${listing.latitude},${listing.longitude}`
    : null;
  const directionsLink = listing.latitude && listing.longitude
    ? `https://www.google.com/maps/dir/?api=1&destination=${listing.latitude},${listing.longitude}&travelmode=driving`
    : null;
  const mapEmbed = listing.latitude && listing.longitude
    ? `https://maps.google.com/maps?q=${listing.latitude},${listing.longitude}&z=15&output=embed`
    : null;

  const amenities = [
    listing.has_water && { icon: Droplets, label: 'Running Water', color: 'text-blue-500' },
    listing.has_electricity && { icon: Zap, label: 'Electricity', color: 'text-amber-500' },
    listing.has_security && { icon: ShieldCheck, label: 'Security', color: 'text-emerald-500' },
    listing.has_parking && { icon: Car, label: 'Parking', color: 'text-violet-500' },
    listing.is_furnished && { icon: Sofa, label: 'Furnished', color: 'text-rose-500' },
  ].filter(Boolean) as { icon: any; label: string; color: string }[];

  return (
    <>
      <Helmet>
        <title>{ogTitle}</title>
        <meta name="description" content={ogDescription} />
        <link rel="canonical" href={shareUrl} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={shareUrl} />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={ogDescription} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:site_name" content="Welile" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={ogTitle} />
        <meta name="twitter:description" content={ogDescription} />
        <meta name="twitter:image" content={ogImage} />
        {houseJsonLd && (
          <script type="application/ld+json">{JSON.stringify(houseJsonLd)}</script>
        )}
        {breadcrumbJsonLd && (
          <script type="application/ld+json">{JSON.stringify(breadcrumbJsonLd)}</script>
        )}
      </Helmet>
      <div className="min-h-screen bg-background pb-28">
        {/* ── "Back to search results" bar + breadcrumb ── */}
        {(fromFunder || cameFromFilteredList) && (
          <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border">
            <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center gap-3">
              <button
                onClick={goToFilteredList}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground rounded-lg px-2 py-1 -ml-2 hover:bg-accent/50 active:scale-95 transition-all touch-manipulation shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
                {cameFromFilteredList ? 'Back to search results' : 'Back'}
              </button>
              <Breadcrumb className="min-w-0">
                <BreadcrumbList className="flex-nowrap">
                  {fromFunder && (
                    <>
                      <BreadcrumbItem>
                        <BreadcrumbLink asChild>
                          <Link to="/dashboard/funder">Dashboard</Link>
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                    </>
                  )}
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <Link
                        to={filteredListTo}
                        state={{ from: 'funder', listSearch }}
                      >
                        {cameFromFilteredList ? 'Search results' : 'Houses'}
                      </Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{listing.title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <button
                onClick={handleShareFilteredLink}
                className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-primary rounded-lg px-2 py-1.5 hover:bg-primary/10 active:scale-95 transition-all touch-manipulation shrink-0"
                title="Share a link that opens this house with the same list filters"
              >
                {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
                <span className="hidden sm:inline">Share filtered link</span>
              </button>
            </div>
          </div>
        )}
        {/* ── Full-bleed Hero Image Gallery ── */}
        <div className="relative w-full">
          {images.length > 0 ? (
            <>
              {/* Main hero image — edge-to-edge */}
              <div
                className="relative w-full h-[55vh] min-h-[320px] max-h-[520px] bg-muted cursor-pointer"
                onClick={() => setLightboxOpen(true)}
              >
                <img
                  src={images[imgIdx]}
                  alt={listing.title}
                  className="w-full h-full object-cover"
                />
                {/* Gradient scrim for top controls */}
                <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/50 to-transparent" />

                {/* Carousel nav */}
                {images.length > 1 && (
                  <>
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); setImgIdx(i => (i - 1 + images.length) % images.length); }}
                      className="absolute left-3 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur-sm text-foreground rounded-full p-2 shadow-lg active:scale-95 transition-transform">
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); setImgIdx(i => (i + 1) % images.length); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur-sm text-foreground rounded-full p-2 shadow-lg active:scale-95 transition-transform">
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    {/* Dots */}
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
                      {images.map((_, i) => (
                        <button key={i} onClick={(e) => { e.stopPropagation(); setImgIdx(i); }}
                          className={`w-2 h-2 rounded-full transition-all ${i === imgIdx ? 'bg-card w-5' : 'bg-white/50'}`} />
                      ))}
                    </div>
                  </>
                )}

                {/* Photo count badge */}
                <button
                  onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
                  className="absolute bottom-4 right-4 bg-background/90 backdrop-blur-sm text-foreground text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-md border border-border"
                >
                  <Eye className="h-3.5 w-3.5" />
                  {images.length} photo{images.length !== 1 ? 's' : ''}
                </button>
              </div>

              {/* Thumbnail strip — scroll horizontally */}
              {images.length > 1 && (
                <div className="flex gap-2 overflow-x-auto px-4 py-3 scrollbar-hide bg-background">
                  {images.map((url, i) => (
                    <button key={i}
                      onClick={() => setImgIdx(i)}
                      className={`flex-shrink-0 w-[72px] h-[72px] rounded-xl overflow-hidden transition-all active:scale-95 ${i === imgIdx ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : 'opacity-50 hover:opacity-100'}`}>
                      <img src={url} alt={`${listing.title} ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}

              <ImageLightbox
                images={lightboxImages}
                initialIndex={imgIdx}
                open={lightboxOpen}
                onClose={() => setLightboxOpen(false)}
                productName={listing.title}
                memoryKey={listing.id ? `house:${listing.id}` : undefined}
              />
            </>
          ) : (
            <div className="w-full h-48 bg-muted flex items-center justify-center">
              <Home className="h-12 w-12 text-muted-foreground/30" />
            </div>
          )}

          {/* Floating top controls */}
          <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 pt-safe-top py-3">
            <button
              onClick={() => navigate('/houses')}
              aria-label="Back to available houses"
              className="bg-background/80 backdrop-blur-sm text-foreground rounded-full p-2.5 shadow-lg active:scale-95 transition-transform">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2">
              <SaveHouseButton houseId={listing.id} variant="icon" />
              <button onClick={handleShare}
                className="bg-background/80 backdrop-blur-sm text-foreground rounded-full p-2.5 shadow-lg active:scale-95 transition-transform"
                title="Share this house">
                <Share2 className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <main className="max-w-2xl mx-auto px-4 space-y-6 mt-5 relative z-10">
          {/* Title — large, clean, centered like Airbnb */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <h1 className="font-bold text-2xl leading-tight">{listing.title}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {categoryLabel} in {listing.region}{listing.district ? `, ${listing.district}` : ''}
            </p>
            <p className="text-sm text-muted-foreground">
              {listing.number_of_rooms} room{listing.number_of_rooms > 1 ? 's' : ''} · {listing.address}
            </p>
          </motion.div>

          {/* Rating badge — Airbnb 3-column */}
          {summary.totalReviews > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center justify-center gap-0 rounded-xl border border-border overflow-hidden"
            >
              <div className="flex-1 flex flex-col items-center py-3 px-2">
                <span className="text-xl font-bold">{summary.averageRating.toFixed(2)}</span>
                <div className="flex gap-0.5 mt-0.5">
                  {[1,2,3,4,5].map(i => (
                    <Star key={i} className={`h-3 w-3 ${i <= Math.round(summary.averageRating) ? 'fill-foreground text-foreground' : 'text-muted-foreground/30'}`} />
                  ))}
                </div>
              </div>
              <div className="w-px h-12 bg-border" />
              <div className="flex-1 flex flex-col items-center py-3 px-2">
                <span className="text-lg">🏆</span>
                <span className="text-[11px] font-bold leading-tight text-center">Top<br />Rated</span>
              </div>
              <div className="w-px h-12 bg-border" />
              <div className="flex-1 flex flex-col items-center py-3 px-2">
                <span className="text-xl font-bold">{summary.totalReviews}</span>
                <span className="text-[11px] text-muted-foreground font-medium">Review{summary.totalReviews !== 1 ? 's' : ''}</span>
              </div>
            </motion.div>
          )}

          <div className="border-t border-border" />

          {/* ── Agent card — Airbnb host style ── */}
          {listing.agent_name && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-3"
            >
              <div className="w-12 h-12 rounded-full bg-foreground text-background flex items-center justify-center font-bold text-lg">
                {listing.agent_name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-base">Listed by {listing.agent_name}</p>
                <p className="text-sm text-muted-foreground">Welile Agent</p>
              </div>
            </motion.div>
          )}

          <div className="border-t border-border" />

          {/* ── Daily Rate — Airbnb price section ── */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="rounded-xl border border-border p-5 space-y-3">
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold">{formatUGX(listing.daily_rate)}</span>
                <span className="text-sm text-muted-foreground">/ day</span>
              </div>
              <p className="text-sm text-muted-foreground">Pay as you stay · no commitment</p>
              <div className="flex items-center gap-2 flex-wrap">
                <VisitBadge reviewCount={summary.totalReviews} />
                <PriceComparison region={listing.region} category={listing.house_category} dailyRate={listing.daily_rate} houseId={listing.id} />
              </div>
              <MoveInOfferBadge variant="banner" className="mt-2" />
              {listing.agent_phone && (
                <div className="pt-2">
                  <WhatsAppAgentButton phone={listing.agent_phone} agentName={listing.agent_name} houseTitle={listing.title} />
                </div>
              )}
            </div>
          </motion.div>

          <div className="border-t border-border" />

          {/* ── Share row ── */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <ShareHouseButton
              listingId={listing.id}
              title={listing.title}
              region={listing.region}
              dailyRate={listing.daily_rate}
              shortCode={listing.short_code}
              variant="full"
              address={listing.address}
              monthlyRent={listing.monthly_rent}
              rooms={listing.number_of_rooms}
              category={listing.house_category}
            />
          </motion.div>

          <div className="border-t border-border" />

          {/* ── What this place offers — clean list ── */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.14, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="space-y-3"
          >
            <h2 className="font-semibold text-lg">What this place offers</h2>
            <div className="space-y-0">
              <div className="flex items-center gap-3 py-3 border-b border-border/50">
                <DoorOpen className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm">{listing.number_of_rooms} Room{listing.number_of_rooms > 1 ? 's' : ''}</span>
              </div>
              {amenities.map((a, i) => (
                <div key={i} className="flex items-center gap-3 py-3 border-b border-border/50 last:border-b-0">
                  <a.icon className="h-6 w-6 text-muted-foreground" />
                  <span className="text-sm">{a.label}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {isPending && (
            <div className="flex items-center gap-2 text-sm text-warning">
              <Clock className="h-4 w-4" />
              <span>This listing is pending verification</span>
            </div>
          )}

          {!isPending && (
            <div className="flex items-center gap-2 text-sm text-success">
              <ShieldCheck className="h-4 w-4" />
              <span>Verified listing</span>
            </div>
          )}

          <div className="border-t border-border" />

          {/* ── Description ── */}
          {listing.description && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <h2 className="font-bold text-sm text-foreground mb-2">About this place</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{listing.description}</p>
            </motion.div>
          )}

          {/* ── Walkthrough video ── */}
          {houseVideo && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <h2 className="font-bold text-sm text-foreground mb-2 flex items-center gap-1.5">
                <Video className="h-4 w-4 text-primary" /> Video walkthrough
              </h2>
              <div className="relative w-full aspect-video rounded-2xl overflow-hidden border border-border bg-muted">
                <iframe
                  src={houseVideo.embedUrl}
                  title={`${listing.title} walkthrough`}
                  className="absolute inset-0 w-full h-full"
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
              <a
                href={houseVideo.canonicalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Open on {houseVideo.provider === 'youtube' ? 'YouTube' : 'Google Drive'}
              </a>
            </motion.div>
          )}

          {/* ── Map ── */}
          {mapEmbed && mapLink && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <h2 className="font-bold text-sm text-foreground mb-2">Location</h2>
              <a
                href={mapLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => announceMap(listing.title)}
                aria-label={`Open ${listing.title} location in Google Maps (opens in a new tab)`}
                className="block relative w-full h-44 rounded-2xl overflow-hidden bg-muted border-2 border-primary/40 ring-2 ring-primary/20 shadow-md active:scale-[0.99] transition-transform focus:outline-none focus-visible:ring-4 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <iframe src={mapEmbed} className="w-full h-full pointer-events-none" title={`Map: ${listing.title}`} loading="lazy" style={{ border: 0 }} />
                <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent pointer-events-none" />
                <div className="absolute bottom-2 left-2 right-2 mx-auto w-fit min-h-[44px] bg-primary text-primary-foreground text-sm font-bold px-5 py-2.5 rounded-full flex items-center gap-2 shadow-xl touch-manipulation">
                  <Navigation className="h-4 w-4" /> Tap to open in Google Maps
                </div>
              </a>
              <a
                href={directionsLink || mapLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => announceMap(listing.title)}
                aria-label={`Get directions to ${listing.title} in Google Maps (opens in a new tab)`}
                className="mt-2 flex items-center justify-center gap-2.5 w-full min-h-[52px] px-6 py-3.5 rounded-full bg-primary text-primary-foreground font-bold text-base shadow-lg active:scale-[0.98] transition-transform touch-manipulation focus:outline-none focus-visible:ring-4 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Navigation className="h-5 w-5" />
                Get Directions &amp; Go See It
              </a>
              <button
                type="button"
                onClick={async () => {
                  try {
                    if (navigator.share) {
                      await navigator.share({ title: listing.title, text: `${listing.title} on Google Maps`, url: mapLink });
                    } else {
                      await navigator.clipboard.writeText(mapLink);
                    }
                    setMapCopied(true);
                    toast({ title: 'Google Maps link copied', description: 'Paste it anywhere to share this location.' });
                    setTimeout(() => setMapCopied(false), 2500);
                  } catch {
                    toast({ title: 'Could not copy link', description: 'Long-press the map button to copy manually.', variant: 'destructive' });
                  }
                }}
                aria-label={`Copy Google Maps link for ${listing.title} to clipboard`}
                className="mt-2 flex items-center justify-center gap-2.5 w-full min-h-[48px] px-6 py-3 rounded-full border-2 border-primary/40 bg-background text-primary font-bold text-sm shadow-sm active:scale-[0.98] transition-transform touch-manipulation focus:outline-none focus-visible:ring-4 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {mapCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {mapCopied ? 'Map link copied!' : 'Share Google Maps link'}
              </button>
            </motion.div>
          )}

          {/* ── Nearby Amenities ── */}
          <NearbyAmenities latitude={listing.latitude} longitude={listing.longitude} />

          {/* ── Q&A ── */}
          <HouseQASection houseId={listing.id} agentId={listing.agent_id} />

          {/* ── Reviews ── */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="space-y-3"
          >
            <div className="flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-400 fill-yellow-400" />
              <h2 className="font-bold text-sm">
                Reviews
                {summary.totalReviews > 0 && (
                  <span className="text-muted-foreground font-normal text-xs ml-1.5">
                    {summary.averageRating.toFixed(1)} · {summary.totalReviews} review{summary.totalReviews !== 1 ? 's' : ''}
                  </span>
                )}
              </h2>
            </div>
            <WriteHouseReviewForm
              houseId={listing.id}
              houseTitle={listing.title}
              existingReview={myReview}
              houseLat={listing.latitude}
              houseLng={listing.longitude}
              onSuccess={refetchReviews}
            />
            <HouseReviewsList reviews={reviews} summary={summary} loading={reviewsLoading} />
          </motion.div>
        </main>

        {/* ── Sticky bottom CTA bar ── */}
        <div className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-md border-t border-border z-40">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-muted-foreground font-medium">Daily Rent</p>
              <p className="text-lg font-black text-success leading-tight">{formatUGX(listing.daily_rate)}<span className="text-xs font-medium text-muted-foreground">/day</span></p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={async () => {
                  const richUrl = shareUrl;
                  const msg = listing
                    ? `🏠 Check out this house on Welile!\n\n*${listing.title}*\n📍 ${listing.region}\n💰 ${formatUGX(listing.daily_rate)}/day\n\n👉 ${richUrl}`
                    : richUrl;
                  try {
                    await navigator.clipboard.writeText(msg);
                    setCopied(true);
                    toast({ title: 'Link copied — opening WhatsApp!', description: 'Paste the link in the chat if it is not pre-filled.' });
                    setTimeout(() => setCopied(false), 2500);
                  } catch {
                    toast({ title: 'Could not copy link', variant: 'destructive' });
                  }
                  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
                }}
                className="h-11 px-3 rounded-xl bg-[#25D366] text-white flex items-center gap-1.5 text-xs font-bold active:scale-95 transition-transform touch-manipulation"
                title="Share on WhatsApp"
              >
                <MessageCircle className="h-4 w-4" />
                Share
              </button>
              <WhatsAppAgentButton phone={listing.agent_phone} agentName={listing.agent_name} houseTitle={listing.title} />
              <button onClick={handleCopyLink}
                className="h-11 w-11 rounded-xl border border-border bg-card flex items-center justify-center active:scale-95 transition-transform"
                title="Copy share link">
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
