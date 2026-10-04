import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight, Building2, Home, KeyRound, Mail, Phone, ShieldCheck, ShieldOff, Unlink, Users, Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { normalizeUgandaRegion } from '@/lib/ugandaDistricts';
import { ServiceCenterState, ServiceCenterSubAgent } from '@/hooks/useAgentServiceCenter';
import { initialsOf, tintFor } from './subAgentVisuals';
import { EntityRow, SubAgentEntityList } from './SubAgentEntityList';
import { ServiceCenterTenantPayments } from './ServiceCenterTenantPayments';
import { pipelineStageLabel } from '@/lib/rentPipelineStages';

const dateLabel = (v?: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala',
      })
    : '—';

const ACTIVE_STATUSES = ['funded', 'repaying'];

const tenantState = (status: string, isActive?: boolean): ServiceCenterState => {
  if (isActive || ACTIVE_STATUSES.includes(status)) return 'verified';
  if (/reject|cancel|declin|deleted/i.test(status)) return 'rejected';
  return 'pending';
};

function Metric({
  label, value, tone, icon: Icon,
}: {
  label: string;
  value: string;
  tone: 'primary' | 'success' | 'warning' | 'accent';
  icon: React.ComponentType<{ className?: string }>;
}) {
  const tones = {
    primary: 'bg-primary/10 text-primary border-primary/25',
    success: 'bg-success/10 text-success border-success/25',
    warning: 'bg-warning/10 text-warning border-warning/25',
    accent: 'bg-accent text-accent-foreground border-border',
  } as const;
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium opacity-80">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 break-words text-sm font-bold">{value}</div>
    </div>
  );
}

