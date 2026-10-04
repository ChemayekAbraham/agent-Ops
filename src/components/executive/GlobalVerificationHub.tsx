import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { hapticTap } from '@/lib/haptics';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { setLandlordVerification } from '@/lib/landlord-ops/verification';
import {
  Globe, ShieldCheck, Building2, UserCheck, FileText, ChevronRight,
  ArrowLeft, Loader2, CheckCircle2, MapPin, Phone, RefreshCw, Sparkles,
} from 'lucide-react';

interface CountryRow {
  country: string;
  landlords_pending: number;
  landlords_pending_today: number;
  lc1_pending: number;
  lc1_pending_today: number;
  rent_requests_new: number;
  rent_requests_new_today: number;
  total: number;
}

const VERIFY_ROLES = new Set([
  'manager', 'operations', 'coo', 'ceo', 'cfo', 'super_admin',
]);

function locationLine(r: Record<string, any>): string {
  return [r.village, r.cell, r.parish, r.town_council, r.sub_county, r.county, r.district, r.region]
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');
}

export function GlobalVerificationHub() {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const [country, setCountry] = useState<string | null>(null);
  const canVerify = !!role && VERIFY_ROLES.has(role);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['global-verification-overview'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ops_global_verification_overview');
      if (error) throw error;
      return (data as any)?.countries as CountryRow[] ?? [];
    },
    staleTime: 60_000,
  });

  const countries = data ?? [];
  const totals = countries.reduce(
    (acc, c) => {
      acc.landlords += c.landlords_pending;
      acc.lc1 += c.lc1_pending;
      acc.rr += c.rent_requests_new;
      acc.today += c.landlords_pending_today + c.lc1_pending_today + c.rent_requests_new_today;
      return acc;
    },
    { landlords: 0, lc1: 0, rr: 0, today: 0 },
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['global-verification-overview'] });
    refetch();
  };

  if (country) {
    return (
      <CountryQueue
        country={country}
        canVerify={canVerify}
        onBack={() => setCountry(null)}
        onChanged={invalidate}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-xl border-2 border-primary/40 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-primary/15">
            <Globe className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-base text-foreground leading-tight">Global Verification Center</h2>
            <p className="text-[11px] text-muted-foreground leading-snug">
              New landlords, LC1 chairpersons &amp; rent requests awaiting verification — by country
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isFetching} className="shrink-0">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Global totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <StatPill icon={Building2} label="Landlords" value={totals.landlords} tone="text-amber-600 bg-amber-500/10" />
          <StatPill icon={UserCheck} label="LC1 Chairpersons" value={totals.lc1} tone="text-violet-600 bg-violet-500/10" />
          <StatPill icon={FileText} label="New Rent Requests" value={totals.rr} tone="text-blue-600 bg-blue-500/10" />
          <StatPill icon={Sparkles} label="Today" value={totals.today} tone="text-emerald-600 bg-emerald-500/10" />
        </div>
      </div>

      {/* Country list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading verification queue…
        </div>
      ) : countries.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">
          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
          Nothing awaiting verification right now.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">By Country</p>
          {countries.map((c) => (
            <button
              key={c.country}
              onClick={() => { hapticTap(); setCountry(c.country); }}
              className="w-full text-left rounded-xl border bg-card hover:shadow-md transition-shadow p-3.5 flex items-center gap-3 touch-manipulation active:scale-[0.99]"
            >
              <div className="p-2 rounded-lg bg-muted">
                <MapPin className="h-5 w-5 text-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-bold text-sm text-foreground">{c.country}</p>
                  {(c.landlords_pending_today + c.lc1_pending_today + c.rent_requests_new_today) > 0 && (
                    <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[10px] px-1.5 py-0">
                      +{c.landlords_pending_today + c.lc1_pending_today + c.rent_requests_new_today} today
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-muted-foreground">
                  <span><b className="text-amber-600">{c.landlords_pending}</b> landlords</span>
                  <span><b className="text-violet-600">{c.lc1_pending}</b> LC1</span>
                  <span><b className="text-blue-600">{c.rent_requests_new}</b> rent reqs</span>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}

      {!canVerify && (
        <p className="text-[11px] text-muted-foreground text-center">
          You can review queues but need an operations role to confirm verifications.
        </p>
      )}
    </div>
  );
}

function StatPill({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className={`inline-flex p-1.5 rounded-md ${tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xl font-bold text-foreground mt-1.5 leading-none">{value}</p>
      <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{label}</p>
    </div>
  );
}

// ───────────────────────── Country drilldown ─────────────────────────

function CountryQueue({
  country, canVerify, onBack, onChanged,
}: { country: string; canVerify: boolean; onBack: () => void; onChanged: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <MapPin className="h-5 w-5 text-primary shrink-0" />
          <h2 className="font-bold text-base truncate">{country} — Verification</h2>
        </div>
      </div>

      <Tabs defaultValue="landlords" className="w-full">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="landlords" className="gap-1.5 text-xs"><Building2 className="h-3.5 w-3.5" />Landlords</TabsTrigger>
          <TabsTrigger value="lc1" className="gap-1.5 text-xs"><UserCheck className="h-3.5 w-3.5" />LC1</TabsTrigger>
          <TabsTrigger value="rent" className="gap-1.5 text-xs"><FileText className="h-3.5 w-3.5" />Rent</TabsTrigger>
        </TabsList>
        <TabsContent value="landlords" className="mt-3">
          <LandlordVerifyList country={country} canVerify={canVerify} onChanged={onChanged} />
        </TabsContent>
        <TabsContent value="lc1" className="mt-3">
          <Lc1VerifyList country={country} canVerify={canVerify} onChanged={onChanged} />
        </TabsContent>
        <TabsContent value="rent" className="mt-3">
          <RentRequestList country={country} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const PAGE = 50;

function useCountryFilter(country: string) {
  // 'Unknown' bucket = rows with null/empty country.
  return country === 'Unknown' ? null : country;
}

function LandlordVerifyList({ country, canVerify, onChanged }: { country: string; canVerify: boolean; onChanged: () => void }) {
  const filter = useCountryFilter(country);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['verify-landlords', country],
    queryFn: async () => {
      let q = supabase
        .from('landlords')
        .select('id, name, phone, village, cell, town_council, sub_county, county, district, region, monthly_rent, created_at')
        .neq('verified', true)
        .order('created_at', { ascending: false })
        .limit(PAGE);
      q = filter ? q.eq('country', filter) : q.is('country', null);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const verify = async (id: string, name: string) => {
    if (!canVerify) { toast.error('Operations role required'); return; }
    hapticTap();
    setBusy(id);
    try {
      await setLandlordVerification({
        landlordId: id,
        status: 'verified',
        reason: 'Verified from the global verification hub queue after review',
        source: 'global_hub',
      });
      toast.success(`Landlord ${name || ''} verified`);
      refetch();
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Verification failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <QueueList
      isLoading={isLoading}
      items={data ?? []}
      empty="No landlords awaiting verification here."
      render={(l) => (
        <VerifyRow
          key={l.id}
          title={l.name || 'Unnamed landlord'}
          subtitle={l.phone}
          location={locationLine(l)}
          busy={busy === l.id}
          canVerify={canVerify}
          onVerify={() => verify(l.id, l.name)}
        />
      )}
    />
  );
}

function Lc1VerifyList({ country, canVerify, onChanged }: { country: string; canVerify: boolean; onChanged: () => void }) {
  const filter = useCountryFilter(country);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['verify-lc1', country],
    queryFn: async () => {
      let q = supabase
        .from('lc1_chairpersons')
        .select('id, name, phone, village, cell, zone, parish, sub_county, county, district, region, registered_by, verification_bonus_paid, registered_at')
        .neq('verified', true)
        .order('registered_at', { ascending: false })
        .limit(PAGE);
      q = filter ? q.eq('country', filter) : q.is('country', null);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const verify = async (id: string, name: string) => {
    if (!canVerify) { toast.error('Operations role required'); return; }
    hapticTap();
    setBusy(id);
    const { error } = await invokeEdgeFunction('credit-lc1-verification-bonus', {
      body: { lc1_id: id },
      errorTitle: 'LC1 verification failed',
    });
    setBusy(null);
    if (!error) {
      toast.success(`${name || 'LC1 chairperson'} verified — UGX 2,000 reward released to agent`);
      refetch();
      onChanged();
    }
  };

  return (
    <QueueList
      isLoading={isLoading}
      items={data ?? []}
      empty="No LC1 chairpersons awaiting verification here."
      render={(l) => (
        <VerifyRow
          key={l.id}
          title={l.name || 'Unnamed chairperson'}
          subtitle={l.phone}
          location={locationLine(l)}
          tag={l.registered_by ? 'UGX 2,000 agent reward' : undefined}
          busy={busy === l.id}
          canVerify={canVerify}
          onVerify={() => verify(l.id, l.name)}
        />
      )}
    />
  );
}

function RentRequestList({ country }: { country: string }) {
  const filter = useCountryFilter(country);

  const { data, isLoading } = useQuery({
    queryKey: ['verify-rent-requests', country],
    queryFn: async () => {
      // Find landlords in this country, then their pending rent requests.
      let lq = supabase.from('landlords').select('id, name').limit(1000);
      lq = filter ? lq.eq('country', filter) : lq.is('country', null);
      const { data: lls, error: lErr } = await lq;
      if (lErr) throw lErr;
      const ids = (lls ?? []).map((l) => l.id);
      if (ids.length === 0) return [];
      const nameById = new Map((lls ?? []).map((l) => [l.id, l.name]));
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, landlord_id, rent_amount, created_at, status')
        .eq('status', 'pending')
        .in('landlord_id', ids)
        .order('created_at', { ascending: false })
        .limit(PAGE);
      if (error) throw error;
      const rows = data ?? [];
      const tenantIds = [...new Set(rows.map((r: any) => r.tenant_id).filter(Boolean))];
      const tenantName = new Map<string, string>();
      if (tenantIds.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', tenantIds as string[]);
        for (const p of profs ?? []) tenantName.set((p as any).id, (p as any).full_name);
      }
      return rows.map((r: any) => ({
        ...r,
        landlord_name: nameById.get(r.landlord_id),
        tenant_name: tenantName.get(r.tenant_id),
      }));
    },
  });

  return (
    <QueueList
      isLoading={isLoading}
      items={data ?? []}
      empty="No new rent requests in this country."
      render={(r: any) => (
        <div key={r.id} className="rounded-lg border bg-card p-3 flex items-center gap-3">
          <div className="p-1.5 rounded-md bg-blue-500/10">
            <FileText className="h-4 w-4 text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm text-foreground truncate">{r.tenant_name || 'Tenant'}</p>
            <p className="text-[11px] text-muted-foreground truncate">Landlord: {r.landlord_name || '—'}</p>
          </div>
          <Badge variant="outline" className="text-[10px] shrink-0">Pending</Badge>
        </div>
      )}
    />
  );
}

function QueueList<T>({ isLoading, items, empty, render }: {
  isLoading: boolean; items: T[]; empty: string; render: (item: T) => React.ReactNode;
}) {
  if (isLoading) {
    return <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" />Loading…</div>;
  }
  if (items.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground"><CheckCircle2 className="h-7 w-7 mx-auto mb-2 text-emerald-500" />{empty}</div>;
  }
  return (
    <div className="space-y-2">
      {items.length >= PAGE && (
        <p className="text-[11px] text-muted-foreground">Showing first {PAGE} — verify these to load more.</p>
      )}
      {items.map(render)}
    </div>
  );
}

function VerifyRow({ title, subtitle, location, tag, busy, canVerify, onVerify }: {
  title: string; subtitle?: string | null; location?: string; tag?: string;
  busy: boolean; canVerify: boolean; onVerify: () => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-sm text-foreground truncate">{title}</p>
        {subtitle && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate">
            <Phone className="h-3 w-3 shrink-0" />{subtitle}
          </p>
        )}
        {location && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{location}</p>}
        {tag && <Badge className="mt-1 bg-violet-500/15 text-violet-700 border-0 text-[10px] px-1.5 py-0">{tag}</Badge>}
      </div>
      <Button
        size="sm"
        onClick={onVerify}
        disabled={busy || !canVerify}
        className="gap-1.5 shrink-0"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        Verify
      </Button>
    </div>
  );
}