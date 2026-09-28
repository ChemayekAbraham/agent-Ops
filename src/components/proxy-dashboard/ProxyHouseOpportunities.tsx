import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin, Search, SlidersHorizontal, Share2, Eye, FilePlus2, Home } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { EmptyHouseDetailSheet, housePlace, type HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import { SectionError, ugx } from './ProxyDashboardParts';

const PAGE = 12;
type Sort = 'recommended' | 'nearest' | 'rent_low' | 'rent_high' | 'newest';

/** Reuses the existing empty-house source (agent_list_empty_house_opportunities). */
export function ProxyHouseOpportunities({ onCreateNote }: { onCreateNote: (h: HouseOpportunity) => void }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<Sort>('recommended');
  const [minRent, setMinRent] = useState('');
  const [maxRent, setMaxRent] = useState('');
  const [near, setNear] = useState<{ lat: number; lng: number } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<HouseOpportunity | null>(null);

  useEffect(() => { const t = setTimeout(() => { setDebounced(search.trim()); setPage(0); }, 300); return () => clearTimeout(t); }, [search]);

  const q = useQuery({
    queryKey: ['proxy-dash-houses', debounced, sort, minRent, maxRent, near, page],
    staleTime: 60_000,
    placeholderData: (p) => p,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: debounced || null,
        p_limit: PAGE,
        p_offset: page * PAGE,
        p_min_rent: minRent ? Number(minRent) : null,
        p_max_rent: maxRent ? Number(maxRent) : null,
        p_near_lat: sort === 'nearest' ? near?.lat ?? null : null,
        p_near_lng: sort === 'nearest' ? near?.lng ?? null : null,
        p_gps_only: sort === 'nearest' && !!near,
        p_sort: sort,
      });
      if (error) throw error;
      const p = (data ?? {}) as { total?: number; houses?: HouseOpportunity[] };
      return { total: Number(p.total || 0), houses: p.houses ?? [] };
    },
  });

  const pickSort = (v: Sort) => {
    setPage(0);
    if (v === 'nearest' && !near) {
      if (!navigator.geolocation) { toast.error('Location is not available on this device'); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => { setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setSort('nearest'); },
        () => toast.error('Allow location access to sort by nearest'),
        { timeout: 10000 },
      );
      return;
    }
    setSort(v);
  };

  const share = async (h: HouseOpportunity) => {
    const text = `${h.house_category || h.title || 'House'} in ${housePlace(h)} needs ${ugx(h.monthly_rent)} of support on Welile.`;
    try {
      if (navigator.share) await navigator.share({ title: 'Welile house', text, url: 'https://welileapp.com' });
      else { await navigator.clipboard.writeText(`${text} https://welileapp.com`); toast.success('Copied to clipboard'); }
    } catch { /* cancelled */ }
  };

  const filters = (
    <div className="space-y-3">
      <Select value={sort} onValueChange={(v) => pickSort(v as Sort)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="recommended">Recommended</SelectItem>
          <SelectItem value="nearest">Nearest to me</SelectItem>
          <SelectItem value="rent_low">Amount: Low → High</SelectItem>
          <SelectItem value="rent_high">Amount: High → Low</SelectItem>
          <SelectItem value="newest">Newest</SelectItem>
        </SelectContent>
      </Select>
      <div className="grid grid-cols-2 gap-2">
        <Input inputMode="numeric" placeholder="Min amount" value={minRent} onChange={(e) => { setMinRent(e.target.value.replace(/\D/g, '')); setPage(0); }} />
        <Input inputMode="numeric" placeholder="Max amount" value={maxRent} onChange={(e) => { setMaxRent(e.target.value.replace(/\D/g, '')); setPage(0); }} />
      </div>
    </div>
  );

  const total = q.data?.total ?? 0;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Houses You Can Work On</h2>
        {total > 0 && <span className="text-xs text-muted-foreground">{total.toLocaleString()} available</span>}
      </div>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search location or house type" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant="outline" size="icon" className="md:hidden" aria-label="Filters" onClick={() => setFiltersOpen(true)}><SlidersHorizontal className="h-4 w-4" /></Button>
        <div className="hidden w-[420px] md:block"><div className="grid grid-cols-[1fr_1fr] gap-2 [&>div]:contents">{filters}</div></div>
      </div>
      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader><SheetTitle>Filter houses</SheetTitle></SheetHeader>
          <div className="mt-4">{filters}</div>
          <Button className="mt-4 w-full" onClick={() => setFiltersOpen(false)}>Show houses</Button>
        </SheetContent>
      </Sheet>

      {q.isError ? (
        <SectionError label="houses" onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-lg" />)}</div>
      ) : total === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <Home className="h-8 w-8 text-muted-foreground" />
          <p className="font-semibold">No houses available right now</p>
          <p className="text-sm text-muted-foreground">New houses waiting for support will appear here when they become available.</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {q.data!.houses.map((h) => {
              const photo = h.image_urls?.[0] || h.image_url || null;
              return (
                <Card key={h.house_id} className="flex flex-col overflow-hidden p-0">
                  {photo ? (
                    <img src={photo} alt={h.house_category || h.title || 'House'} loading="lazy" className="h-40 w-full bg-muted object-cover" />
                  ) : (
                    <div className="flex h-40 w-full items-center justify-center bg-muted"><Home className="h-8 w-8 text-muted-foreground" /></div>
                  )}
                  <div className="flex flex-1 flex-col p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{h.house_category || h.title || 'House'}</p>
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground"><MapPin className="h-3 w-3 shrink-0" />{housePlace(h)}{typeof h.distance_km === 'number' ? ` · ${h.distance_km.toFixed(1)} km` : ''}</p>
                      </div>
                      {h.verified && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">Verified</span>}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div><p className="text-muted-foreground">Amount required</p><p className="text-sm font-bold tabular-nums">{ugx(h.monthly_rent)}</p></div>
                      <div><p className="text-muted-foreground">Partner returns / month</p><p className="text-sm font-bold tabular-nums">{ugx(h.partner_monthly_return)}</p></div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" className="flex-1" onClick={() => onCreateNote(h)}><FilePlus2 className="mr-1 h-4 w-4" />Create Promissory Note</Button>
                      <Button size="icon" variant="outline" className="h-9 w-9" aria-label="View house" onClick={() => setDetail(h)}><Eye className="h-4 w-4" /></Button>
                      <Button size="icon" variant="outline" className="h-9 w-9" aria-label="Share" onClick={() => share(h)}><Share2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
          {total > PAGE && (
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="text-xs text-muted-foreground">Page {page + 1} of {Math.ceil(total / PAGE)}</span>
              <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </>
      )}
      <EmptyHouseDetailSheet house={detail} open={!!detail} onOpenChange={(o) => !o && setDetail(null)} />
    </section>
  );
}
