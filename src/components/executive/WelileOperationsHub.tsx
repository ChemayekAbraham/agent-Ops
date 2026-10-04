import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { TenantLocationBrowser } from './tenant-ops/TenantLocationBrowser';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { WelileOpsCounterBand } from './tenant-ops/WelileOpsCounterBand';
import { WelileMissionBoard } from './tenant-ops/WelileMissionBoard';
import {
  Users, Home, UserCheck, Handshake, Search, ChevronRight, Phone, MapPin,
} from 'lucide-react';

type Category = 'tenant' | 'landlord' | 'agent' | 'partner';

const CATEGORIES: { id: Category; label: string; icon: React.ElementType; tone: string; help: string }[] = [
  { id: 'tenant', label: 'Tenants', icon: Users, tone: 'text-emerald-600 bg-emerald-500/10 border-emerald-200', help: 'Browse every tenant by location and open a deep profile' },
  { id: 'landlord', label: 'Landlords', icon: Home, tone: 'text-[#9234EA] bg-[#9234EA]/10 border-[#9234EA]/30', help: 'Search landlords and manage their houses, payouts & links' },
  { id: 'agent', label: 'Agents', icon: UserCheck, tone: 'text-blue-600 bg-blue-500/10 border-blue-200', help: 'Search field agents and review their full portfolio' },
  { id: 'partner', label: 'Partners', icon: Handshake, tone: 'text-amber-600 bg-amber-500/10 border-amber-200', help: 'Search supporters & funding partners and their profiles' },
];

interface PersonRow {
  id: string;            // drawer id (profile id for tenant/agent/partner, landlords.id for landlord)
  name: string;
  phone: string | null;
  sub: string | null;
  avatar?: string | null;
}

/** Search profiles that carry a specific role (agent / supporter). */
function useRoleUserSearch(role: 'agent' | 'supporter', term: string) {
  const q = term.trim();
  return useQuery({
    enabled: q.length >= 2,
    queryKey: ['welile-ops-role-search', role, q],
    staleTime: 30_000,
    queryFn: async (): Promise<PersonRow[]> => {
      const cleaned = q.replace(/\D/g, '');
      const isPhone = cleaned.length >= 3;
      let pq = supabase.from('profiles').select('id, full_name, phone, city, avatar_url').limit(60);
      pq = isPhone ? pq.ilike('phone', `%${cleaned.slice(-9)}%`) : pq.ilike('full_name', `%${q}%`);
      const { data: profiles, error } = await pq;
      if (error) throw error;
      const ids = (profiles ?? []).map((p) => p.id);
      if (ids.length === 0) return [];
      const { data: roleRows } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', role)
        .in('user_id', ids);
      const roleSet = new Set((roleRows ?? []).map((r) => r.user_id));
      return (profiles ?? [])
        .filter((p) => roleSet.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.full_name || 'Unknown',
          phone: p.phone,
          sub: p.city || null,
          avatar: p.avatar_url,
        }));
    },
  });
}

/** Search the landlords table directly (landlords are not always app users). */
function useLandlordSearch(term: string) {
  const q = term.trim();
  return useQuery({
    enabled: q.length >= 2,
    queryKey: ['welile-ops-landlord-search', q],
    staleTime: 30_000,
    queryFn: async (): Promise<PersonRow[]> => {
      // Trigram-indexed RPC — plain ILIKE forces a seq scan under load.
      const { data, error } = await supabase.rpc('search_landlords_fuzzy', {
        p_query: q,
        p_limit: 60,
        p_threshold: 0.15,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((l) => ({
        id: l.id,
        name: l.name || 'Unnamed landlord',
        phone: l.phone,
        sub: 'Landlord',
      }));
    },
  });
}

function PeopleList({
  rows, loading, ready, onOpen,
}: { rows: PersonRow[]; loading: boolean; ready: boolean; onOpen: (r: PersonRow) => void }) {
  if (!ready) {
    return <p className="text-sm text-muted-foreground px-1 py-6 text-center">Type at least 2 characters to search.</p>;
  }
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground px-1 py-6 text-center">No matches found.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r.id}
          onClick={() => onOpen(r)}
          className="rounded-lg border border-border bg-card p-3 flex items-center gap-3 hover:bg-muted/40 transition cursor-pointer"
        >
          <Avatar className="h-9 w-9 shrink-0">
            {r.avatar ? <AvatarImage src={r.avatar} alt={r.name} /> : null}
            <AvatarFallback>{r.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate">{r.name}</p>
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
              {r.phone ? <><Phone className="h-3 w-3" />{r.phone}</> : '—'}
              {r.sub ? <><span className="mx-1">·</span><MapPin className="h-3 w-3" />{r.sub}</> : null}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </li>
      ))}
    </ul>
  );
}

