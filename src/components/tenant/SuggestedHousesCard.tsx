import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';

import { Sparkles, MapPin, DoorOpen, ChevronRight, Heart, Star } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';
import { ImageLightbox } from '@/components/marketplace/ImageLightbox';

interface SuggestedHousesCardProps {
  userId: string;
  onViewAll: () => void;
}

interface SuggestedHouse {
  id: string;
  title: string;
  address: string;
  region: string;
  district: string | null;
  house_category: string;
  number_of_rooms: number;
  monthly_rent: number;
  daily_rate: number;
  image_urls: string[] | null;
  short_code: string | null;
  latitude: number | null;
  longitude: number | null;
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  agent_rating: number | null;
}

async function fetchSuggestions(userId: string): Promise<SuggestedHouse[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;
  const { data: lastRequest } = await client
    .from('rent_requests')
    .select('rent_amount')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  const maxRent = lastRequest?.[0]?.rent_amount ? lastRequest[0].rent_amount * 1.3 : 500000;

  const { data: houses } = await client
    .from('house_listings')
    .select('id, title, address, region, district, house_category, number_of_rooms, monthly_rent, daily_rate, image_urls, short_code, latitude, longitude, agent_id')
    .eq('status', 'available')
    .eq('is_hidden', false)
    .eq('verified', true)
    .is('tenant_id', null)
    .lte('monthly_rent', maxRent)
    .order('created_at', { ascending: false })
    .limit(6);

  if (!houses?.length) return [];

  // Only suggest houses that have at least one real photo.
  const withPhotos = (houses as any[]).filter(
    (h) => Array.isArray(h.image_urls) && h.image_urls.some((u: any) => typeof u === 'string' && u.trim().length > 0)
  );
  if (!withPhotos.length) return [];

  // Tenants cannot read agents' `profiles` directly (RLS). Use the secure RPC
  // that returns only the listing agent's contact so the WhatsApp button works.
  const listingIds = withPhotos.map((h: any) => h.id).filter(Boolean);
  let agentMap = new Map<string, { full_name: string | null; phone: string | null; avg_rating: number | null }>();
  if (listingIds.length) {
    const { data: contacts } = await client.rpc('get_listing_agent_contacts', { p_listing_ids: listingIds });
    if (contacts) {
      agentMap = new Map(
        (contacts as any[]).map((r) => [r.listing_id, { full_name: r.full_name, phone: r.phone, avg_rating: r.avg_rating }])
      );
    }
  }

  return withPhotos.map((h: any) => ({
    ...h,
    agent_name: agentMap.get(h.id)?.full_name || null,
    agent_phone: agentMap.get(h.id)?.phone || null,
    agent_rating: agentMap.get(h.id)?.avg_rating ?? null,
  }));
}

export function SuggestedHousesCard({ userId, onViewAll }: SuggestedHousesCardProps) {
  const navigate = useNavigate();
  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['tenant-suggested-houses', userId],
    queryFn: () => fetchSuggestions(userId),
    staleTime: 300000,
  });
  const [lightbox, setLightbox] = useState<{ images: string[]; title: string; houseId: string } | null>(null);
  const [liked, setLiked] = useState<Set<string>>(new Set());

  if (isLoading || !suggestions?.length) return null;

  const toggleLike = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setLiked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {/* Section header — Airbnb style */}
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-lg">
          Suggested For You
        </h2>
        <button type="button" onClick={onViewAll} className="text-sm font-semibold text-foreground flex items-center gap-0.5">
          View all <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Horizontal scroll — Airbnb-style cards */}
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4 snap-x snap-mandatory scrollbar-none">
        {suggestions.slice(0, 6).map(house => (
          <div
            key={house.id}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/house/${house.short_code || house.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(`/house/${house.short_code || house.id}`);
              }
            }}
            aria-label={`View details for ${house.title}`}
            className="flex-shrink-0 w-[44vw] sm:w-48 snap-start cursor-pointer focus:outline-none group"
          >
            {/* Image container */}
            <div className="relative aspect-square rounded-xl overflow-hidden bg-muted">
              {house.image_urls?.[0] ? (
                <img
                  src={house.image_urls[0]}
                  alt={`${house.title} in ${house.region}`}
                  loading="lazy"
                  className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center">
                  <DoorOpen className="h-8 w-8 text-muted-foreground/30" />
                </div>
              )}

              {/* Badge — top left */}
              <span className="absolute top-2 left-2">
                <MoveInOfferBadge />
              </span>

              {/* Heart — top right */}
              <button
                type="button"
                onClick={(e) => toggleLike(e, house.id)}
                aria-label={liked.has(house.id) ? 'Remove from favourites' : 'Add to favourites'}
                className="absolute top-2 right-2 p-1.5 rounded-full hover:scale-110 transition-transform"
              >
                <Heart
                  className={`h-5 w-5 drop-shadow-md ${
                    liked.has(house.id)
                      ? 'fill-red-500 text-red-500'
                      : 'fill-black/30 text-white'
                  }`}
                />
              </button>

              {/* Photo count */}
              {house.image_urls && house.image_urls.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightbox({ images: house.image_urls!, title: house.title, houseId: house.id });
                  }}
                  className="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-md"
                >
                  1/{house.image_urls.length}
                </button>
              )}
            </div>

            {/* Text — below image */}
            <div className="mt-2 space-y-0.5">
              <div className="flex items-start justify-between gap-1">
                <p className="text-sm font-semibold text-foreground leading-tight line-clamp-1">
                  {house.title}
                </p>
                {house.agent_rating && (
                  <span className="flex items-center gap-0.5 text-xs font-medium shrink-0">
                    <Star className="h-3 w-3 fill-foreground text-foreground" />
                    {house.agent_rating.toFixed(1)}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground leading-tight flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{house.region}{house.district ? `, ${house.district}` : ''}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {house.house_category} · {house.number_of_rooms} room{house.number_of_rooms !== 1 ? 's' : ''}
              </p>
              <p className="text-sm font-semibold text-foreground">
                {formatUGX(house.daily_rate)} <span className="text-xs font-normal text-muted-foreground">/ day</span>
              </p>
            </div>
          </div>
        ))}
      </div>

      {lightbox && (
        <ImageLightbox
          images={lightbox.images.map((url, i) => ({ id: `${i}`, image_url: url }))}
          open={!!lightbox}
          onClose={() => setLightbox(null)}
          productName={lightbox.title}
          memoryKey={`house:${lightbox.houseId}`}
        />
      )}
    </div>
  );
}
