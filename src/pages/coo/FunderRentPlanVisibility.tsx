import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Eye, EyeOff, Search, Layers, Wallet, Hand, RefreshCw } from 'lucide-react';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

const LISTABLE_STATUSES = [
  'pending', 'approved', 'agent_ops_approved', 'tenant_ops_approved',
  'landlord_ops_approved', 'agent_verified', 'coo_approved',
];

interface PlanRow {
  id: string;
  tenant_id: string | null;
  rent_amount: number;
  duration_days: number | null;
  daily_repayment: number | null;
  house_category: string | null;
  request_city: string | null;
  status: string;
  created_at: string;
  funder_visible: boolean | null;
  funder_visibility_reason: string | null;
  funder_visibility_decided_at: string | null;
  tenant_name?: string;
  held_by_partner?: boolean;
}

function useFunderRentPlans() {
  return useQuery({
    queryKey: ['coo-funder-rent-plans'],
    staleTime: 30_000,
    queryFn: async (): Promise<PlanRow[]> => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, rent_amount, duration_days, daily_repayment, house_category, request_city, status, created_at, funder_visible, funder_visibility_reason, funder_visibility_decided_at')
        .is('funded_at', null)
        .is('disbursed_at', null)
        .is('supporter_id', null)
        .is('self_funding_partner_id', null)
        .eq('tenancy_status', 'active')
        .not('coo_reviewed_at', 'is', null)
        .gte('rent_amount', 50000)
        .in('status', LISTABLE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(400);
      if (error) throw error;

      const rows = (data ?? []) as PlanRow[];
      const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))] as string[];
      const planIds = rows.map((r) => r.id);

      const [profiles, claims] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', tenantIds)
          : Promise.resolve({ data: [], error: null } as never),
        planIds.length
          ? supabase
              .from('partner_self_plan_claims')
              .select('rent_request_id, status')
              .in('rent_request_id', planIds)
              .in('status', ['held', 'confirmed'])
          : Promise.resolve({ data: [], error: null } as never),
      ]);

      const nameById = new Map<string, string>(
        ((profiles.data ?? []) as { id: string; full_name: string | null }[])
          .map((p) => [p.id, p.full_name || 'Tenant']),
      );
      const held = new Set(
        ((claims.data ?? []) as { rent_request_id: string }[]).map((c) => c.rent_request_id),
      );

      return rows.map((r) => ({
        ...r,
        tenant_name: r.tenant_id ? nameById.get(r.tenant_id) || 'Tenant' : 'Tenant',
        held_by_partner: held.has(r.id),
      }));
    },
  });
}

