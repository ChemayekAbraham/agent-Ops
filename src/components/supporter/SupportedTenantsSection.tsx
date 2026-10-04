import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { Search, ChevronLeft, ChevronRight, Users, Home } from 'lucide-react';
import { useSupportedTenants, type SupportedTenant } from '@/hooks/useSupportedTenants';
import { SupportedTenantDrawer } from '@/components/supporter/SupportedTenantDrawer';
import { ListSectionSkeleton } from '@/components/skeletons/SectionSkeletons';

const PAGE_SIZE = 10;

/** A funded empty house the partner supports directly (self-support houses). */
interface SupportedHouseItem {
  kind: 'house';
  id: string;
  title: string;
  location: string;
  amount: number;
  status: string;
}

type ListItem =
  | ({ kind: 'tenant' } & SupportedTenant)
  | SupportedHouseItem;


/** Pre-funding stages are all shown as "Pending approval" to partners. */
const PENDING_STATUSES = new Set([
  'coo_approved',
  'pending',
  'pending_approval',
  'submitted',
  'in_review',
  'under_review',
  'vetted',
  'approved',
  'ready_to_fund',
  'pending_cfo',
  'pending_partner_ops',
]);

function formatTenantStatus(status: string) {
  if (PENDING_STATUSES.has(status)) return 'Pending approval';
  return status.replace(/_/g, ' ');
}

interface SupportedTenantsSectionProps {
  /** When embedded inside another section, hide the standalone heading/anchor. */
  embedded?: boolean;
}

export function SupportedTenantsSection({ embedded = false }: SupportedTenantsSectionProps = {}) {
  const { tenants, isLoading, error } = useSupportedTenants();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SupportedTenant | null>(null);

  // Funded empty houses the partner supports directly — these sit alongside the
  // rent plans in the same self-funded list.
  const { data: houses = [], isLoading: housesLoading } = useQuery<SupportedHouseItem[]>({
    queryKey: ['partner-supported-houses-inline'],
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('partner_supported_house_returns');
      if (rpcError) throw rpcError;
      const rows = ((data as { houses?: Record<string, unknown>[] } | null)?.houses ?? []);
      return rows.map((h) => ({
        kind: 'house' as const,
        id: String(h.intent_id ?? h.house_id ?? ''),
        title: String(h.title || 'Empty house'),
        location: [h.village, h.sub_county, h.district].filter(Boolean).join(', '),
        amount: Number(h.promised_amount || h.monthly_rent || 0),
        status: h.is_funded ? 'funded' : String(h.intent_status || 'pending').replace(/_/g, ' '),
      }));
    },
    staleTime: 60_000,
  });

  const items = useMemo<ListItem[]>(
    () => [
      ...tenants.map(t => ({ kind: 'tenant' as const, ...t })),
      ...houses,
    ],
    [tenants, houses],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.kind === 'tenant'
        ? (i.tenant_name || '').toLowerCase().includes(q) ||
          (i.tenant_address || '').toLowerCase().includes(q) ||
          (i.city || '').toLowerCase().includes(q)
        : i.title.toLowerCase().includes(q) || i.location.toLowerCase().includes(q)
    );
  }, [items, search]);

  const showControls = items.length >= 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = showControls
    ? filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
    : filtered;

  if (isLoading || housesLoading) {
    return (
      <div id={embedded ? undefined : 'supported-tenants'} className="space-y-3 scroll-mt-4">
        <ListSectionSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div id={embedded ? undefined : 'supported-tenants'} className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
        <p className="text-sm font-semibold text-destructive">Could not load your supported tenants</p>
        <p className="text-xs text-destructive/80 mt-1">{error.message}</p>
      </div>
    );
  }

  if (items.length === 0) {
    if (!embedded) return null;
    return (
      <div className="flex items-center gap-2 px-4 py-6 rounded-2xl border border-border/60 bg-card">
        <Users className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">You have no self-funded tenants or houses yet.</p>
      </div>
    );
  }


  return (
    <div id={embedded ? undefined : 'supported-tenants'} className="space-y-3 scroll-mt-4">
      {!embedded && (
        <div className="flex items-center gap-2 px-1">
          <div className="w-1 h-5 rounded-full bg-primary" />
          <h2 className="text-sm font-black text-foreground tracking-tight">Tenants &amp; houses you support</h2>
          <Badge variant="secondary" className="text-[10px] ml-auto">{items.length}</Badge>
        </div>
      )}

      {showControls && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name, house or address"
            className="pl-9 h-11 rounded-xl"
          />
        </div>
      )}

      <div className="space-y-2">
        {visible.map(item => item.kind === 'tenant' ? (
          <button
            key={item.rent_request_id}
            onClick={() => { hapticTap(); setSelected(item); }}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl bg-card border border-border/60 shadow-sm text-left active:scale-[0.98] transition-transform"
          >
            <UserAvatar avatarUrl={item.tenant_avatar_url} fullName={item.tenant_name} size="md" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-foreground truncate">{item.tenant_name}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {item.tenant_address || item.city || 'Address not provided'}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-black text-foreground font-mono tabular-nums">
                {formatUGX(Number(item.rent_amount || 0))}
              </p>
              <p className="text-[10px] text-muted-foreground capitalize">{formatTenantStatus(item.status)}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </button>
        ) : (
          <div
            key={`house-${item.id}`}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl bg-card border border-border/60 shadow-sm text-left"
          >
            <div className="h-10 w-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
              <Home className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-foreground truncate">{item.title}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {item.location || 'Location not provided'}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-black text-foreground font-mono tabular-nums">
                {formatUGX(item.amount)}
              </p>
              <p className="text-[10px] text-muted-foreground capitalize">{item.status}</p>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-6 rounded-2xl border border-border/60 bg-card">
            <Users className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nothing matches "{search}".</p>
          </div>
        )}

      </div>

      {showControls && totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <Button
            variant="outline" size="sm" className="rounded-xl"
            disabled={safePage <= 1}
            onClick={() => { hapticTap(); setPage(p => Math.max(1, p - 1)); }}
          >
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <span className="text-[11px] font-semibold text-muted-foreground">
            Page {safePage} of {totalPages}
          </span>
          <Button
            variant="outline" size="sm" className="rounded-xl"
            disabled={safePage >= totalPages}
            onClick={() => { hapticTap(); setPage(p => Math.min(totalPages, p + 1)); }}
          >
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}

      <SupportedTenantDrawer
        tenant={selected}
        open={!!selected}
        onOpenChange={(o) => { if (!o) setSelected(null); }}
      />
    </div>
  );
}
