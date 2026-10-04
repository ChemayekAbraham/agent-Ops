import { useEffect, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useProxyPartnerList, type ProxyPartnerRow } from '@/hooks/useProxyAgentCommandCenter';
import { EmptyState, ListSkeleton, SectionError, SectionTitle, StatusPill, shortDate, ugx } from './ProxyDashboardParts';

/** Sources come from the server attribution function; the UI only labels them. */
const viaNote = (r: ProxyPartnerRow) => r.sources.includes('note');
const viaInvite = (r: ProxyPartnerRow) => r.sources.some((s) => s === 'invite_link' || s === 'invite' || s === 'referral');

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'note', label: 'Via Promissory Note' },
  { id: 'invite', label: 'Via Invite Link' },
] as const;

export function ProxyPartnersSection({ agentId, onInvite }: { agentId?: string; onInvite: () => void }) {
  const [src, setSrc] = useState<'all' | 'note' | 'invite'>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  // Source filtering is a view over one server page; fetch a generous page.
  const list = useProxyPartnerList({ agentId, search: q, filter: 'all', sort: 'linked_at', dir: 'desc', page: 0, pageSize: 200 });
  const rows = (list.data?.rows ?? []).filter((r) => (src === 'all' ? true : src === 'note' ? viaNote(r) : viaInvite(r)));

  return (
    <div className="space-y-3">
      <SectionTitle title="Partners" sub={list.data ? `${list.data.total.toLocaleString()} connected to you` : undefined} />
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search partner" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button key={f.id} aria-pressed={src === f.id} onClick={() => setSrc(f.id)}
            className={cn('h-8 shrink-0 rounded-full border px-3 text-xs font-medium', src === f.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>
            {f.label}
          </button>
        ))}
      </div>
      {list.isError ? <SectionError label="your partners" onRetry={() => list.refetch()} />
        : list.isLoading ? <ListSkeleton />
        : rows.length === 0 ? (
          <EmptyState icon={Users} title={src === 'all' && !q ? 'No partners have joined through you yet.' : 'No partners match this filter.'}
            action={src === 'all' && !q ? <Button size="sm" onClick={onInvite}>Share Invite Link</Button> : undefined} />
        ) : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => (
              <Card key={r.partner_user_id} className="p-3 shadow-none">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold uppercase">{r.partner_name}</p>
                  {r.came_in ? <StatusPill tone="success">{r.is_returning ? 'Returning' : 'Funded'}</StatusPill> : <StatusPill tone="warning">Not yet funded</StatusPill>}
                </div>
                <p className="text-xs text-muted-foreground">Joined {shortDate(r.linked_at)}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {viaNote(r) && <StatusPill tone="primary">Promissory Note</StatusPill>}
                  {viaInvite(r) && <StatusPill tone="primary">Invite Link</StatusPill>}
                  {!viaNote(r) && !viaInvite(r) && <StatusPill tone="neutral">Assigned</StatusPill>}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Total supported</p><p className="text-sm font-bold tabular-nums">{ugx(r.total_funded)}</p></div>
                  <div><p className="text-muted-foreground">Portfolios</p><p className="text-sm font-bold tabular-nums">{r.portfolios}{r.portfolios > 1 ? ` · ${r.portfolios - 1} more` : ''}</p></div>
                </div>
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}
