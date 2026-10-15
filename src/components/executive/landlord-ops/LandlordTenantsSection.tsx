import { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, MessageCircle, Phone, RefreshCw, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLandlordTenantOverview } from '@/hooks/useLandlordTenantOverview';
import {
  fundingStageClass,
  formatUgx,
  landlordTenantsErrorMessage,
  planStatusLabel,
  summariseTenants,
  toInternationalPhone,
  type LandlordTenantRow,
} from '@/lib/landlordTenants';

/** Tenants listed at a time; "Show more" adds the next batch (a landlord can have thousands of Rent Plans). */
const BATCH = 25;

/**
 * Read-only "Tenants" section for a landlord: every Rent Plan on them, with the tenant, the money, the plan stage, the funding stage
 * and the agent. Loaded from landlord_tenant_overview; nothing here writes anything or changes any approve, reject or edit behaviour.
 */
export function LandlordTenantsSection({ landlordId, enabled = true, className }: { landlordId: string | null | undefined; enabled?: boolean; className?: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useLandlordTenantOverview(landlordId, enabled);
  const [shown, setShown] = useState(BATCH);
  const rows = data ?? [];
  const totals = useMemo(() => summariseTenants(rows), [rows]);

  return (
    <section className={cn('space-y-2.5', className)} aria-label="Tenants">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> Tenants
        </p>
        {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Refreshing" />}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-4 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading tenants…
        </div>
      ) : isError ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {landlordTenantsErrorMessage(error)}
          </p>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          This landlord has no tenants on a Rent Plan yet.
        </p>
      ) : (
        <>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs" data-testid="tenants-total">
            <p className="font-semibold">
              {totals.tenants.toLocaleString('en-US')} {totals.tenants === 1 ? 'tenant' : 'tenants'}
              <span className="mx-1.5 text-muted-foreground">·</span>
              Total rent {formatUgx(totals.totalRent)}
              <span className="mx-1.5 text-muted-foreground">·</span>
              Total balance {formatUgx(totals.totalBalance)}
            </p>
            {totals.excludedPlans > 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {totals.excludedPlans.toLocaleString('en-US')} rejected or cancelled Rent {totals.excludedPlans === 1 ? 'Plan is' : 'Plans are'} listed below but not counted.
              </p>
            )}
          </div>

          <ul className="space-y-2">
            {rows.slice(0, shown).map((r) => <TenantCard key={r.rent_request_id} row={r} />)}
          </ul>

          {rows.length > shown && (
            <Button type="button" variant="outline" size="sm" className="h-9 w-full" onClick={() => setShown((n) => n + BATCH)}>
              Show more ({(rows.length - shown).toLocaleString('en-US')} more)
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function TenantCard({ row }: { row: LandlordTenantRow }) {
  return (
    <li className="space-y-2 rounded-lg border bg-card px-3 py-2.5 text-sm" data-testid="tenant-card">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="min-w-0">
          <p className="break-words font-semibold leading-tight">{row.tenant_name}</p>
          {row.tenant_phone ? <CallButtons phone={row.tenant_phone} name={row.tenant_name} /> : <p className="text-xs text-muted-foreground">No phone on file</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium" title="Rent Plan status">{planStatusLabel(row.plan_status)}</Badge>
          <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px] font-semibold', fundingStageClass(row.funding_stage))} title="Funding stage">
            {row.funding_stage}
          </Badge>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        <Figure label="Rent" value={formatUgx(row.rent_amount)} />
        <Figure label="Daily" value={formatUgx(row.daily_repayment)} />
        <Figure label="Repaid so far" value={formatUgx(row.amount_repaid)} />
        <Figure label="Balance left" value={formatUgx(row.balance_left)} strong />
      </dl>

      <div className="border-t pt-2 text-xs">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent</p>
        {row.assigned_agent_name || row.assigned_agent_phone ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="font-medium">{row.assigned_agent_name || 'Unnamed agent'}</span>
            {row.assigned_agent_phone && <CallButtons phone={row.assigned_agent_phone} name={row.assigned_agent_name || 'Agent'} />}
          </div>
        ) : (
          <span className="text-muted-foreground">No agent on this Rent Plan</span>
        )}
      </div>
    </li>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}

/** The number with a call button and a WhatsApp button. */
function CallButtons({ phone, name }: { phone: string; name: string }) {
  const intl = toInternationalPhone(phone);
  return (
    <div className="flex items-center gap-1.5">
      <a href={`tel:${intl}`} className="inline-flex min-h-[28px] items-center gap-1 text-xs font-medium text-primary hover:underline" aria-label={`Call ${name} on ${phone}`}>
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/10"><Phone className="h-3.5 w-3.5" /></span>
        {phone}
      </a>
      <a
        href={`https://wa.me/${intl.replace('+', '')}?text=${encodeURIComponent(`Hello ${name}, this is Welile Operations.`)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 w-7 min-h-[28px] min-w-[28px] items-center justify-center rounded-full bg-[#25D366]/20 text-[#25D366] transition-colors hover:bg-[#25D366]/30"
        title="WhatsApp"
        aria-label={`WhatsApp ${name}`}
      >
        <MessageCircle className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