export default function FunderRentPlanVisibility() {
  const [, setActiveTab] = usePersistedActiveTab('coo');
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading, refetch, isRefetching } = useFunderRentPlans();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'all' | 'listed' | 'hidden'>('all');
  const [hideTarget, setHideTarget] = useState<PlanRow | null>(null);
  const [reason, setReason] = useState('');

  const setVisibility = useMutation({
    mutationFn: async (input: { id: string; visible: boolean; reason?: string }) => {
      const { error } = await supabase
        .from('rent_requests')
        .update({
          funder_visible: input.visible,
          funder_visibility_reason: input.visible ? null : (input.reason || null),
          funder_visibility_decided_by: user?.id ?? null,
          funder_visibility_decided_at: new Date().toISOString(),
        })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: (_res, input) => {
      toast.success(input.visible ? 'Rent plan published to the Funder dashboard' : 'Rent plan hidden from the Funder dashboard');
      qc.invalidateQueries({ queryKey: ['coo-funder-rent-plans'] });
      setHideTarget(null);
      setReason('');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not update visibility'),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((r) => {
      if (tab === 'listed' && r.funder_visible === false) return false;
      if (tab === 'hidden' && r.funder_visible !== false) return false;
      if (!q) return true;
      return [r.tenant_name, r.request_city, r.house_category, r.status]
        .some((v) => (v || '').toLowerCase().includes(q));
    });
  }, [data, search, tab]);

  const stats = useMemo(() => {
    const all = data ?? [];
    const listed = all.filter((r) => r.funder_visible !== false);
    return {
      total: all.length,
      listed: listed.length,
      hidden: all.length - listed.length,
      listedValue: listed.reduce((s, r) => s + Number(r.rent_amount || 0), 0),
      held: all.filter((r) => r.held_by_partner).length,
    };
  }, [data]);

  return (
    <ExecutiveDashboardLayout role="coo" activeTab="funder-rent-plans" onTabChange={setActiveTab}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Funder Rent Plan Catalogue</h1>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Every rent plan eligible for the Funder dashboard. Publish or hide any plan — hidden plans
              disappear from the funder listing immediately and skip proxy partner attachment.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Eligible plans', value: String(stats.total), icon: Layers },
            { label: 'Listed to funders', value: String(stats.listed), icon: Eye },
            { label: 'Hidden by ops', value: String(stats.hidden), icon: EyeOff },
            { label: 'Listed value', value: ugx(stats.listedValue), icon: Wallet },
          ].map((k) => (
            <Card key={k.label}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{k.label}</span>
                  <k.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="mt-2 text-lg font-semibold">{k.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                Plans <span className="text-muted-foreground font-normal">({rows.length})</span>
                {stats.held > 0 && (
                  <Badge variant="secondary" className="ml-2 gap-1">
                    <Hand className="h-3 w-3" /> {stats.held} held by a partner
                  </Badge>
                )}
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                  <TabsList>
                    <TabsTrigger value="all">All</TabsTrigger>
                    <TabsTrigger value="listed">Listed</TabsTrigger>
                    <TabsTrigger value="hidden">Hidden</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8 w-full sm:w-56"
                    placeholder="Tenant, city, category"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : rows.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">No rent plans match this filter.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead className="hidden md:table-cell">Location</TableHead>
                      <TableHead className="hidden lg:table-cell">Stage</TableHead>
                      <TableHead>Funder dashboard</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const visible = r.funder_visible !== false;
                      return (
                        <TableRow key={r.id}>
                          <TableCell>
                            <div className="font-medium">{r.tenant_name}</div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(r.created_at).toLocaleDateString('en-GB')}
                              {r.held_by_partner && ' · held by a partner'}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{ugx(Number(r.rent_amount))}</div>
                            <div className="text-xs text-muted-foreground">
                              {r.duration_days ? `${r.duration_days} days` : '—'}
                              {r.daily_repayment ? ` · ${ugx(Number(r.daily_repayment))}/day` : ''}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm">
                            {r.request_city || '—'}
                            <div className="text-xs text-muted-foreground">{r.house_category || ''}</div>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <Badge variant="outline" className="capitalize">
                              {r.status.replace(/_/g, ' ')}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={visible}
                                disabled={setVisibility.isPending}
                                onCheckedChange={(next) => {
                                  if (next) setVisibility.mutate({ id: r.id, visible: true });
                                  else { setHideTarget(r); setReason(''); }
                                }}
                              />
                              <span className="text-xs text-muted-foreground">
                                {visible ? 'Listed' : 'Hidden'}
                              </span>
                            </div>
                            {!visible && r.funder_visibility_reason && (
                              <p className="mt-1 text-xs text-muted-foreground max-w-[16rem] truncate">
                                {r.funder_visibility_reason}
                              </p>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!hideTarget} onOpenChange={(o) => { if (!o) { setHideTarget(null); setReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hide this rent plan from funders?</DialogTitle>
            <DialogDescription>
              {hideTarget?.tenant_name} · {hideTarget ? ugx(Number(hideTarget.rent_amount)) : ''}. It will be
              removed from the Funder dashboard listing and will not receive a proxy partner.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason (at least 10 characters) — kept on the record"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setHideTarget(null); setReason(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 10 || setVisibility.isPending}
              onClick={() => hideTarget && setVisibility.mutate({ id: hideTarget.id, visible: false, reason: reason.trim() })}
            >
              Hide from funders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ExecutiveDashboardLayout>
  );
}
