import { useEffect, useState } from 'react';
import { FileText, Search, Share2, Copy, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useProxyNoteList } from '@/hooks/useProxyAgentCommandCenter';
import type { ProxyPerformanceDashboard } from '@/hooks/useProxyPerformanceDashboard';
import { EmptyState, ListSkeleton, NoteStatusPill, SectionError, SectionTitle, shortDate, ugx } from './ProxyDashboardParts';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'activated', label: 'Brought In' },
] as const;
const PAGE = 20;

export function ProxyNotesSection({ agentId, summary, onCreate }: { agentId?: string; summary?: ProxyPerformanceDashboard; onCreate: () => void }) {
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(0); }, 300); return () => clearTimeout(t); }, [search]);
  const list = useProxyNoteList({ agentId, search: q, status, sort: 'created_at', dir: 'desc', page, pageSize: PAGE });
  const n = summary?.notes;

  const followUp = (phone: string | null, name: string) => {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) { toast.error('No phone number on this note'); return; }
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(`Hello ${name}, following up on your Welile Promissory Note.`)}`, '_blank');
  };
  const share = async (text: string) => {
    try {
      if (navigator.share) await navigator.share({ title: 'Promissory Note', text });
      else { await navigator.clipboard.writeText(text); toast.success('Copied'); }
    } catch { /* cancelled */ }
  };

  return (
    <div className="space-y-3">
      <SectionTitle title="Promissory Notes" action={<Button size="sm" onClick={onCreate}>Create Note</Button>} />
      {n && (
        <div className="grid grid-cols-3 gap-2">
          {[['Created', n.created, ''], ['Brought In', n.brought_in, 'text-success'], ['Pending', n.pending, 'text-warning']].map(([k, v, t]) => (
            <Card key={k as string} className="p-2.5 text-center shadow-none"><p className="text-[11px] text-muted-foreground">{k}</p><p className={cn('text-lg font-bold tabular-nums', t as string)}>{Number(v).toLocaleString()}</p></Card>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search partner or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex gap-2 overflow-x-auto" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={status === f.id} onClick={() => { setStatus(f.id); setPage(0); }}
            className={cn('h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors', status === f.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>
            {f.label}
          </button>
        ))}
      </div>

      {list.isError ? <SectionError label="your notes" onRetry={() => list.refetch()} />
        : list.isLoading ? <ListSkeleton />
        : !list.data?.rows.length ? (
          <EmptyState icon={FileText} title={q || status !== 'all' ? 'No notes match this filter.' : "You haven't created a Promissory Note yet."}
            action={!q && status === 'all' ? <Button size="sm" onClick={onCreate}>Create Promissory Note</Button> : undefined} />
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {list.data.rows.map((r) => {
                const name = r.partner_name || r.linked_partner_name || 'Unnamed partner';
                const phone = r.whatsapp_number || r.phone_number;
                const text = `Promissory Note for ${name}: ${ugx(r.amount)} on Welile.`;
                return (
                  <Card key={r.id} className="p-3 shadow-none">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-semibold uppercase">{name}</p>
                      <NoteStatusPill status={r.status} />
                    </div>
                    <p className="mt-1 text-lg font-bold tabular-nums">{ugx(r.amount)}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {shortDate(r.created_at)}
                      {r.partner_came_in ? ' · Partner funded' : ''}
                      {Number(r.total_collected) > 0 ? ` · ${ugx(r.total_collected)} collected` : ''}
                    </p>
                    {r.approval_bonus_paid && <p className="mt-1 text-xs"><span className="text-muted-foreground">Commission </span><span className="font-semibold text-success">paid</span></p>}
                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                      <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => share(text)}><Share2 className="mr-1 h-3.5 w-3.5" />Share</Button>
                      <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={async () => { await navigator.clipboard.writeText(text); toast.success('Copied'); }}><Copy className="mr-1 h-3.5 w-3.5" />Copy</Button>
                      <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => followUp(phone, name)}><MessageCircle className="mr-1 h-3.5 w-3.5" />Follow up</Button>
                    </div>
                  </Card>
                );
              })}
            </div>
            {list.data.total > PAGE && (
              <div className="flex items-center justify-center gap-2">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <span className="text-xs text-muted-foreground">Page {page + 1} of {Math.ceil(list.data.total / PAGE)}</span>
                <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= list.data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
    </div>
  );
}
