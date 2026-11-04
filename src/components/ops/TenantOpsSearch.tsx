import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { PROFILE_TYPEAHEAD_MIN_CHARS, searchProfilesTypeahead } from '@/lib/profileTypeahead';
import { Search, ChevronRight } from 'lucide-react';

export function TenantOpsSearch({ onOpenBehavior }: { onOpenBehavior: (tenantId: string) => void }) {
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q.trim(), 300);
  const { data, isLoading } = useQuery({
    enabled: term.length >= PROFILE_TYPEAHEAD_MIN_CHARS,
    queryKey: ['ops-search', term],
    queryFn: async () => {
      const { rows, error } = await searchProfilesTypeahead(term, {
        limit: 25,
        columns: 'id, full_name, phone, city, national_id',
      });
      if (error) throw new Error(error);
      return rows;
    },
    staleTime: 30_000,
  });

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, phone, or national ID…"
          className="pl-9"
        />
      </div>

      {term.length < PROFILE_TYPEAHEAD_MIN_CHARS ? (
        <p className="text-sm text-muted-foreground">Type at least 3 characters to look up a tenant.</p>
      ) : isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches.</p>
      ) : (
        <ul className="space-y-1.5">
          {data.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-border bg-card p-3 flex items-center gap-3 hover:bg-muted/40 cursor-pointer"
              onClick={() => onOpenBehavior(p.id)}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{p.full_name || 'Unknown'}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {p.phone || '—'} · {p.city || '—'} {p.national_id ? `· ${p.national_id}` : ''}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
