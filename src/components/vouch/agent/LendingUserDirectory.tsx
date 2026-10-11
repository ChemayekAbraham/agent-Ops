import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, MapPin, Phone, ShieldCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { formatLocation } from '@/lib/locationText';
import { lendingDirectoryRange, LENDING_DIRECTORY_PAGE_SIZE } from '@/lib/lendingDirectory';

export default function LendingUserDirectory({ onLend }: { onLend: (phone: string) => void }) {
  const { user } = useAuth();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search.trim());
  const query = useQuery({
    queryKey: ['lending-user-directory', user?.id, page, term],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      if (!user) return { rows: [], count: 0 };
      let peopleQuery = supabase.from('profiles')
        .select('id, full_name, phone, avatar_url, village, parish, sub_county, district, city', { count: 'exact' })
        .neq('id', user.id).order('full_name').order('id');
      if (term) peopleQuery = peopleQuery.ilike('full_name', `%${term}%`);
      const { data: people, count, error } = await peopleQuery.range(...lendingDirectoryRange(page));
      if (error) throw error;
      const ids = (people ?? []).map(p => p.id);
      const { data: trust, error: trustError } = ids.length
        ? await supabase.from('welile_trust_score_cache').select('user_id, ai_id, borrowing_limit_ugx').in('user_id', ids)
        : { data: [], error: null };
      if (trustError) throw trustError;
      return { count: count ?? 0, rows: (people ?? []).map(p => ({ ...p, trust: trust?.find(t => t.user_id === p.id) })) };
    },
  });
  const pages = Math.max(1, Math.ceil((query.data?.count ?? 0) / LENDING_DIRECTORY_PAGE_SIZE));
  return (
    <section className="space-y-4">
      <Input aria-label="Search users by name" placeholder="Search by name" value={search}
        onChange={e => { setSearch(e.target.value); setPage(0); }} className="h-12 text-base" />
      {query.isLoading ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-36 w-full rounded-lg" />)
        : query.isError ? <div className="py-8 text-center"><p className="text-destructive">Could not load users.</p><Button variant="outline" onClick={() => query.refetch()}>Try again</Button></div>
        : !query.data?.rows.length ? <p className="py-12 text-center text-muted-foreground">No users available in your directory{term ? ' with that name' : ''}.</p>
        : query.data.rows.map(person => (
          <article key={person.id} className="rounded-lg border border-border bg-card p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <UserAvatar avatarUrl={person.avatar_url} fullName={person.full_name} />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-base font-semibold text-foreground">{person.full_name || 'Welile user'}</h3>
                <p className="break-all text-xs text-muted-foreground">{person.trust?.ai_id ?? 'AI ID not available'}</p>
                <p className="mt-2 flex items-start gap-1.5 text-sm text-muted-foreground"><MapPin className="mt-0.5 h-4 w-4 shrink-0" />{formatLocation([person.village, person.parish, person.sub_county, person.district, person.city]) || 'Location not provided'}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm"><Phone className="h-4 w-4 text-muted-foreground" />{person.phone || 'Phone not provided'}</p>
              </div>
            </div>
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
    </section>
  );
}