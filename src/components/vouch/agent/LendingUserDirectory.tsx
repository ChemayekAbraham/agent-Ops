import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ChevronDown, MapPin, Phone, ShieldCheck, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { formatLocation } from '@/lib/locationText';
import { lendingDirectoryRange, LENDING_DIRECTORY_PAGE_SIZE, sanitizeLocationTerm } from '@/lib/lendingDirectory';
import BorrowerProfileSheet, { type DirectoryPerson } from './BorrowerProfileSheet';

const VOUCH_FILTERS: { label: string; value: number | null }[] = [
  { label: 'Any vouch', value: null },
  { label: `${formatUGX(10_000)}+`, value: 10_000 },
  { label: `${formatUGX(50_000)}+`, value: 50_000 },
  { label: `${formatUGX(100_000)}+`, value: 100_000 },
  { label: `${formatUGX(250_000)}+`, value: 250_000 },
];

type SortKey = 'name' | 'vouch';

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
  { label: 'Name A–Z', value: 'name' },
  { label: 'Highest vouch', value: 'vouch' },
];

type EmbeddedTrust = { ai_id?: string | null; borrowing_limit_ugx?: number | null };

export default function LendingUserDirectory({ onLend }: { onLend: (phone: string) => void }) {
  const { user } = useAuth();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [minVouch, setMinVouch] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey>('name');
  const [selected, setSelected] = useState<DirectoryPerson | null>(null);
  const term = useDebouncedValue(search.trim());
  const locationTerm = useDebouncedValue(sanitizeLocationTerm(location));
  const filtersActive = !!term || !!locationTerm || minVouch !== null || sort !== 'name';

  const query = useQuery({
    queryKey: ['lending-user-directory', user?.id, page, term, locationTerm, minVouch, sort],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      if (!user) return { rows: [], count: 0 };
      let peopleQuery = supabase.from('profiles')
        .select('id, full_name, phone, avatar_url, village, parish, sub_county, district, city, welile_trust_score_cache!welile_trust_score_cache_user_id_fkey(ai_id, borrowing_limit_ugx)', { count: 'exact' })
        .neq('id', user.id);
      if (term) peopleQuery = peopleQuery.ilike('full_name', `%${term}%`);
      if (locationTerm) {
        peopleQuery = peopleQuery.or(
          `village.ilike.%${locationTerm}%,parish.ilike.%${locationTerm}%,sub_county.ilike.%${locationTerm}%,district.ilike.%${locationTerm}%,city.ilike.%${locationTerm}%`
        );
      }
      if (minVouch !== null) peopleQuery = peopleQuery.gte('welile_trust_score_cache.borrowing_limit_ugx', minVouch);
      if (sort === 'vouch') {
        peopleQuery = peopleQuery
          .order('welile_trust_score_cache(borrowing_limit_ugx)', { ascending: false, nullsFirst: false })
          .order('full_name')
          .order('id');
      } else {
        peopleQuery = peopleQuery.order('full_name').order('id');
      }
      const { data: people, count, error } = await peopleQuery.range(...lendingDirectoryRange(page));
      if (error) throw error;
      const rows = (people ?? []).map((p) => {
        const raw = (p as { welile_trust_score_cache?: EmbeddedTrust | EmbeddedTrust[] | null }).welile_trust_score_cache;
        const trust = Array.isArray(raw) ? raw[0] : raw;
        const { welile_trust_score_cache: _drop, ...rest } = p as typeof p & { welile_trust_score_cache?: unknown };
        return { ...rest, trust: trust ? { user_id: p.id, ai_id: trust.ai_id ?? null, borrowing_limit_ugx: trust.borrowing_limit_ugx ?? null } : null };
      });
      return { count: count ?? 0, rows };
    },
  });
  const pages = Math.max(1, Math.ceil((query.data?.count ?? 0) / LENDING_DIRECTORY_PAGE_SIZE));

  const clearFilters = () => {
    setSearch('');
    setLocation('');
    setMinVouch(null);
    setSort('name');
    setPage(0);
  };

  const resetPage = (apply: () => void) => { apply(); setPage(0); };

  return (
    <section className="space-y-4">
      <Input aria-label="Search users by name" placeholder="Search by name" value={search}
        onChange={e => resetPage(() => setSearch(e.target.value))} className="h-12 text-base" />
      <Input aria-label="Filter by location" placeholder="Filter by district, city or village" value={location}
        onChange={e => resetPage(() => setLocation(e.target.value))} className="h-12 text-base" />
      <div className="space-y-2" role="group" aria-label="Vouched amount filter">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Welile vouches at least</p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {VOUCH_FILTERS.map(f => (
            <button key={f.label} type="button" aria-pressed={minVouch === f.value}
              onClick={() => resetPage(() => setMinVouch(f.value))}
              className={cn('shrink-0 rounded-full border border-border px-3 py-1.5 text-sm font-medium transition-colors',
                minVouch === f.value ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2" role="group" aria-label="Sort users">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sort by</p>
        <div className="flex gap-2">
          {SORT_OPTIONS.map(o => (
            <button key={o.value} type="button" aria-pressed={sort === o.value}
              onClick={() => resetPage(() => setSort(o.value))}
              className={cn('rounded-full border border-border px-3 py-1.5 text-sm font-medium transition-colors',
                sort === o.value ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>
              {o.label}
            </button>
          ))}
          {filtersActive && (
            <button type="button" onClick={clearFilters}
              className="ml-auto flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />Clear filters
            </button>
          )}
        </div>
      </div>
      {query.isLoading ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-36 w-full rounded-lg" />)
        : query.isError ? <div className="py-8 text-center"><p className="text-destructive">Could not load users.</p><Button variant="outline" onClick={() => query.refetch()}>Try again</Button></div>
        : !query.data?.rows.length ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">No users match your search or filters.</p>
            {filtersActive && <Button variant="outline" className="mt-3" onClick={clearFilters}>Clear filters</Button>}
          </div>
        )
        : query.data.rows.map(person => (
          <article key={person.id} className="rounded-lg border border-border bg-card p-4 sm:p-5">
            <button type="button" onClick={() => setSelected(person)}
              className="flex w-full items-start gap-3 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              aria-label={`View profile for ${person.full_name || 'Welile user'}`}>
              <UserAvatar avatarUrl={person.avatar_url} fullName={person.full_name} />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-base font-semibold text-foreground">{person.full_name || 'Welile user'}</h3>
                <p className="break-all text-xs text-muted-foreground">{person.trust?.ai_id ?? 'AI ID not available'}</p>
                <p className="mt-2 flex items-start gap-1.5 text-sm text-muted-foreground"><MapPin className="mt-0.5 h-4 w-4 shrink-0" />{formatLocation([person.village, person.parish, person.sub_county, person.district, person.city]) || 'Location not provided'}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm"><Phone className="h-4 w-4 text-muted-foreground" />{person.phone || 'Phone not provided'}</p>
              </div>
              <ChevronDown className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            </button>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
              <div><p className="flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-success" />Welile vouches up to</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{person.trust ? formatUGX(Number(person.trust.borrowing_limit_ugx)) : 'Not available'}</p></div>
              <Button variant="outline" disabled={!person.phone} onClick={() => { if (person.phone) onLend(person.phone); }}>Lend</Button>
            </div>
          </article>
        ))}
      <nav aria-label="User pages" className="flex items-center justify-between border-t border-border py-3">
        <Button variant="outline" size="icon" aria-label="Previous five users" disabled={page === 0 || query.isFetching} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm text-muted-foreground">Page {page + 1} of {pages}</span>
        <Button variant="outline" size="icon" aria-label="Next five users" disabled={page + 1 >= pages || query.isFetching} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
      </nav>
      <BorrowerProfileSheet person={selected} onLend={onLend} onClose={() => setSelected(null)} />
    </section>
  );
}