function SearchCategory({
  category, onOpen,
}: { category: Exclude<Category, 'tenant'>; onOpen: (r: PersonRow, c: Category) => void }) {
  const [term, setTerm] = useState('');
  const ready = term.trim().length >= 2;

  const landlord = useLandlordSearch(category === 'landlord' ? term : '');
  const agent = useRoleUserSearch('agent', category === 'agent' ? term : '');
  const partner = useRoleUserSearch('supporter', category === 'partner' ? term : '');

  const active = category === 'landlord' ? landlord : category === 'agent' ? agent : partner;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={`Search ${category}s by name or phone…`}
          className="pl-9"
        />
      </div>
      <PeopleList
        rows={active.data ?? []}
        loading={active.isLoading}
        ready={ready}
        onOpen={(r) => onOpen(r, category)}
      />
    </div>
  );
}

export function WelileOperationsHub() {
  const [category, setCategory] = useState<Category>('tenant');
  const [drawer, setDrawer] = useState<{
    tenantId?: string | null; agentId?: string | null; landlordId?: string | null;
    tab: 'tenant' | 'agent' | 'landlord';
  } | null>(null);

  const openProfile = (r: PersonRow, c: Category) => {
    if (c === 'landlord') setDrawer({ landlordId: r.id, tab: 'landlord' });
    else if (c === 'agent') setDrawer({ agentId: r.id, tab: 'agent' });
    else setDrawer({ tenantId: r.id, tab: 'tenant' }); // partners open as user profile
  };

  const activeMeta = useMemo(() => CATEGORIES.find((c) => c.id === category)!, [category]);

  return (
    <div className="space-y-4">
      {/* Current mission: list empty houses → place tenants → onboard funders */}
      <WelileMissionBoard />

      {/* Always-visible operations counter: new activity by continent → country → city → agent */}
      <WelileOpsCounterBand />

      <div>
        <h2 className="text-lg font-extrabold leading-tight">Welile Operations</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          One place to manage every user category — deep profiles for tenants, landlords, agents & partners.
        </p>
      </div>

      {/* Category selector */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {CATEGORIES.map((c) => {
          const Icon = c.icon;
          const active = c.id === category;
          return (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`rounded-xl border p-3 text-left transition active:scale-[0.98] ${
                active ? `${c.tone} border-2 shadow-sm` : 'border-border bg-card hover:bg-muted/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-5 w-5 shrink-0 ${active ? '' : 'text-muted-foreground'}`} />
                <span className="font-bold text-sm">{c.label}</span>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground -mt-1">{activeMeta.help}</p>

      {category === 'tenant' ? (
        <TenantLocationBrowser />
      ) : (
        <SearchCategory category={category} onOpen={openProfile} />
      )}

      <UserDrilldownDrawer
        open={!!drawer}
        onOpenChange={(v) => { if (!v) setDrawer(null); }}
        tenantId={drawer?.tenantId ?? null}
        agentId={drawer?.agentId ?? null}
        landlordId={drawer?.landlordId ?? null}
        defaultTab={drawer?.tab ?? 'landlord'}
      />
    </div>
  );
}

export default WelileOperationsHub;