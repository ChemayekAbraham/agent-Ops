import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2, Search, Plus, Trash2, Users, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';

/**
 * One row in the breakdown: which tenant (and a denormalised label so we
 * don't need a join on the Financial Ops side) and how much of the bulk
 * cash drop is being assigned to them.
 */
export interface TenantAllocation {
  tenant_id: string;
  tenant_name: string;
  tenant_phone?: string | null;
  amount: number;
  /**
   * Tenant's monthly rent at the time of allocation (UGX). Used purely
   * client-side to warn agents who allocate more than one month's rent
   * to a single tenant in a single deposit. Optional — may be missing
   * for legacy tenants whose profile has no `monthly_rent` set.
   */
  monthly_rent?: number | null;
  /**
   * Per-row acknowledgement that the agent intentionally allocated more
   * than the tenant's monthly rent. Set when they confirm the override
   * dialog. Persisted in the encoded notes payload so Financial Ops can
   * see the agent explicitly said "yes, this exceeds rent".
   */
  override_headroom?: boolean;
}

interface Props {
  /** Agent (current user) — used to scope the tenant search. */
  agentId: string;
  /** Total UGX the agent says they just deposited under one TID. */
  totalAmount: number;
  /** Controlled list of allocations. */
  allocations: TenantAllocation[];
  onChange: (next: TenantAllocation[]) => void;
}

interface TenantOption {
  id: string;
  full_name: string;
  phone: string | null;
  monthly_rent?: number | null;
  /** When the tenant's profile (and therefore monthly_rent) was last updated.
   *  Surfaced in the per-row provenance tooltip so the agent can tell whether
   *  the rent figure they're seeing is fresh or stale. */
  monthly_rent_updated_at?: string | null;
}

/**
 * Step-3 add-on for agents depositing field-collected cash as Operational
 * Float. The agent dropped a single lump sum at the merchant code (one TID),
 * so we capture *which tenants* that cash actually came from and *how much*
 * each one paid. The breakdown is encoded into the deposit_requests.notes
 * field as a [ALLOCATIONS] JSON tail and rendered in Financial Ops at
 * approval time.
 *
 * Pure presentation — no DB writes here, parent owns submission.
 */
