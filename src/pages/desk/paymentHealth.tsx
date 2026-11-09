import { useQuery } from '@tanstack/react-query';
import type { Status } from './deskTheme';
import { LABEL, PANEL } from './deskTheme';
import { fmt } from './format';
import { rpc } from './reviewApi';
import { Chip, ErrorLine, LoadingRows, stackLayout } from './ui';

/**
 * How a tenant has paid on earlier and current Rent Plans, from
 * `tenant_payment_health_many(p_tenant_ids)` — one call per board load, keyed
 * by tenant id. The drawer asks for its one tenant through the same RPC.
 */

export type HealthStatus = 'good' | 'watch' | 'poor' | 'new';

export type TenantHealth = {
  status: HealthStatus;
  summary: string | null;
  completed_plans: number | null;
  /** Whole percentage, 0-100, repaid on completed plans. */
  completed_repaid_pct: number | null;
  active_plans: number | null;
  /** Whole percentage, 0-100, of what is due so far on active plans. */
  active_collected_pct: number | null;
  owing: number | null;
};

export type HealthMap = Record<string, TenantHealth>;

const HEALTH: Record<HealthStatus, { text: string; tone: Status }> = {
  good: { text: 'Good', tone: 'ok' },
  watch: { text: 'Watch', tone: 'warn' },
  poor: { text: 'Poor', tone: 'bad' },
  new: { text: 'New', tone: 'idle' },
};

/** The chip for a tenant: Good green, Watch amber, Poor red, New grey; the summary on hover. */
export function healthChip(h: TenantHealth | null | undefined): { text: string; tone: Status; title: string | undefined } | null {
  if (!h) return null;
  const s = HEALTH[h.status] ?? HEALTH.new;
  return { text: `Payment: ${s.text}`, tone: s.tone, title: h.summary ?? undefined };
}

/** Unique, non-empty ids in a stable order, so one board load is one query. */
export const idsKey = (ids: (string | null | undefined)[]) => Array.from(new Set(ids.filter((x): x is string => !!x))).sort();

export function useTenantHealthMany(tenantIds: (string | null | undefined)[], enabled = true) {
  const ids = idsKey(tenantIds);
  return useQuery({
    queryKey: ['desk-feed', 'tenant-health', ids.join(',')],
    enabled: enabled && ids.length > 0,
    queryFn: async (): Promise<HealthMap> => {
      const { data, error } = await rpc('tenant_payment_health_many', { p_tenant_ids: ids });
      if (error) throw error;
      return (data ?? {}) as HealthMap;
    },
    staleTime: 60_000,
    retry: 1,
  });
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(Number(v))}%`);

/** The drawer's "Payment health" panel. */
export function PaymentHealthPanel({ tenantId }: { tenantId: string | null }) {
  const q = useTenantHealthMany([tenantId]);
  const h = tenantId ? q.data?.[tenantId] : undefined;
  const chip = healthChip(h);
  return (
    <section className={`${PANEL} p-4`} style={stackLayout(8)} aria-label="Payment health">
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        Payment health
      </h3>
      {!tenantId ? (
        <p className="text-sm text-muted-foreground">No tenant on this request.</p>
      ) : q.isLoading ? (
        <LoadingRows rows={2} height={20} label="Loading payment health" />
      ) : q.error ? (
        <ErrorLine>Payment health could not load: {(q.error as { message?: string }).message}</ErrorLine>
      ) : !h || !chip ? (
        <p className="text-sm text-muted-foreground">No payment record for this tenant yet.</p>
      ) : (
        <>
          <div>
            <Chip size="sm" tone={chip.tone} title={chip.title}>
              {chip.text}
            </Chip>
          </div>
          {h.summary && <p className="text-sm text-foreground">{h.summary}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
            <dt className={LABEL}>Completed plans</dt>
            <dd className="tabular-nums text-foreground">
              {fmt('int', h.completed_plans)} · {pct(h.completed_repaid_pct)} repaid
            </dd>
            <dt className={LABEL}>Active plans</dt>
            <dd className="tabular-nums text-foreground">
              {fmt('int', h.active_plans)} · {pct(h.active_collected_pct)} of due paid
            </dd>
            <dt className={LABEL}>Owing</dt>
            <dd className="tabular-nums text-foreground">UGX {fmt('ugxfull', h.owing ?? 0)}</dd>
          </dl>
        </>
      )}
    </section>
  );
}
