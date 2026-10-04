import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MapPin, Navigation, Store, Phone, CheckCircle2, Loader2, List, Map as MapIcon, Filter, Search, X } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { SellerMapPreview, type MapSeller } from './SellerMapPreview';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from '@/components/ui/drawer';

interface ClaimBreadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reducedPrice: number;
  basePrice: number;
  freeBreads: number;
  hasReceipt: boolean;
}

interface NearbySeller {
  id: string;
  name: string;
  distanceKm: number | null;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  inStock: boolean;
  category: string | null;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function ClaimBreadDialog({ open, onOpenChange, reducedPrice, basePrice, freeBreads, hasReceipt }: ClaimBreadDialogProps) {
  const { toast } = useToast();
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedId, setClaimedId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [sellers, setSellers] = useState<NearbySeller[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>(() => {
    if (typeof window === 'undefined') return 'list';
    const v = window.localStorage.getItem('claim-bread:view');
    return v === 'map' ? 'map' : 'list';
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('claim-bread:view', view);
    } catch {
      /* ignore */
    }
  }, [view]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [pinDetailsId, setPinDetailsId] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(() => {
    if (typeof window === 'undefined') return 25;
    const v = Number(window.localStorage.getItem('claim-bread:radius'));
    return v > 0 ? v : 25;
  });
  useEffect(() => {
    try { window.localStorage.setItem('claim-bread:radius', String(radiusKm)); } catch { /* */ }
  }, [radiusKm]);
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  useEffect(() => {
    if (!open) {
      setClaimedId(null);
      setClaimingId(null);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: dbError } = await supabase
        .from('vendors')
        .select('id, name, location, phone, latitude, longitude, category')
        .eq('active', true)
        .order('name', { ascending: true })
        .limit(50);
      if (cancelled) return;
      if (dbError) {
        setError('Could not load nearby sellers.');
        setSellers([]);
      } else {
        setSellers(
          (data ?? []).map((v: any) => ({
            id: v.id,
            name: v.name,
            address: v.location ?? null,
            phone: v.phone ?? null,
            distanceKm: null,
            latitude: v.latitude ?? null,
            longitude: v.longitude ?? null,
            inStock: true,
            category: v.category ?? null,
          })),
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    sellers.forEach((s) => {
      if (s.category && s.category.trim()) set.add(s.category.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sellers]);

  const filteredSellers = useMemo(() => {
    let list = sellers;
    if (categoryFilter === 'uncategorized') list = list.filter((s) => !s.category);
    else if (categoryFilter !== 'all') list = list.filter((s) => s.category === categoryFilter);
    const q = debouncedQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.address ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [sellers, categoryFilter, debouncedQuery]);

  const sortedSellers = useMemo(() => {
    if (!coords) {
      return [...filteredSellers].sort((a, b) => a.name.localeCompare(b.name));
    }
    const withDistance = filteredSellers.map((s) => {
      if (s.latitude == null || s.longitude == null) return s;
      return { ...s, distanceKm: haversineKm(coords.lat, coords.lng, s.latitude, s.longitude) };
    });
    const withinRadius = withDistance.filter(
      (s) => s.distanceKm == null || s.distanceKm <= radiusKm,
    );
    return withinRadius.sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return a.name.localeCompare(b.name);
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
  }, [filteredSellers, coords, radiusKm]);

  // Auto-focus map on first matching seller (after debounce)
  useEffect(() => {
    if (!debouncedQuery.trim()) return;
    const first = sortedSellers.find((s) => s.latitude != null && s.longitude != null);
    if (first) setSelectedId(first.id);
  }, [debouncedQuery, sortedSellers]);

  const mappableSellers = useMemo<MapSeller[]>(
    () =>
      sortedSellers
        .filter((s) => s.latitude != null && s.longitude != null)
        .map((s) => ({
          id: s.id,
          name: s.name,
          latitude: s.latitude as number,
          longitude: s.longitude as number,
          distanceKm: s.distanceKm,
          address: s.address,
        })),
    [sortedSellers],
  );

  const handleMapPinTap = (id: string) => {
    hapticTap();
    setSelectedId(id);
    setPinDetailsId(id);
  };

  const handleSelectFromDrawer = (id: string) => {
    hapticTap();
    setSelectedId(id);
    setPinDetailsId(null);
    setView('list');
    setTimeout(() => {
      const el = rowRefs.current[id];
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  const pinSeller = useMemo(
    () => (pinDetailsId ? sellers.find((s) => s.id === pinDetailsId) ?? null : null),
    [pinDetailsId, sellers],
  );

  const requestLocation = () => {
    if (!('geolocation' in navigator)) {
      toast({ title: 'Location not supported', description: 'Your device does not support location.', variant: 'destructive' });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
        toast({ title: 'Location updated', description: 'Showing closest sellers.' });
      },
      () => {
        setLocating(false);
        toast({ title: 'Location unavailable', description: 'Showing default nearby list.', variant: 'destructive' });
      },
      { timeout: 8000 }
    );
  };

  const handleClaim = (seller: NearbySeller) => {
    if (!seller.inStock) return;
    hapticTap();
    setClaimingId(seller.id);
    setTimeout(() => {
      setClaimingId(null);
      setClaimedId(seller.id);
      toast({
        title: 'Rent Fees reserved',
        description: `Show this confirmation at ${seller.name} to collect.`,
      });
    }, 700);
  };

  const priceLabel = freeBreads > 0 ? 'FREE' : formatUGX(reducedPrice);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
          <DialogTitle className="text-lg font-bold flex items-center gap-2">
            <Store className="h-5 w-5" /> Claim your discounted bread
          </DialogTitle>
          <DialogDescription className="text-white/90 text-xs">
            Pick a nearby seller. Your price today:{' '}
            <span className="font-bold">{priceLabel}</span>
            {reducedPrice < basePrice && (
              <span className="line-through opacity-80 ml-1">{formatUGX(basePrice)}</span>
            )}
            {!hasReceipt && (
              <span className="block mt-1 opacity-90">Tip: add a Welile receipt to unlock 5% off.</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="inline-flex rounded-full border border-border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setView('list')}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${view === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'}`}
                aria-pressed={view === 'list'}
              >
                <List className="h-3 w-3" /> List
              </button>
              <button
                type="button"
                onClick={() => setView('map')}
                disabled={mappableSellers.length === 0}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${view === 'map' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'} disabled:opacity-40`}
                aria-pressed={view === 'map'}
              >
                <MapIcon className="h-3 w-3" /> Map
              </button>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {coords ? `Near ${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)}` : 'Nearby'}
              </span>
            </div>
          </div>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={requestLocation} disabled={locating}>
            {locating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Navigation className="h-3 w-3" />}
            <span className="ml-1">My location</span>
          </Button>
        </div>

        <div className="px-5 py-2 border-b border-border">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sellers by name or area…"
              className="w-full h-8 pl-8 pr-8 rounded-full border border-border bg-background text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {coords && (
          <div className="px-5 py-2 border-b border-border bg-muted/10">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" /> Within
              </span>
              <span className="font-semibold text-foreground">{radiusKm} km</span>
            </div>
            <input
              type="range"
              min={1}
              max={50}
              step={1}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="w-full accent-emerald-600 h-1"
              aria-label="Distance radius in kilometers"
            />
            <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
              <span>1 km</span>
              <span>50 km</span>
            </div>
          </div>
        )}

        {(categories.length > 0 || sellers.some((s) => !s.category)) && (
          <div className="px-5 py-2 border-b border-border bg-muted/20">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
              {(['all', ...categories, ...(sellers.some((s) => !s.category) ? ['uncategorized'] : [])] as string[]).map((cat) => {
                const active = categoryFilter === cat;
                const label = cat === 'all' ? 'All' : cat === 'uncategorized' ? 'Other' : cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      hapticTap();
                      setCategoryFilter(cat);
                    }}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors capitalize ${
                      active
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-background text-muted-foreground border-border hover:bg-muted'
                    }`}
                    aria-pressed={active}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {view === 'map' ? (
          mappableSellers.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-muted-foreground">
              No sellers have map coordinates yet.
            </div>
          ) : (
            <SellerMapPreview
              sellers={mappableSellers}
              userCoords={coords}
              selectedId={selectedId}
              onSelect={handleMapPinTap}
            />
          )
        ) : (
        <ul className="max-h-[55vh] overflow-y-auto divide-y divide-border">
          {loading && (
            <li className="px-5 py-6 flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading nearby sellers…
            </li>
          )}
          {!loading && error && (
            <li className="px-5 py-6 text-center text-xs text-destructive">{error}</li>
          )}
          {!loading && !error && sortedSellers.length === 0 && (
            <li className="px-5 py-6 text-center text-xs text-muted-foreground">
              No active sellers found near you yet.
            </li>
          )}
          {sortedSellers.map((seller) => {
            const isClaiming = claimingId === seller.id;
            const isClaimed = claimedId === seller.id;
            const isSelected = selectedId === seller.id;
            return (
              <li
                key={seller.id}
                ref={(el) => {
                  rowRefs.current[seller.id] = el;
                }}
                className={`px-5 py-3 flex items-center justify-between gap-3 transition-colors ${isSelected ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-foreground truncate">{seller.name}</p>
                  {seller.address && (
                    <p className="text-[11px] text-muted-foreground truncate">{seller.address}</p>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-[10px]">
                    {seller.distanceKm != null && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <MapPin className="h-3 w-3" /> {seller.distanceKm.toFixed(1)} km
                      </span>
                    )}
                    {seller.inStock ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">In stock</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400 font-medium">Out of stock</span>
                    )}
                    {seller.phone && (
                      <a
                        href={`tel:${seller.phone}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <Phone className="h-3 w-3" /> Call
                      </a>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  className={`shrink-0 ${isClaimed ? 'bg-emerald-600 hover:bg-emerald-600' : ''}`}
                  disabled={!seller.inStock || isClaiming || isClaimed}
                  onClick={() => handleClaim(seller)}
                >
                  {isClaiming ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isClaimed ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Reserved
                    </>
                  ) : (
                    'Claim'
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
        )}

        <div className="px-5 py-3 border-t border-border bg-muted/30">
          <p className="text-[10px] text-muted-foreground text-center">
            Reservations hold your Rent Fees for 2 hours. Show this screen at pickup.
          </p>
        </div>
      </DialogContent>
    </Dialog>
    <Drawer open={!!pinSeller} onOpenChange={(o) => !o && setPinDetailsId(null)}>
      <DrawerContent className="max-w-md mx-auto">
        {pinSeller && (
          <>
            <DrawerHeader className="text-left">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
                  <Store className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <DrawerTitle className="text-base truncate">{pinSeller.name}</DrawerTitle>
                  <DrawerDescription className="text-xs">
                    {pinSeller.category ? <span className="capitalize">{pinSeller.category}</span> : 'Seller'}
                    {pinSeller.distanceKm != null && <> · {pinSeller.distanceKm.toFixed(1)} km away</>}
                  </DrawerDescription>
                </div>
              </div>
            </DrawerHeader>
            <div className="px-4 pb-2 space-y-2 text-xs">
              {pinSeller.address && (
                <div className="flex items-start gap-2">
                  <MapPin className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  <span className="text-foreground">{pinSeller.address}</span>
                </div>
              )}
              {pinSeller.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <a href={`tel:${pinSeller.phone}`} className="text-primary hover:underline">{pinSeller.phone}</a>
                </div>
              )}
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                  {pinSeller.inStock ? 'In stock today' : 'Out of stock'}
                </span>
              </div>
              <div className="rounded-lg bg-muted/40 px-3 py-2 mt-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Your price</p>
                <p className="text-sm font-bold text-foreground">{priceLabel}</p>
              </div>
            </div>
            <DrawerFooter className="pt-3">
              <Button
                onClick={() => handleSelectFromDrawer(pinSeller.id)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> Select seller
              </Button>
              <DrawerClose asChild>
                <Button variant="outline">Close</Button>
              </DrawerClose>
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
    </>
  );
}