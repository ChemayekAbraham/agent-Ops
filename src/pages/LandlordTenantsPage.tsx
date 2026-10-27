import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, ChevronDown, MapPin, Phone, RefreshCw, Search, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import ScreenLoader from '@/components/common/ScreenLoader';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  PLAN_PHASE_LABEL,
  planPhase,
  useMyLandlordTenants,
  type LandlordTenant,
  type LandlordTenantPlan,
  type PlanPhase,
} from '@/hooks/useMyLandlordTenants';

const PHASE_STYLE: Record<PlanPhase, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  in_review: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  completed: 'bg-primary/10 text-primary',
  ended: 'bg-muted text-muted-foreground',
};

type Filter = 'all' | 'active' | 'in_review' | 'completed';
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'in_review', label: 'In review' },
  { key: 'completed', label: 'Completed' },
];

/** Accepts a date-only string (2026-10-26) or a full timestamp. */
const fmtDate = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? null : format(d, 'dd MMM yyyy');
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

function PhaseBadge({ phase }: { phase: PlanPhase }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', PHASE_STYLE[phase])}>
      {PLAN_PHASE_LABEL[phase]}
    </span>
  );
}

function PlanDetails({ plan }: { plan: LandlordTenantPlan }) {
  const phase = planPhase(plan);
  const showProgress = phase !== 'in_review';
  const started = fmtDate(plan.starts_on);
  const ends = fmtDate(plan.ends_on);
  const applied = fmtDate(plan.created_at);

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">Rent</p>
          <p className="text-lg font-bold tabular-nums leading-tight">{formatUGX(Number(plan.rent_amount) || 0)}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <PhaseBadge phase={phase} />
          {plan.duration_days ? (
            <span className="text-[11px] text-muted-foreground">{plan.duration_days}-day Rent Plan</span>
          ) : null}
        </div>
      </div>

      {showProgress && (
        <div className="space-y-1">
          <Progress value={Math.max(0, Math.min(100, plan.progress_pct))} size="sm" />
          <p className="text-[11px] text-muted-foreground">{plan.progress_pct}% repaid by the tenant</p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {phase === 'in_review'
          ? `Applied ${applied ?? '—'} · being reviewed`
          : `Started ${started ?? applied ?? '—'}${ends ? ` · ends ${ends}` : ''}`}
      </p>
    </div>
  );
}

function TenantCard({ tenant }: { tenant: LandlordTenant }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const earlier = tenant.plans.slice(1);

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {initials(tenant.name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{tenant.name}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {tenant.phone && (
              <a href={`tel:${tenant.phone}`} className="inline-flex items-center gap-1 hover:text-foreground">
                <Phone className="h-3 w-3" /> {tenant.phone}
              </a>
            )}
            {tenant.property && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {tenant.property}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-muted/40 p-3">
        <PlanDetails plan={tenant.latest} />
      </div>

      {earlier.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowEarlier((v) => !v)}
            aria-expanded={showEarlier}
            className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <span>
              {earlier.length} earlier Rent Plan{earlier.length === 1 ? '' : 's'}
            </span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', showEarlier && 'rotate-180')} />
          </button>
          {showEarlier && (
            <ul className="mt-1 divide-y divide-border rounded-xl border border-border">
              {earlier.map((p) => (
                <li key={p.id} className="p-3">
                  <PlanDetails plan={p} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function LandlordTenantsPage() {
  const navigate = useNavigate();
  const { tenants, counts, matchedByPhone, isLoading, error, refetch } = useMyLandlordTenants();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tenants.filter((t) => {
      if (filter !== 'all' && planPhase(t.latest) !== filter) return false;
      if (!q) return true;
      return `${t.name} ${t.phone ?? ''} ${t.property ?? ''}`.toLowerCase().includes(q);
    });
  }, [tenants, filter, search]);

  if (isLoading) return <ScreenLoader />;

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back" className="-ml-2 h-10 w-10 shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-lg font-bold leading-tight">
              <Users className="h-5 w-5 shrink-0 text-primary" /> My Tenants
            </h1>
            <p className="truncate text-xs text-muted-foreground">Who rents from you, and their Rent Plans</p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-lg space-y-4 px-4 pb-24 pt-4">
        {error ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">We couldn&apos;t load your tenants. Please check your connection and try again.</p>
            <Button size="sm" variant="outline" className="gap-1.5 rounded-full" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          </div>
        ) : !matchedByPhone ? (
          <div className="space-y-3 rounded-2xl border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium">We couldn&apos;t find your property yet</p>
            <p className="text-xs text-muted-foreground">
              Add your phone number to your profile so we can match it to the houses registered under you.
            </p>
            <Button size="sm" className="rounded-full" onClick={() => navigate('/your-profile')}>
              Go to your profile
            </Button>
          </div>
        ) : tenants.length === 0 ? (
          <div className="space-y-2 rounded-2xl border border-dashed border-border p-8 text-center">
            <Users className="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium">No tenants yet</p>
            <p className="text-xs text-muted-foreground">
              When a tenant starts a Rent Plan for one of your houses, they&apos;ll show up here.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Tenants', value: counts.tenants },
                { label: 'Active plans', value: counts.active },
                { label: 'Completed', value: counts.completed },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-border/70 bg-card p-3 text-center">
                  <p className="text-xl font-bold tabular-nums leading-none">{s.value}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>

            {tenants.length > 5 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, phone or house"
                  aria-label="Search tenants"
                  className="h-11 rounded-full border-transparent bg-muted/70 pl-10 pr-10 text-base focus-visible:bg-background sm:text-sm"
                />
                {search && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}

            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 no-scrollbar">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'h-9 shrink-0 rounded-full border px-4 text-xs font-semibold transition-colors',
                    filter === f.key ? 'border-foreground bg-foreground text-background' : 'border-border bg-card hover:bg-muted',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No tenants match this view.</p>
            ) : (
              <div className="space-y-3">
                {visible.map((t) => (
                  <TenantCard key={t.tenantId} tenant={t} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