export function SubAgentDetailSheet({
  subAgent,
  open,
  onOpenChange,
  onSuspend,
  onTransfer,
  onUnlink,
  actionsDisabled = false,
  pendingTransferRentRequestIds = [],
}: {
  subAgent: ServiceCenterSubAgent | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuspend: (s: ServiceCenterSubAgent) => void;
  onTransfer: (s: ServiceCenterSubAgent, rentRequestId: string) => void;
  onUnlink: (s: ServiceCenterSubAgent) => void;
  /** True while one of the action dialogs is open / a mutation is running. */
  actionsDisabled?: boolean;
  /** Rent plans already awaiting an Agent Ops decision — the server refuses a second request. */
  pendingTransferRentRequestIds?: string[];
}) {
  const [entityTab, setEntityTab] = useState<'tenants' | 'landlords' | 'houses'>('tenants');

  useEffect(() => {
    if (open) setEntityTab('tenants');
  }, [open, subAgent?.sub_agent_id]);

  const tenantRows = useMemo<EntityRow[]>(() => (subAgent?.tenant_list ?? []).map((t) => ({
    id: t.rent_request_id,
    state: tenantState(t.status, t.is_active),
    primary: t.tenant_name ?? 'Unnamed tenant',
    statusKey: t.status,
    statusLabel: pipelineStageLabel(t.status),
    secondary: [t.tenant_phone, t.location].filter(Boolean).join(' · ') || t.status.replace(/_/g, ' '),
    amountLabel: t.monthly_rent ? formatUGX(t.monthly_rent) : null,
    amountValue: t.monthly_rent ?? 0,
    createdAt: t.created_at ?? null,
    progressPercent: t.total_repayment
      ? Math.min(100, ((t.amount_repaid ?? 0) / Number(t.total_repayment)) * 100)
      : null,
    progressLabel: t.total_repayment
      ? `${formatUGX(t.amount_repaid ?? 0)} of ${formatUGX(Number(t.total_repayment))}`
      : null,
    details: [
      { label: 'Phone', value: t.tenant_phone || '—' },
      { label: 'Location', value: t.location || '—' },
      { label: 'Landlord', value: t.landlord_name || '—' },
      { label: 'Landlord phone', value: t.landlord_phone || '—' },
      { label: 'Rent plan status', value: t.status.replace(/_/g, ' ') },
      { label: 'Monthly rent', value: t.monthly_rent ? formatUGX(t.monthly_rent) : '—' },
      { label: 'Daily amount', value: t.daily_repayment ? formatUGX(Number(t.daily_repayment)) : '—' },
      { label: 'Repaid so far', value: formatUGX(t.amount_repaid ?? 0) },
      { label: 'Plan total', value: t.total_repayment ? formatUGX(Number(t.total_repayment)) : '—' },
      {
        label: 'Balance',
        value: t.total_repayment
          ? formatUGX(Math.max(0, Number(t.total_repayment) - (t.amount_repaid ?? 0)))
          : '—',
      },
      { label: 'Active plan', value: t.is_active ? 'Yes' : 'No' },
      { label: 'Plan owner', value: t.owned_by_subagent ? 'This sub-agent' : 'Referral only' },
      { label: 'Added', value: dateLabel(t.created_at) },
    ],
  })), [subAgent?.tenant_list]);

  const houseRows = useMemo<EntityRow[]>(() => (subAgent?.house_list ?? []).map((h) => ({
    id: h.id,
    state: h.state,
    primary: h.title || h.address || 'Untitled house',
    secondary: [h.district, h.region].filter(Boolean).join(', ') || null,
    amountLabel: h.monthly_rent ? formatUGX(h.monthly_rent) : null,
    amountValue: h.monthly_rent ?? 0,
    createdAt: h.created_at,
    images: h.photos ?? [],
    details: [
      { label: 'Address', value: h.address || '—' },
      { label: 'District', value: h.district || '—' },
      { label: 'Region', value: h.region || '—' },
      { label: 'Monthly rent', value: h.monthly_rent ? formatUGX(h.monthly_rent) : '—' },
      { label: 'Listing status', value: (h.status || '—').replace(/_/g, ' ') },
      { label: 'Occupancy', value: h.occupied ? 'Occupied' : 'Vacant' },
      { label: 'Photos', value: String(h.photo_count ?? (h.photos?.length ?? 0)) },
      { label: 'Verified on', value: dateLabel(h.verified_at) },
      { label: 'Listed on', value: dateLabel(h.created_at) },
      ...(h.reason ? [{ label: 'Rejection reason', value: h.reason }] : []),
    ],
  })), [subAgent?.house_list]);

  const landlordRows = useMemo<EntityRow[]>(() => (subAgent?.landlord_list ?? []).map((l) => {
    const district = l.district || null;
    const addressBits = [l.address, l.village, l.county].filter(Boolean) as string[];
    const regionSeed = l.region || district || l.county || l.village || l.address || null;
    const normalized = regionSeed ? normalizeUgandaRegion(regionSeed) : null;
    const region = normalized && normalized !== 'Unknown region' ? normalized : null;
    return {
    id: l.id,
    state: l.state,
    primary: l.name || 'Unnamed landlord',
    secondary: [l.phone, district || addressBits[0], region].filter(Boolean).join(' · ') || null,
    createdAt: l.created_at,
    details: [
      { label: 'Phone', value: l.phone || '—' },
      { label: 'Address', value: addressBits.join(', ') || '—' },
      { label: 'District', value: district || '—' },
      { label: 'Region', value: region || '—' },
      { label: 'Link', value: l.link_source === 'assigned' ? 'Assigned' : 'Registered by sub-agent' },
      { label: 'Verified on', value: dateLabel(l.verified_at) },
      { label: 'Registered', value: dateLabel(l.created_at) },
      ...(l.reason ? [{ label: 'Verification note', value: l.reason }] : []),
    ],
    };
  }), [subAgent?.landlord_list]);

  if (!subAgent) return null;

  const suspended = !!subAgent.suspension;
  const tint = tintFor(subAgent.sub_agent_id);
  const until = subAgent.suspension?.blocked_until
    ? new Date(subAgent.suspension.blocked_until).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala',
      })
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92dvh] rounded-t-3xl p-0">
        <ScrollArea className="h-full">
          <div className={`${tint.header} px-5 pb-6 pt-8`}>
            <div className="flex items-start gap-3">
              <Avatar className="h-14 w-14 shrink-0 ring-2 ring-background">
                <AvatarImage src={subAgent.avatar_url ?? undefined} alt={subAgent.full_name ?? 'Sub-agent'} />
                <AvatarFallback className={tint.fallback}>{initialsOf(subAgent.full_name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-bold text-foreground">
                  {subAgent.full_name ?? 'Unnamed sub-agent'}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {suspended ? (
                    <Badge variant="destructive" className="text-[10px]">
                      Suspended{until ? ` · to ${until}` : ''}
                    </Badge>
                  ) : (
                    <Badge className="bg-success/15 text-success hover:bg-success/15 text-[10px]">
                      <ShieldCheck className="mr-1 h-3 w-3" /> Active
                    </Badge>
                  )}
                  {subAgent.link_status !== 'verified' && (
                    <Badge variant="outline" className="text-[10px]">Awaiting acceptance</Badge>
                  )}
                  {subAgent.agent_tier && (
                    <Badge variant="secondary" className="text-[10px] capitalize">{subAgent.agent_tier}</Badge>
                  )}
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {subAgent.phone && (
                    <a href={`tel:${subAgent.phone}`} className="flex items-center gap-1.5 hover:text-foreground">
                      <Phone className="h-3.5 w-3.5" />{subAgent.phone}
                    </a>
                  )}
                  {subAgent.email && (
                    <a href={`mailto:${subAgent.email}`} className="flex items-center gap-1.5 truncate hover:text-foreground">
                      <Mail className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{subAgent.email}</span>
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-5 p-5">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Earnings</h3>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Commissions" value={formatUGX(subAgent.commission_total)} tone="success" icon={Wallet} />
                <Metric label="Referral bonus" value={formatUGX(subAgent.referral_bonus)} tone="primary" icon={Users} />
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Portfolio</h3>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Tenants" value={String(subAgent.active_tenants)} tone="primary" icon={Users} />
                <Metric
                  label="Landlords"
                  value={`${subAgent.landlords_verified}/${subAgent.landlords_registered}`}
                  tone="accent"
                  icon={Home}
                />
                <Metric
                  label="Houses (verified/total)"
                  value={`${subAgent.houses_verified ?? 0}/${subAgent.houses_listed ?? 0}`}
                  tone="primary"
                  icon={Home}
                />
                <Metric label="Own subs" value={String(subAgent.nested_subagents ?? 0)} tone="accent" icon={Users} />
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wallet</h3>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="Withdrawable" value={formatUGX(subAgent.wallet?.withdrawable ?? 0)} tone="success" icon={Wallet} />
                <Metric label="Float" value={formatUGX(subAgent.wallet?.float ?? 0)} tone="primary" icon={Wallet} />
                <Metric label="Advance" value={formatUGX(subAgent.wallet?.advance ?? 0)} tone="warning" icon={Wallet} />
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
                {([
                  { key: 'tenants', label: 'Tenants', icon: Users, count: tenantRows.length },
                  { key: 'landlords', label: 'Landlords', icon: KeyRound, count: landlordRows.length },
                  { key: 'houses', label: 'Houses', icon: Building2, count: houseRows.length },
                ] as const).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setEntityTab(t.key)}
                    className={cn(
                      'flex min-h-[36px] flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-colors',
                      entityTab === t.key
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground',
                    )}
                    aria-pressed={entityTab === t.key}
                  >
                    <t.icon className="h-3.5 w-3.5" />
                    <span className="truncate">{t.label}</span>
                    <span className="tabular-nums opacity-70">{t.count}</span>
                  </button>
                ))}
              </div>

              {entityTab === 'tenants' && (
                <SubAgentEntityList
                  hideHeading
                  heading="Tenants"
                  emptyLabel="No tenants linked to this sub-agent yet."
                  rows={tenantRows}
                  showStatusFilter
                  resetKey={`${subAgent.sub_agent_id}-tenants-${open}`}
                  renderRowAction={(r) => {
                    const t = subAgent.tenant_list.find((x) => x.rent_request_id === r.id);
                    // Mirror the server rules so the button never opens a dialog that refuses.
                    const transferPending = pendingTransferRentRequestIds.includes(r.id);
                    const eligible =
                      !!t?.is_active &&
                      t.owned_by_subagent !== false &&
                      ['funded', 'repaying'].includes(t.status);
                    return (
                      <div className="space-y-3">
                        <ServiceCenterTenantPayments rentRequestId={r.id} />
                        {t?.is_active && (eligible || transferPending) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full sm:w-auto"
                            disabled={actionsDisabled || transferPending}
                            onClick={() => onTransfer(subAgent, t.rent_request_id)}
                          >
                            <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
                            {transferPending ? 'Transfer awaiting approval' : 'Transfer tenant'}
                          </Button>
                        )}
                      </div>
                    );
                  }}
                />
              )}

              {entityTab === 'landlords' && (
                <SubAgentEntityList
                  hideHeading
                  heading="Landlords"
                  emptyLabel="No landlords registered or assigned to this sub-agent yet."
                  rows={landlordRows}
                  showAmountSort={false}
                  resetKey={`${subAgent.sub_agent_id}-landlords-${open}`}
                />
              )}

              {entityTab === 'houses' && (
                <SubAgentEntityList
                  hideHeading
                  heading="Houses"
                  emptyLabel="This sub-agent has not listed any houses yet."
                  rows={houseRows}
                  resetKey={`${subAgent.sub_agent_id}-houses-${open}`}
                />
              )}
            </section>

            {subAgent.suspension?.reason && (
              <p className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                Suspension reason: {subAgent.suspension.reason}
              </p>
            )}

            <div className="flex flex-col gap-2 pb-4 sm:flex-row">
              <Button
                variant="outline"
                className="flex-1"
                disabled={actionsDisabled}
                onClick={() => onUnlink(subAgent)}
              >
                <Unlink className="mr-1.5 h-4 w-4" /> Unlink sub-agent
              </Button>
              <Button
                variant={suspended ? 'secondary' : 'destructive'}
                className="flex-1"
                disabled={actionsDisabled}
                onClick={() => onSuspend(subAgent)}
              >
                <ShieldOff className="mr-1.5 h-4 w-4" /> {suspended ? 'Restore access' : 'Suspend'}
              </Button>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
