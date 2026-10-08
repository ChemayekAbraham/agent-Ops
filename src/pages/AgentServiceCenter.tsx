import { cn } from '@/lib/utils';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { OverdueVettingBanner } from '@/components/service-center/OverdueVettingBanner';
import { useOverdueVettingAlert } from '@/hooks/useOverdueVettingAlert';
import { KIND_TAB, VET_FOCUS_EVENT, scrollAndHighlight, type VetFocus } from '@/components/service-center/vettingNav';
import type { OverdueKind } from '@/lib/vettingOverdueCopy';
import { ArrowLeft, ClipboardCheck, Package, Route, Search, ShoppingBag, Store, UserPlus, Users } from 'lucide-react';
import officeIllustration from '@/assets/At_the_office-bro-2.svg.asset.json';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StorageImage } from '@/components/ui/StorageImage';

import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUGX } from '@/lib/rentCalculations';
import {
  ServiceCenterSubAgent,
  useServiceCenterCatalog,
  useServiceCenterOverview,
  useServiceCenterTransfers,
} from '@/hooks/useAgentServiceCenter';
import { SubAgentRosterCard } from '@/components/agent/service-center/SubAgentRosterCard';
import { SubAgentRankingsBoard } from '@/components/agent/service-center/SubAgentRankingsBoard';
import { SubAgentDetailSheet } from '@/components/agent/service-center/SubAgentDetailSheet';
import { ServiceCenterRentVettingQueue } from '@/components/agent/service-center/ServiceCenterRentVettingQueue';
import { ServiceCenterListingVettingQueue } from '@/components/agent/service-center/ServiceCenterListingVettingQueue';
import { ServiceCenterVerificationVettingQueue } from '@/components/agent/service-center/ServiceCenterVerificationVettingQueue';
import { ServiceCenterPipelineTracker } from '@/components/agent/service-center/ServiceCenterPipelineTracker';
import { useServiceCenterRentQueue } from '@/hooks/useServiceCenterRentQueue';
import { useServiceCenterVerificationQueue } from '@/hooks/useServiceCenterVerificationQueue';
import { useServiceCenterListingQueue } from '@/hooks/useServiceCenterListingQueue';
import {
  SuspendSubAgentDialog,
  TransferTenantDialog,
  UnlinkSubAgentDialog,
} from '@/components/agent/service-center/SubAgentActionDialogs';
import { useRestoreBodyPointerEvents } from '@/hooks/useRestoreBodyPointerEvents';
import { SubAgentInviteLinkDialog } from '@/components/agent/SubAgentInviteLinkDialog';
import { TenantRentIntakeQueue, useTenantRentIntakeQueue } from '@/components/agent/TenantRentIntakeQueue';
import { merchandiseInstallmentSchedule } from '@/lib/merchandiseInstallments';

