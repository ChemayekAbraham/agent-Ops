import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { MapPin, ArrowRight, Home, Sparkles } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';
import { ShareHouseButton } from '@/components/tenant/ShareHouseButton';

interface PublicHouse {
  id: string;
  title: string;
  region: string;
  district: string | null;
  address: string | null;
  house_category: string;
  number_of_rooms: number;
  daily_rate: number;
  monthly_rent: number;
  image_urls: string[] | null;
  short_code: string | null;
}

interface PublicHousesPreviewProps {
  /** When true, taps open the full house detail / browse pages instead of the sign-in screen. */
  authenticated?: boolean;
}

export function PublicHousesPreview({ authenticated = false }: PublicHousesPreviewProps) {
  const navigate = useNavigate();
  const [houses, setHouses] = useState<PublicHouse[] | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [listRes, countRes] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from('house_listings')
          .select('id, title, region, district, address, house_category, number_of_rooms, daily_rate, monthly_rent, image_urls, short_code')
          .eq('status', 'available')
          .eq('is_hidden', false)
          .eq('verified', true)
          .is('tenant_id', null)
          .not('image_urls', 'is', null)
          .neq('image_urls', '{}')
          .order('created_at', { ascending: false })
          .limit(6),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from('house_listings')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'available')
          .eq('is_hidden', false)
          .eq('verified', true)
          .is('tenant_id', null)
          .not('image_urls', 'is', null)
          .neq('image_urls', '{}'),
      ]);
      if (!mounted) return;
      setHouses(((listRes.data as PublicHouse[]) || []).filter(h => Array.isArray(h.image_urls) && h.image_urls.some(u => typeof u === 'string' && u.trim().length > 0)));
      setTotalCount(countRes.count ?? null);
    })();
    return () => { mounted = false; };
  }, []);

  const goExplore = () => {
    hapticTap();
    if (authenticated) {
      navigate('/find-a-house', { state: { from: 'funder' } });
    } else {
      navigate('/auth?role=tenant');
    }
  };

  const openHouse = (house: PublicHouse) => {
    hapticTap();
    if (authenticated) {
      navigate(`/house/${house.short_code || house.id}`, { state: { from: 'funder' } });
    } else {
      navigate('/auth?role=tenant');
    }
  };

  if (houses && houses.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35, duration: 0.35 }}
      className="mt-8 max-w-lg mx-auto w-full px-1"
      aria-label="Available houses preview"
    >
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <span className="text-lg">🏘️</span>
          <h2 className="font-bold text-sm text-foreground">
            Houses available now
          </h2>
          {totalCount !== null && totalCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold">
              <Sparkles className="h-2.5 w-2.5" /> {totalCount}
            </span>
          )}
        </div>
        <button
          onClick={goExplore}
          className="text-xs text-primary font-semibold flex items-center gap-0.5 touch-manipulation"
        >
          See all <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {!houses ? (
        <div className="flex gap-3 overflow-hidden">
          {[1, 2, 3].map(i => (
            <div key={i} className="shrink-0 w-44 h-48 rounded-2xl bg-muted/50 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 -mx-5 px-5 scrollbar-hide snap-x snap-mandatory">
          {houses.map(house => (
            <div
              key={house.id}
              role="button"
              tabIndex={0}
              onClick={() => openHouse(house)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openHouse(house); }}
              className="shrink-0 w-44 snap-start text-left rounded-2xl border border-border/60 bg-card overflow-hidden shadow-sm hover:shadow-md active:scale-[0.98] transition-all touch-manipulation cursor-pointer"
            >
              <div className="relative w-full h-28 bg-muted">
                {house.image_urls?.[0] ? (
                  <img
                    src={house.image_urls[0]}
                    alt={house.title}
                    width={176}
                    height={112}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Home className="h-8 w-8 text-muted-foreground/30" />
                  </div>
                )}
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-background/85 backdrop-blur text-[9px] font-bold text-foreground">
                  {house.number_of_rooms} rm
                </span>
                <span
                  className="absolute top-1.5 right-1.5"
                  onClick={(e) => e.stopPropagation()}
                  role="presentation"
                >
                  <ShareHouseButton
                    listingId={house.id}
                    title={house.title}
                    region={house.region}
                    dailyRate={house.daily_rate}
                    shortCode={house.short_code}
                    mode="share"
                    address={house.address}
                    monthlyRent={house.monthly_rent}
                    rooms={house.number_of_rooms}
                    category={house.house_category}
                  />
                </span>
              </div>
              <div className="p-2.5 space-y-1">
                <p className="font-semibold text-xs truncate">{house.title}</p>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <MapPin className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">
                    {house.region}{house.district ? `, ${house.district}` : ''}
                  </span>
                </div>
                <p className="text-sm font-black text-success leading-none pt-0.5">
                  {formatUGX(house.daily_rate)}
                  <span className="text-[9px] font-normal text-muted-foreground">/day</span>
                </p>
                <MoveInOfferBadge className="mt-1" />
              </div>
            </div>
          ))}

          <button
            onClick={goExplore}
            className="shrink-0 w-32 snap-start rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 flex flex-col items-center justify-center gap-2 text-primary font-semibold text-xs hover:bg-primary/10 active:scale-[0.98] transition-all touch-manipulation"
          >
            <ArrowRight className="h-5 w-5" />
            See all houses
          </button>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground text-center mt-2">
        {authenticated
          ? 'Tap any house to view full details'
          : 'Tap any house to sign in and explore details'}
      </p>
    </motion.section>
  );
}