export default function OperationalFloatTenantAllocator({
  agentId,
  totalAmount,
  allocations,
  onChange,
}: Props) {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  // Load the agent's known tenant universe once. We union three sources
  // because over the platform's history agents have been linked to tenants
  // via different paths:
  //   1. profiles.referrer_id          (modern onboarding stamp)
  //   2. referrals table               (legacy tenants)
  //   3. rent_requests.agent_id        (tenants the agent posted requests for)
  // De-dup by id and we have a clean picker list.
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [referredRes, referralRes, rentReqRes] = await Promise.all([
          supabase
            .from('profiles')
            .select('id, full_name, phone, monthly_rent, updated_at')
            .eq('referrer_id', agentId)
            .order('created_at', { ascending: false })
            .limit(200),
          supabase
            .from('referrals')
            .select('referred_id')
            .eq('referrer_id', agentId)
            .limit(200),
          supabase
            .from('rent_requests')
            .select('tenant_id')
            .eq('agent_id', agentId)
            .limit(200),
        ]);

        const direct = ((referredRes.data || []) as any[]).map((t) => ({
          id: t.id,
          full_name: t.full_name,
          phone: t.phone,
          monthly_rent: t.monthly_rent,
          monthly_rent_updated_at: t.updated_at,
        })) as TenantOption[];
        const directIds = new Set(direct.map((t) => t.id));

        const extraIds = [
          ...((referralRes.data || []).map((r: any) => r.referred_id)),
          ...((rentReqRes.data || []).map((r: any) => r.tenant_id)),
        ].filter((id): id is string => !!id && !directIds.has(id));

        let extras: TenantOption[] = [];
        if (extraIds.length > 0) {
          const unique = [...new Set(extraIds)];
          const { data } = await supabase
            .from('profiles')
            .select('id, full_name, phone, monthly_rent, updated_at')
            .in('id', unique);
          extras = ((data || []) as any[]).map((t) => ({
            id: t.id,
            full_name: t.full_name,
            phone: t.phone,
            monthly_rent: t.monthly_rent,
            monthly_rent_updated_at: t.updated_at,
          })) as TenantOption[];
        }

        if (!cancelled) setTenants([...direct, ...extras]);
      } catch (err) {
        console.error('[Allocator] tenant load failed', err);
        if (!cancelled) toast.error('Could not load your tenants');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const allocatedTotal = useMemo(
    () => allocations.reduce((sum, a) => sum + (Number.isFinite(a.amount) ? a.amount : 0), 0),
    [allocations],
  );
  const remaining = (totalAmount || 0) - allocatedTotal;
  // Tolerate sub-shilling float drift (no fractional UGX in the wild anyway).
  const isBalanced = Math.abs(remaining) < 1;
  const isOverAllocated = remaining < -0.5;

  const selectedIds = useMemo(() => new Set(allocations.map((a) => a.tenant_id)), [allocations]);

  /** Quick lookup so each allocation row can find its source tenant
   *  metadata (rent value + last-updated timestamp) for the provenance
   *  tooltip. Allocations restored from `notes` won't be in `tenants`,
   *  so the tooltip degrades gracefully. */
  const tenantById = useMemo(() => {
    const m = new Map<string, TenantOption>();
    for (const t of tenants) m.set(t.id, t);
    return m;
  }, [tenants]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = tenants.filter((t) => !selectedIds.has(t.id));
    if (!q) return pool.slice(0, 30);
    return pool
      .filter(
        (t) =>
          t.full_name?.toLowerCase().includes(q) ||
          (t.phone || '').toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [tenants, selectedIds, search]);

  const addTenant = (t: TenantOption) => {
    // Auto-suggest the tenant's monthly rent if we still have headroom;
    // otherwise leave 0 and let the agent type the actual collected amount.
    const suggest = Math.min(
      Math.max(0, remaining),
      Number(t.monthly_rent || 0),
    );
    onChange([
      ...allocations,
      {
        tenant_id: t.id,
        tenant_name: t.full_name,
        tenant_phone: t.phone || null,
        amount: suggest > 0 ? suggest : 0,
        monthly_rent: t.monthly_rent ?? null,
      },
    ]);
    setSearch('');
  };

  const updateAmount = (tenantId: string, raw: string) => {
    const num = parseFloat(raw.replace(/,/g, ''));
    onChange(
      allocations.map((a) =>
        a.tenant_id === tenantId
          ? {
              ...a,
              amount: Number.isFinite(num) && num >= 0 ? num : 0,
              // Any edit invalidates a previous override — the agent
              // must reconfirm if they push back over headroom.
              override_headroom: false,
            }
          : a,
      ),
    );
  };

  const removeTenant = (tenantId: string) => {
    onChange(allocations.filter((a) => a.tenant_id !== tenantId));
  };

  const distributeRemaining = () => {
    if (allocations.length === 0 || remaining === 0) return;
    // Drop the entire remainder onto the last row — simplest mental model
    // for an agent who's reconciling "what's left".
    const next = [...allocations];
    const last = next[next.length - 1];
    next[next.length - 1] = {
      ...last,
      amount: Math.max(0, last.amount + remaining),
      override_headroom: false,
    };
    onChange(next);
  };

  /**
   * Split the remaining UGX across all selected tenants, weighted by
   * each tenant's suggested amount (their monthly_rent). If no tenant
   * has a monthly_rent on file we fall back to an equal split. Rounds
   * to whole UGX and dumps any rounding remainder onto the last row so
   * allocatedTotal lands exactly on totalAmount (keeping the ≤1 UGX
   * backend tolerance happy).
   */
  const autoAllocateRemaining = () => {
    if (allocations.length === 0 || remaining <= 0) return;
    const weights = allocations.map((a) => Math.max(0, Number(a.monthly_rent || 0)));
    const weightSum = weights.reduce((acc, w) => acc + w, 0);
    // Equal-split fallback when none of the selected tenants has a rent
    // figure to weight against.
    const useEqual = weightSum <= 0;
    const shares = allocations.map((_, i) => {
      const share = useEqual
        ? remaining / allocations.length
        : (remaining * weights[i]) / weightSum;
      return Math.floor(share); // round down to whole UGX, fix drift below
    });
    const distributed = shares.reduce((acc, s) => acc + s, 0);
    const drift = Math.round(remaining) - distributed;
    if (drift !== 0) shares[shares.length - 1] += drift;

    onChange(
      allocations.map((a, i) => ({
        ...a,
        amount: Math.max(0, a.amount + shares[i]),
        // New money on the row → require re-confirmation if it now
        // breaches the per-tenant rent headroom.
        override_headroom: false,
      })),
    );
  };

  /**
   * Pure-function preview of `autoAllocateRemaining` — produces the same
   * shares the click handler would, but without mutating state. Drives
   * the small "Preview" panel under the Auto-allocate button so the
   * agent can see exactly what each tenant will receive (and confirm the
   * total matches the deposit) before committing.
   */
  const autoAllocatePreview = useMemo(() => {
    if (allocations.length === 0 || remaining <= 0) return null;
    const weights = allocations.map((a) => Math.max(0, Number(a.monthly_rent || 0)));
    const weightSum = weights.reduce((acc, w) => acc + w, 0);
    const useEqual = weightSum <= 0;
    const shares = allocations.map((_, i) => {
      const share = useEqual
        ? remaining / allocations.length
        : (remaining * weights[i]) / weightSum;
      return Math.floor(share);
    });
    const distributed = shares.reduce((acc, s) => acc + s, 0);
    const drift = Math.round(remaining) - distributed;
    if (drift !== 0) shares[shares.length - 1] += drift;

    const rows = allocations.map((a, i) => ({
      tenant_id: a.tenant_id,
      tenant_name: a.tenant_name,
      currentAmount: a.amount,
      addAmount: shares[i],
      finalAmount: Math.max(0, a.amount + shares[i]),
    }));
    const projectedTotal = rows.reduce((s, r) => s + r.finalAmount, 0);
    return {
      rows,
      projectedTotal,
      strategy: useEqual ? ('equal' as const) : ('rent_weighted' as const),
      matchesDeposit: Math.abs(projectedTotal - (totalAmount || 0)) < 1,
    };
  }, [allocations, remaining, totalAmount]);

  /**
   * Per-row headroom check. We only flag rows where:
   *   - we actually know the tenant's monthly rent ( > 0 ), AND
   *   - the allocated amount strictly exceeds that rent.
   * Tenants with no `monthly_rent` on file are silently allowed (we
   * don't have ground truth to warn against).
   */
  const headroomFor = (a: TenantAllocation) => {
    const rent = Number(a.monthly_rent || 0);
    if (!rent) return { exceeds: false, rent: 0, over: 0 };
    const over = a.amount - rent;
    return { exceeds: over > 0.5, rent, over };
  };

  const confirmOverride = (a: TenantAllocation, info: { rent: number; over: number }) => {
    const ok = window.confirm(
      `Heads up — you've allocated UGX ${a.amount.toLocaleString()} to ${a.tenant_name}, ` +
        `which is UGX ${Math.round(info.over).toLocaleString()} more than their monthly rent ` +
        `of UGX ${info.rent.toLocaleString()}.\n\n` +
        `Continue anyway? Financial Ops will see this was confirmed.`,
    );
    if (!ok) return;
    onChange(
      allocations.map((row) =>
        row.tenant_id === a.tenant_id ? { ...row, override_headroom: true } : row,
      ),
    );
  };

  const headroomBreaches = allocations
    .map((a) => ({ a, info: headroomFor(a) }))
    .filter((row) => row.info.exceeds && !row.a.override_headroom);

  return (
    <div className="space-y-3 rounded-xl border-2 border-primary/20 bg-primary/5 p-3">
      <div className="flex items-start gap-2">
        <Users className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-xs font-semibold">Break down per tenant</p>
          <p className="text-[10px] text-muted-foreground">
            One TID, many tenants. Tag each tenant whose rent is inside this drop so Financial Ops can credit them correctly.
          </p>
        </div>
      </div>

      {/* Selected tenant rows */}
      {allocations.length > 0 && (
        <div className="space-y-1.5">
          {allocations.map((a) => {
            const info = headroomFor(a);
            const flagged = info.exceeds && !a.override_headroom;
            const overridden = info.exceeds && a.override_headroom;
            return (
              <div
                key={a.tenant_id}
                className={`rounded-lg bg-background border p-2 transition-colors ${
                  flagged
                    ? 'border-warning/60 bg-warning/5'
                    : overridden
                      ? 'border-warning/30'
                      : 'border-border'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <p className="text-xs font-medium truncate">{a.tenant_name}</p>
                      <RentSourceTooltip
                        rent={a.monthly_rent ?? tenantById.get(a.tenant_id)?.monthly_rent ?? null}
                        updatedAt={tenantById.get(a.tenant_id)?.monthly_rent_updated_at ?? null}
                      />
                    </div>
                    {a.tenant_phone && (
                      <p className="text-[10px] text-muted-foreground truncate">{a.tenant_phone}</p>
                    )}
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={a.amount || ''}
                    placeholder="0"
                    onChange={(e) => updateAmount(a.tenant_id, e.target.value)}
                    className={`h-8 w-28 text-right font-mono text-xs ${
                      flagged ? 'border-warning focus-visible:ring-warning' : ''
                    }`}
                    aria-label={`Amount for ${a.tenant_name}`}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${a.tenant_name}`}
                    onClick={() => removeTenant(a.tenant_id)}
                    className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {flagged && (
                  <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md bg-warning/10 border border-warning/30 px-2 py-1">
                    <div className="flex items-start gap-1.5 min-w-0">
                      <AlertCircle className="h-3 w-3 text-warning shrink-0 mt-0.5" />
                      <p className="text-[10px] text-warning-foreground leading-tight">
                        Exceeds rent by UGX {Math.round(info.over).toLocaleString()} (rent UGX {info.rent.toLocaleString()}).
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => confirmOverride(a, info)}
                      className="h-6 px-2 text-[10px] text-warning hover:text-warning shrink-0"
                    >
                      Override
                    </Button>
                  </div>
                )}
                {overridden && (
                  <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground italic">
                    <CheckCircle2 className="h-3 w-3 text-warning" />
                    Over-rent override confirmed
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Search & add */}
      <div className="space-y-1.5">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Add tenant
        </Label>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={loading ? 'Loading your tenants…' : 'Search by name or phone'}
            className="h-9 pl-7 text-xs"
            disabled={loading}
          />
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-3 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic px-1">
            {search.trim()
              ? 'No tenants match.'
              : tenants.length === 0
                ? 'You have no tenants linked yet.'
                : 'All tenants already added.'}
          </p>
        ) : (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background divide-y divide-border">
            {filtered.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => addTenant(t)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/60 transition-colors"
              >
                <Plus className="h-3 w-3 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{t.full_name}</p>
                  {t.phone && (
                    <p className="text-[10px] text-muted-foreground truncate">{t.phone}</p>
                  )}
                </div>
                {t.monthly_rent ? (
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      rent {Number(t.monthly_rent).toLocaleString()}
                    </span>
                    <RentSourceTooltip
                      rent={t.monthly_rent}
                      updatedAt={t.monthly_rent_updated_at}
                    />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Reconciliation strip */}
      <div className="rounded-lg bg-background border border-border p-2 space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Allocated</span>
          <span className="font-mono font-semibold tabular-nums">
            UGX {allocatedTotal.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Deposit total</span>
          <span className="font-mono tabular-nums">
            UGX {(totalAmount || 0).toLocaleString()}
          </span>
        </div>
        <div
          className={`flex items-center justify-between text-xs font-semibold pt-1 border-t ${
            isBalanced
              ? 'text-emerald-600 border-emerald-500/30'
              : isOverAllocated
                ? 'text-destructive border-destructive/30'
                : 'text-warning border-warning/30'
          }`}
        >
          <span className="flex items-center gap-1">
            {isBalanced ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <AlertCircle className="h-3 w-3" />
            )}
            {isBalanced
              ? 'Balanced'
              : isOverAllocated
                ? 'Over by'
                : 'Remaining'}
          </span>
          <span className="font-mono tabular-nums">
            UGX {Math.abs(remaining).toLocaleString()}
          </span>
        </div>
        {!isBalanced && allocations.length > 0 && !isOverAllocated && (
          <div className="grid grid-cols-2 gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={autoAllocateRemaining}
              className="h-6 text-[10px] text-primary hover:text-primary"
              title="Split the remaining amount across selected tenants, weighted by their monthly rent"
            >
              Auto-allocate remaining
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={distributeRemaining}
              className="h-6 text-[10px] text-muted-foreground hover:text-primary"
            >
              Add to last tenant
            </Button>
          </div>
        )}
        {/* Preview: shows exactly what each tenant will receive after the
            agent taps "Auto-allocate remaining", and confirms the projected
            total lands on the deposit amount. Hidden when there's nothing
            to distribute or the form isn't already showing the buttons. */}
        {autoAllocatePreview && !isBalanced && !isOverAllocated && (
          <div className="mt-1 rounded-md border border-primary/20 bg-primary/5 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-primary uppercase tracking-wide">
                Auto-allocate preview
              </p>
              <span className="text-[9px] text-muted-foreground">
                {autoAllocatePreview.strategy === 'rent_weighted'
                  ? 'weighted by monthly rent'
                  : 'split equally'}
              </span>
            </div>
            <ul className="space-y-0.5">
              {autoAllocatePreview.rows.map((r) => (
                <li
                  key={r.tenant_id}
                  className="flex items-center justify-between text-[11px] gap-2"
                >
                  <span className="truncate text-foreground/90">{r.tenant_name}</span>
                  <span className="font-mono tabular-nums whitespace-nowrap">
                    {r.currentAmount > 0 && (
                      <span className="text-muted-foreground">
                        {r.currentAmount.toLocaleString()}
                        <span className="mx-0.5">+</span>
                      </span>
                    )}
                    <span className="text-primary font-medium">
                      {r.addAmount.toLocaleString()}
                    </span>
                    <span className="text-muted-foreground"> = </span>
                    <span className="font-semibold text-foreground">
                      {r.finalAmount.toLocaleString()}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div
              className={`flex items-center justify-between text-[11px] pt-1 border-t ${
                autoAllocatePreview.matchesDeposit
                  ? 'text-emerald-600 border-emerald-500/30'
                  : 'text-warning border-warning/30'
              }`}
            >
              <span className="flex items-center gap-1 font-medium">
                {autoAllocatePreview.matchesDeposit ? (
                  <>
                    <CheckCircle2 className="h-3 w-3" />
                    Matches deposit total
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-3 w-3" />
                    Doesn't match deposit
                  </>
                )}
              </span>
              <span className="font-mono tabular-nums">
                UGX {autoAllocatePreview.projectedTotal.toLocaleString()} / {(totalAmount || 0).toLocaleString()}
              </span>
            </div>
          </div>
        )}
        {headroomBreaches.length > 0 && (
          <div className="flex items-start gap-1.5 rounded-md bg-warning/10 border border-warning/30 px-2 py-1 mt-1">
            <AlertCircle className="h-3 w-3 text-warning shrink-0 mt-0.5" />
            <p className="text-[10px] text-warning-foreground leading-tight">
              {headroomBreaches.length} tenant{headroomBreaches.length === 1 ? '' : 's'} allocated above their monthly rent. Tap <span className="font-semibold">Override</span> on each row to confirm.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Helpers to (de)serialise allocations into the deposit_requests.notes
 * column. We use a clearly-fenced suffix so legacy free-text notes still
 * survive a round-trip and Financial Ops can detect/parse the structured
 * payload reliably.
 */
const ALLOCATIONS_PREFIX = '[ALLOCATIONS]';

export function encodeAllocationsNote(
  baseNote: string,
  allocations: TenantAllocation[],
): string {
  if (!allocations || allocations.length === 0) return baseNote;
  const payload = JSON.stringify(
    allocations.map((a) => ({
      tid: a.tenant_id,
      n: a.tenant_name,
      p: a.tenant_phone || null,
      a: a.amount,
      // Carry the rent snapshot + override decision so a) edit-mode
      // re-hydration doesn't re-warn on already-confirmed rows, and
      // b) Financial Ops can audit "agent confirmed over-rent".
      r: a.monthly_rent ?? null,
      o: a.override_headroom ? 1 : 0,
    })),
  );
  const tail = `${ALLOCATIONS_PREFIX}${payload}`;
  return baseNote ? `${baseNote} | ${tail}` : tail;
}

export function decodeAllocationsFromNote(note: string | null | undefined): {
  cleanNote: string;
  allocations: TenantAllocation[] | null;
} {
  if (!note) return { cleanNote: '', allocations: null };
  const idx = note.indexOf(ALLOCATIONS_PREFIX);
  if (idx === -1) return { cleanNote: note, allocations: null };
  const head = note.slice(0, idx).replace(/\s*\|\s*$/, '').trim();
  const raw = note.slice(idx + ALLOCATIONS_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { cleanNote: head, allocations: null };
    const allocations: TenantAllocation[] = parsed
      .map((row: any) => ({
        tenant_id: String(row?.tid ?? ''),
        tenant_name: String(row?.n ?? 'Unknown tenant'),
        tenant_phone: row?.p ?? null,
        amount: Number(row?.a ?? 0),
        monthly_rent: row?.r != null ? Number(row.r) : null,
        override_headroom: row?.o === 1 || row?.o === true,
      }))
      .filter((a) => a.tenant_id);
    return { cleanNote: head, allocations: allocations.length ? allocations : null };
  } catch {
    return { cleanNote: head, allocations: null };
  }
}

/**
 * Compact info icon that explains where the rent figure on this row came
 * from and when it was last touched. Hover (desktop) or tap (mobile)
 * opens a tooltip — agents who suspect a stale rent value can use this
 * to decide whether to ask Landlord Ops for a refresh before allocating.
 */
function RentSourceTooltip({
  rent,
  updatedAt,
}: {
  rent: number | null | undefined;
  updatedAt: string | null | undefined;
}) {
  const hasRent = rent != null && Number(rent) > 0;
  const updatedLabel = updatedAt
    ? format(new Date(updatedAt), 'd MMM yyyy')
    : 'Unknown';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Where does this rent value come from?"
          className="shrink-0 inline-flex items-center justify-center h-4 w-4 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          // Stop the click from bubbling into any parent button (e.g. the
          // picker's "add tenant" row).
          onClick={(e) => e.stopPropagation()}
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs">
        <p className="font-semibold mb-1">Monthly rent source</p>
        {hasRent ? (
          <>
            <p className="text-muted-foreground">
              From the tenant's profile (<code className="text-[10px]">monthly_rent</code>),
              kept up to date by Landlord Ops when their rent plan changes.
            </p>
            <p className="mt-1.5">
              <span className="text-muted-foreground">Last updated:</span>{' '}
              <span className="font-medium">{updatedLabel}</span>
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            No monthly rent on file for this tenant. Ask Landlord Ops to set
            it on the tenant's profile so future allocations are validated.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}