export default function AgentServiceCenter() {
  const navigate = useNavigate();
  useRestoreBodyPointerEvents();
  const { data, isLoading, error } = useServiceCenterOverview();
  const { data: transfers = [] } = useServiceCenterTransfers();
  const { data: catalog = [], isLoading: loadingCatalog } = useServiceCenterCatalog();
  const { data: vetting } = useServiceCenterRentQueue();
  const { data: verificationQueue } = useServiceCenterVerificationQueue();
  const { data: listingQueue = [] } = useServiceCenterListingQueue();
  const { openCount: intakeOpenCount, newCount: intakeNewCount } = useTenantRentIntakeQueue();

  const [query, setQuery] = useState('');
  const [vettingQuery, setVettingQuery] = useState('');
  const [visible, setVisible] = useState(20);
  const [suspendTarget, setSuspendTarget] = useState<ServiceCenterSubAgent | null>(null);
  const [transferTarget, setTransferTarget] = useState<ServiceCenterSubAgent | null>(null);
  const [transferRentRequestId, setTransferRentRequestId] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<ServiceCenterSubAgent | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [mainTab, setMainTab] = useState('team');
  const [vetTab, setVetTab] = useState('rent');
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: overdueData } = useOverdueVettingAlert({ suppressed: true });

  const focusItem = (t: VetFocus) => {
    setMainTab('vetting');
    setVetTab(KIND_TAB[t.kind]);
    setVettingQuery('');
    scrollAndHighlight(t.kind, t.id);
  };
  useEffect(() => {
    const kind = searchParams.get('vet') as OverdueKind | null;
    const id = searchParams.get('item');
    if (kind && id && KIND_TAB[kind]) {
      focusItem({ kind, id });
      const next = new URLSearchParams(searchParams); next.delete('vet'); next.delete('item');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  useEffect(() => {
    const on = (e: Event) => focusItem((e as CustomEvent<VetFocus>).detail);
    window.addEventListener(VET_FOCUS_EVENT, on);
    return () => window.removeEventListener(VET_FOCUS_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const jumpToOldest = () => {
    const first = overdueData?.oldest?.[0];
    if (first) focusItem({ kind: first.kind, id: first.id });
  };

  const subAgents = data?.sub_agents ?? [];
  // Derived so the open sheet re-renders with fresh data after suspend/restore/transfer,
  // and closes by itself once an unlinked sub-agent leaves the roster.
  const detailTarget = detailId
    ? subAgents.find((s) => s.sub_agent_id === detailId) ?? null
    : null;
  // Reuses the transfers query already on this page — no extra round trip.
  const pendingTransferRentRequestIds = useMemo(
    () => transfers.filter((t) => t.status === 'pending').map((t) => t.rent_request_id),
    [transfers],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return subAgents;
    return subAgents.filter((s) =>
      [s.full_name, s.phone, s.email].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
  }, [subAgents, query]);

  // Statuses that mean a rent plan is still being vetted somewhere in the
  // pipeline (not yet funded, not rejected/closed).
  const PENDING_TENANT_STATUSES = [
    'service_center_review',
    'pending',
    'pending_approval',
    'under_review',
    'submitted',
    'agent_ops_review',
    'tenant_ops_review',
    'landlord_ops_review',
    'coo_review',
    'awaiting_funding',
  ];

  const totals = useMemo(() => ({
    subAgents: subAgents.length,
    tenants: subAgents.reduce((a, s) => a + Number(s.active_tenants || 0), 0),
    allTenants: subAgents.reduce((a, s) => a + Number(s.total_tenants || 0), 0),
    commissions: subAgents.reduce((a, s) => a + Number(s.commission_total || 0), 0),
    bonuses: subAgents.reduce((a, s) => a + Number(s.referral_bonus || 0), 0),
    landlords: subAgents.reduce((a, s) => a + Number(s.landlords_registered || 0), 0),
    landlordsPending: subAgents.reduce((a, s) => a + Number(s.landlords_pending || 0), 0),
    houses: subAgents.reduce((a, s) => a + Number(s.houses_listed || 0), 0),
    housesPending: subAgents.reduce((a, s) => a + Number(s.houses_pending || 0), 0),
    tenantsPending: subAgents.reduce(
      (a, s) =>
        a +
        (s.tenant_list ?? []).filter((t) =>
          PENDING_TENANT_STATUSES.includes(String(t.status ?? '').toLowerCase()),
        ).length,
      0,
    ),
    pending: transfers.filter((t) => t.status === 'pending').length,
  }), [subAgents, transfers]);

  return (
    <div className="min-h-[100dvh] bg-background">
      {/* Sticky top bar with back navigation to /dashboard/agent */}
      <div className="sticky top-0 z-30 border-b border-border/60 bg-background/95 backdrop-blur-md px-3 sm:px-4 py-2">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/dashboard/agent')}
            aria-label="Back to Agent Dashboard"
            className="h-8 gap-1.5 px-2 text-xs sm:text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span>Back to Agent Dashboard</span>
          </Button>
        </div>
      </div>

      <header className="border-b border-border/60 bg-background">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <img
            src={officeIllustration.url}
            alt="Service center illustration"
            className="mx-auto block mb-3 h-28 w-auto"
            loading="eager"
          />
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-left text-lg font-bold text-foreground">
              <Store className="h-5 w-5 text-primary" /> Service Center
            </h1>
            <p className="truncate text-left text-xs text-muted-foreground">
              Your team, their tenants and your supplies in one place
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4 pb-24">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: 'Sub-agents', value: String(totals.subAgents) },
            { label: 'Tenants (active/total)', value: `${totals.tenants}/${totals.allTenants}` },
            { label: 'Team commissions', value: formatUGX(totals.commissions + totals.bonuses) },
            { label: 'Landlords registered', value: String(totals.landlords) },
            { label: 'Houses listed', value: String(totals.houses) },
            { label: 'Rent requests to vet', value: String(vetting?.pending_count ?? 0) },
            { label: 'Landlords & LC1 to vet', value: String(verificationQueue?.pending_count ?? 0) },
            { label: 'Houses pending verification', value: String(totals.housesPending) },
            { label: 'Landlords pending verification', value: String(totals.landlordsPending) },
            { label: 'Tenants pending funding', value: String(totals.tenantsPending) },
            { label: 'Pending transfers', value: String(totals.pending) },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-3">
                <div className="text-[11px] text-muted-foreground">{s.label}</div>
                <div className={cn('text-base font-bold break-words', s.value === '0' ? 'text-muted-foreground' : 'text-foreground')}>
                  {s.value}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="sticky top-0 z-20"><OverdueVettingBanner onJumpToOldest={jumpToOldest} /></div>
        <Tabs value={mainTab} onValueChange={setMainTab}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="team" className="text-xs sm:text-sm">
              <Users className="mr-1.5 h-4 w-4" /> Team
            </TabsTrigger>
            <TabsTrigger value="vetting" className="text-xs sm:text-sm">
              <ClipboardCheck className="mr-1.5 h-4 w-4" /> Vetting
            </TabsTrigger>
            <TabsTrigger value="followup" className="text-xs sm:text-sm">
              <Route className="mr-1.5 h-4 w-4" /> Follow-up
            </TabsTrigger>
            <TabsTrigger value="transfers" className="text-xs sm:text-sm">Transfers</TabsTrigger>
            <TabsTrigger value="shop" className="text-xs sm:text-sm">
              <ShoppingBag className="mr-1.5 h-4 w-4" /> Shop
            </TabsTrigger>
          </TabsList>

          <TabsContent value="vetting" className="mt-3 space-y-3">
            {intakeNewCount > 0 && (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
                <p className="text-xs font-semibold text-primary">
                  {intakeNewCount} tenant{intakeNewCount === 1 ? '' : 's'} asked for rent themselves
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Open the “Tenant requests” tab to claim, visit and verify them.
                </p>
              </div>
            )}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={vettingQuery}
                onChange={(e) => setVettingQuery(e.target.value)}
                placeholder="Search by agent, tenant, landlord, phone…"
                className="pl-9 text-xs sm:text-sm h-9 sm:h-10"
              />
            </div>
            <Tabs value={vetTab} onValueChange={setVetTab}>
              <TabsList className="grid w-full grid-cols-3 sm:grid-cols-5 h-auto gap-1 p-1">
                <TabsTrigger value="rent" className="text-[10px] sm:text-[11px] px-1 py-1.5 whitespace-normal leading-tight text-center">
                  Rent{vetting?.pending_count ? ` (${vetting.pending_count})` : ''}
                </TabsTrigger>
                <TabsTrigger value="tenant_requests" className="text-[10px] sm:text-[11px] px-1 py-1.5 whitespace-normal leading-tight text-center">
                  Tenant requests{intakeOpenCount ? ` (${intakeOpenCount})` : ''}
                </TabsTrigger>
                <TabsTrigger value="houses" className="text-[10px] sm:text-[11px] px-1 py-1.5 whitespace-normal leading-tight text-center">
                  Houses{listingQueue.length ? ` (${listingQueue.length})` : ''}
                </TabsTrigger>
                <TabsTrigger value="landlords" className="text-[10px] sm:text-[11px] px-1 py-1.5 whitespace-normal leading-tight text-center">
                  Landlords{verificationQueue?.landlords?.length ? ` (${verificationQueue.landlords.length})` : ''}
                </TabsTrigger>
                <TabsTrigger value="lc1" className="text-[10px] sm:text-[11px] px-1 py-1.5 whitespace-normal leading-tight text-center">
                  LC1{verificationQueue?.lc1?.length ? ` (${verificationQueue.lc1.length})` : ''}
                </TabsTrigger>
              </TabsList>


              <TabsContent value="tenant_requests" className="mt-3">
                <TenantRentIntakeQueue searchQuery={vettingQuery} />
              </TabsContent>

              <TabsContent value="rent" className="mt-3">
                <ServiceCenterRentVettingQueue searchQuery={vettingQuery} />
              </TabsContent>
              <TabsContent value="houses" className="mt-3">
                <ServiceCenterListingVettingQueue searchQuery={vettingQuery} />
              </TabsContent>
              <TabsContent value="landlords" className="mt-3">
                <ServiceCenterVerificationVettingQueue only="landlord" searchQuery={vettingQuery} />
              </TabsContent>
              <TabsContent value="lc1" className="mt-3">
                <ServiceCenterVerificationVettingQueue only="lc1" searchQuery={vettingQuery} />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="followup" className="mt-3 space-y-3">
            <ServiceCenterPipelineTracker />
          </TabsContent>

          <TabsContent value="team" className="mt-3 space-y-3">
            <SubAgentRankingsBoard
              subAgents={subAgents}
              isLoading={isLoading}
              error={error}
              onOpenSubAgent={setDetailId}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => setInviteOpen(true)}
                className="gap-2 shrink-0 bg-primary text-primary-foreground text-xs sm:text-sm h-9 sm:h-10 px-2.5 sm:px-4"
              >
                <UserPlus className="h-4 w-4" /> <span className="truncate">Invite Sub-Agent</span>
              </Button>
              <div className="relative flex-1 min-w-[160px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, phone or email"
                  className="pl-9 text-xs sm:text-sm h-9 sm:h-10"
                />
              </div>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
              </div>
            ) : error ? (
              <Card><CardContent className="p-6 text-sm text-destructive">
                Could not load your team. Pull down to retry.
              </CardContent></Card>
            ) : filtered.length === 0 ? (
              <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
                {subAgents.length === 0 ? 'You have no sub-agents yet.' : 'No sub-agent matches that search.'}
              </CardContent></Card>
            ) : (
              filtered.slice(0, visible).map((s) => (
                <SubAgentRosterCard
                  key={s.sub_agent_id}
                  subAgent={s}
                  onOpen={(sa) => setDetailId(sa.sub_agent_id)}
                />
              ))
            )}

            {filtered.length > visible && (
              <Button variant="outline" className="w-full" onClick={() => setVisible((v) => v + 20)}>
                Show more ({filtered.length - visible} left)
              </Button>
            )}
          </TabsContent>

          <TabsContent value="transfers" className="mt-3 space-y-2">
            {transfers.length === 0 ? (
              <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
                No tenant transfer requests yet.
              </CardContent></Card>
            ) : (
              transfers.map((t) => (
                <Card key={t.id}>
                  <CardContent className="space-y-1 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{t.tenant_name ?? 'Tenant'}</span>
                      <Badge
                        variant={t.status === 'approved' ? 'default' : t.status === 'pending' ? 'outline' : 'destructive'}
                        className="text-[10px] capitalize"
                      >
                        {t.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t.from_name ?? '—'} → {t.to_name ?? '—'}
                    </p>
                    <p className="text-xs text-muted-foreground">Reason: {t.reason}</p>
                    {t.decision_reason && (
                      <p className="text-xs text-muted-foreground">Ops note: {t.decision_reason}</p>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="shop" className="mt-3 space-y-2">
            {loadingCatalog ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
            ) : catalog.length === 0 ? (
              <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
                No items are available right now.
              </CardContent></Card>
            ) : (
              catalog.map((item) => {
                const img = item.image_urls?.[0] || item.image_url;
                return (
                  <Card key={item.id} className="overflow-hidden">
                    <CardContent className="flex items-center gap-3 p-3">
                      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                        {img ? (
                          <StorageImage src={img} alt={item.item_name} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Package className="h-6 w-6 text-muted-foreground/40" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-foreground">{item.item_name}</div>
                        <div className="text-xs text-muted-foreground">{formatUGX(item.unit_price)}</div>
                        <div className="mt-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          Or pay in instalments — from{' '}
                          {formatUGX(merchandiseInstallmentSchedule(Number(item.unit_price) || 0, 12).firstDaily)}/day
                          {' '}over up to 12 months
                        </div>
                      </div>
                      <Button size="sm" onClick={() => navigate(`/merchandise?item=${item.id}`)}>
                        Buy
                      </Button>
                    </CardContent>
                  </Card>
                );
              })

            )}
          </TabsContent>
        </Tabs>
      </main>

      <SubAgentDetailSheet
        subAgent={detailTarget}
        open={!!detailTarget}
        onOpenChange={(v) => !v && setDetailId(null)}
        onSuspend={(s) => { setDetailId(null); setSuspendTarget(s); }}
        onTransfer={(s, rentRequestId) => {
          setDetailId(null);
          setTransferRentRequestId(rentRequestId);
          setTransferTarget(s);
        }}
        onUnlink={(s) => { setDetailId(null); setUnlinkTarget(s); }}
        actionsDisabled={!!suspendTarget || !!unlinkTarget || !!transferTarget}
        pendingTransferRentRequestIds={pendingTransferRentRequestIds}
      />
      <SuspendSubAgentDialog
        subAgent={suspendTarget ? subAgents.find((s) => s.sub_agent_id === suspendTarget.sub_agent_id) ?? suspendTarget : null}
        open={!!suspendTarget}
        onOpenChange={(v) => !v && setSuspendTarget(null)}
      />
      <TransferTenantDialog
        subAgent={transferTarget}
        peers={subAgents}
        open={!!transferTarget}
        presetRentRequestId={transferRentRequestId}
        pendingRentRequestIds={pendingTransferRentRequestIds}
        onOpenChange={(v) => { if (!v) { setTransferTarget(null); setTransferRentRequestId(null); } }}
      />
      <UnlinkSubAgentDialog
        subAgent={unlinkTarget ? subAgents.find((s) => s.sub_agent_id === unlinkTarget.sub_agent_id) ?? unlinkTarget : null}
        open={!!unlinkTarget}
        onOpenChange={(v) => { if (!v) { setUnlinkTarget(null); } }}
      />
      <SubAgentInviteLinkDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}