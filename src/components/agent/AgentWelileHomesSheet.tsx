import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { Home, Loader2, Plus, Banknote, TrendingUp, Users, Clock, Search, CheckCircle2, ShieldCheck, RefreshCw, ArrowLeft, ArrowRight, Pencil, History, Trash2, ChevronDown, Building2, UserCheck, UserPlus } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { z } from 'zod';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';

// Shared client-side validation for the core enrollment fields. Kept strict so
// agents cannot submit invalid or internally conflicting values (e.g. decimal
// rent, out-of-range payout days, or a payout day that isn't a real calendar
// day for every month).
const RENT_MIN = 10_000;
const RENT_MAX = 100_000_000;

const enrollmentCoreSchema = z.object({
  monthlyRent: z
    .number({ error: 'Enter the monthly rent as a number' })
    .refine((n) => Number.isFinite(n), { message: 'Enter a valid monthly rent' })
    .refine((n) => Number.isInteger(n), { message: 'Monthly rent must be a whole number (no decimals)' })
    .refine((n) => n >= RENT_MIN, { message: `Monthly rent must be at least ${formatUGX(RENT_MIN)}` })
    .refine((n) => n <= RENT_MAX, { message: `Monthly rent cannot exceed ${formatUGX(RENT_MAX)}` }),
  payoutDay: z
    .number({ error: 'Enter the landlord payout day as a number' })
    .refine((n) => Number.isInteger(n), { message: 'Payout day must be a whole number' })
    .refine((n) => n >= 1 && n <= 28, { message: 'Payout day must be between 1 and 28' }),
  hasSmartphone: z.boolean({ error: 'Choose a collection mode' }),
});

type EnrollmentCoreInput = { rent: string; payoutDay: string; hasSmartphone: unknown };

/** Returns the first validation error message, or null when the core fields are valid. */
function validateEnrollmentCore({ rent, payoutDay, hasSmartphone }: EnrollmentCoreInput): string | null {
  const rentTrimmed = rent.trim();
  const dayTrimmed = payoutDay.trim();
  if (!rentTrimmed) return 'Enter the monthly rent';
  if (!dayTrimmed) return 'Enter the landlord payout day';
  const parsed = enrollmentCoreSchema.safeParse({
    monthlyRent: Number(rentTrimmed),
    payoutDay: Number(dayTrimmed),
    hasSmartphone: typeof hasSmartphone === 'boolean' ? hasSmartphone : undefined,
  });
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Some values are invalid';
  return null;
}

interface WHSubscription {
  id: string;
  tenant_id: string;
  monthly_rent: number;
  outstanding_balance: number;
  receivable_total: number;
  has_smartphone: boolean;
  landlord_uses_wallet: boolean;
  payout_day: number;
  next_due_date: string | null;
  landlord_name: string | null;
  landlord_phone?: string | null;
  created_at?: string;
  tenant_name?: string;
  tenant_phone?: string;
  tenant_verified?: boolean;
  tenant_last_active?: string | null;
  newly_created?: boolean;
}

type EnrollStatus = {
  label: string;
  ready: boolean;
  className: string;
};

interface EnrollmentAuditRow {
  id: string;
  edited_by: string;
  changes: { field: string; old: any; new: any }[];
  months_adjusted: number;
  created_at: string;
  editor_name?: string;
}

interface RecentRentPayment {
  id: string;
  period_month: string;
  amount: number;
  created_at: string;
  tenant_name: string;
}

interface TenantDueRow {
  id: string;
  period_month: string;
  amount_due: number;
  amount_collected: number;
  collection_status: string;
  payout_status: string;
  updated_at: string;
}

/** Collapsible per-tenant payment history, loaded on first expand. */
function TenantPaymentHistory({ subscriptionId }: { subscriptionId: string }) {
  const [rows, setRows] = useState<TenantDueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('welile_homes_monthly_dues')
        .select('id, period_month, amount_due, amount_collected, collection_status, payout_status, updated_at')
        .eq('subscription_id', subscriptionId)
        .order('period_month', { ascending: true });
      if (!active) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as TenantDueRow[]);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [subscriptionId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading payment history…
      </div>
    );
  }
  if (error) {
    return <p className="py-2 text-xs text-destructive">{error}</p>;
  }

  const paid = (rows ?? []).filter((r) => Number(r.amount_collected) > 0);
  if (paid.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">No payments recorded for this tenant yet.</p>;
  }

  const total = paid.reduce((a, r) => a + Number(r.amount_collected || 0), 0);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <span>{paid.length} payment{paid.length === 1 ? '' : 's'}</span>
        <span className="font-semibold text-foreground">{formatUGX(total)}</span>
      </div>
      <ul className="divide-y divide-border/50">
        {paid.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-2.5 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">
                {new Date(r.period_month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} rent
              </p>
              <p className="text-[10px] text-muted-foreground">
                {new Date(r.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                {Number(r.amount_collected) < Number(r.amount_due) ? ' · partial' : ''}
                {r.payout_status !== 'unpaid' ? ' · landlord paid' : ''}
              </p>
            </div>
            <span className="shrink-0 text-xs font-semibold tabular-nums text-emerald-600">
              {formatUGX(Number(r.amount_collected))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type PreviewDelta<T> = { old: T; new: T };
interface EditPreview {
  success: boolean;
  error?: string;
  changes: { field: string; old: any; new: any }[];
  months_adjusted: number;
  monthly_rent: PreviewDelta<number>;
  payout_day: PreviewDelta<number>;
  has_smartphone: PreviewDelta<boolean>;
  agent_commission_per_month: PreviewDelta<number>;
  landlord_net_per_month: PreviewDelta<number>;
  receivable_total: PreviewDelta<number>;
  outstanding_balance: PreviewDelta<number>;
  next_due_date: PreviewDelta<string | null>;
}

const FIELD_LABELS: Record<string, string> = {
  monthly_rent: 'Monthly rent',
  payout_day: 'Payout day',
  has_smartphone: 'Smartphone mode',
};

function formatAuditValue(field: string, value: any): string {
  if (value === null || value === undefined) return '—';
  if (field === 'monthly_rent') return formatUGX(Number(value));
  if (field === 'has_smartphone') return value ? 'Tenant pays' : 'Agent allocates';
  return String(value);
}

// Derive an enrollment verification / readiness status for the agent's list.
function getEnrollStatus(s: WHSubscription): EnrollStatus {
  if (s.tenant_verified) {
    return { label: 'Verified', ready: true, className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' };
  }
  return { label: 'Unverified', ready: false, className: 'border-amber-500/40 bg-amber-500/10 text-amber-600' };
}

interface AgentWelileHomesSheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isPage?: boolean;
}

export function AgentWelileHomesSheet({ open = false, onOpenChange, isPage = false }: AgentWelileHomesSheetProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [subs, setSubs] = useState<WHSubscription[]>([]);
  const [earned, setEarned] = useState(0);
  const [pendingPayouts, setPendingPayouts] = useState(0);
  const [recentPayments, setRecentPayments] = useState<RecentRentPayment[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollInitialMode, setEnrollInitialMode] = useState<'choose' | 'register'>('choose');

  const handleOpenEnroll = (mode: 'choose' | 'register' = 'choose') => {
    setEnrollInitialMode(mode);
    setEnrollOpen(true);
  };
  const [allocFor, setAllocFor] = useState<WHSubscription | null>(null);
  const [editFor, setEditFor] = useState<WHSubscription | null>(null);
  const [verifyFor, setVerifyFor] = useState<WHSubscription | null>(null);
  const [deleteFor, setDeleteFor] = useState<WHSubscription | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);

  // Grouping and multi-landlord float selection
  const [selectedTenantIds, setSelectedTenantIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [requestFloatOpen, setRequestFloatOpen] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data: rows, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, monthly_rent, outstanding_balance, receivable_total, has_smartphone, landlord_uses_wallet, payout_day, next_due_date, landlord_name, landlord_phone, created_at')
        .or(`agent_id.eq.${user.id},enrolled_by.eq.${user.id}`)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const list = (rows ?? []) as WHSubscription[];
      const tenantIds = list.map((s) => s.tenant_id);
      if (tenantIds.length) {
        const { data: profs } = await supabase
          .from('profiles').select('id, full_name, phone, verified, last_active_at, created_at').in('id', tenantIds);
        const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
        list.forEach((s) => {
          const p = map.get(s.tenant_id);
          s.tenant_name = p?.full_name ?? 'Tenant';
          s.tenant_phone = p?.phone ?? '';
          s.tenant_verified = !!p?.verified;
          s.tenant_last_active = p?.last_active_at ?? null;
          // "Newly created" = the tenant profile was created at (≈) enrollment time.
          s.newly_created = !!(p?.created_at && s.created_at &&
            Math.abs(new Date(p.created_at).getTime() - new Date(s.created_at).getTime()) < 5 * 60 * 1000);
        });
      }
      setSubs(list);

      // Agent 2% earnings + pending landlord payouts
      const { data: dues } = await supabase
        .from('welile_homes_monthly_dues')
        .select('agent_commission, collection_status, payout_status, landlord_net')
        .eq('agent_id', user.id);
      let e = 0, p = 0;
      (dues ?? []).forEach((d: any) => {
        if (d.collection_status === 'collected') e += Number(d.agent_commission) || 0;
        if (d.collection_status === 'collected' && d.payout_status === 'unpaid') p += Number(d.landlord_net) || 0;
      });
      setEarned(e);
      setPendingPayouts(p);

      // Recent rent payments (collected dues) with their month
      const { data: paid } = await supabase
        .from('welile_homes_monthly_dues')
        .select('id, tenant_id, period_month, amount_collected, amount_due, updated_at')
        .eq('agent_id', user.id)
        .eq('collection_status', 'collected')
        .order('updated_at', { ascending: false })
        .limit(10);
      const nameById = new Map(list.map((s) => [s.tenant_id, s.tenant_name ?? 'Tenant']));
      setRecentPayments((paid ?? []).map((d: any) => ({
        id: d.id,
        period_month: d.period_month,
        amount: Number(d.amount_collected) || Number(d.amount_due) || 0,
        created_at: d.updated_at,
        tenant_name: nameById.get(d.tenant_id) ?? 'Tenant',
      })));
    } catch (err: any) {
      toast({ title: 'Failed to load Welile Homes', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => { if (open || isPage) load(); }, [open, isPage, load]);

  const [receivablePeriod, setReceivablePeriod] = useState<'monthly' | 'yearly'>('yearly');
  const [searchOpen, setSearchOpen] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const visibleSubs = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    if (!q) return subs;
    return subs.filter((s) =>
      (s.tenant_name ?? '').toLowerCase().includes(q) ||
      (s.tenant_phone ?? '').toLowerCase().includes(q) ||
      (s.landlord_name ?? '').toLowerCase().includes(q),
    );
  }, [subs, listQuery]);

  // Group visible subscriptions by landlord
  const landlordGroups = useMemo<Array<{
    key: string;
    name: string;
    phone: string;
    tenants: WHSubscription[];
    totalRent: number;
    totalOutstanding: number;
  }>>(() => {
    const map = new Map<string, {
      key: string;
      name: string;
      phone: string;
      tenants: WHSubscription[];
      totalRent: number;
      totalOutstanding: number;
    }>();

    visibleSubs.forEach((s) => {
      const name = (s.landlord_name || '').trim() || 'Unassigned Landlord';
      const phone = (s.landlord_phone || '').trim();
      const key = `${name.toLowerCase()}|${phone}`;
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          name,
          phone,
          tenants: [],
          totalRent: 0,
          totalOutstanding: 0,
        };
        map.set(key, group);
      }
      group.tenants.push(s);
      group.totalRent += Number(s.monthly_rent) || 0;
      group.totalOutstanding += Number(s.outstanding_balance) || 0;
    });

    return Array.from(map.values());
  }, [visibleSubs]);

  const toggleTenant = (tenantId: string) => {
    setSelectedTenantIds((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  };

  const isLandlordAllSelected = (group: { tenants: WHSubscription[] }) => {
    return group.tenants.length > 0 && group.tenants.every((t) => selectedTenantIds.has(t.id));
  };

  const isLandlordPartiallySelected = (group: { tenants: WHSubscription[] }) => {
    return group.tenants.some((t) => selectedTenantIds.has(t.id)) && !isLandlordAllSelected(group);
  };

  const toggleLandlord = (group: { tenants: WHSubscription[] }) => {
    setSelectedTenantIds((prev) => {
      const next = new Set(prev);
      const allSelected = group.tenants.every((t) => next.has(t.id));
      if (allSelected) {
        group.tenants.forEach((t) => next.delete(t.id));
      } else {
        group.tenants.forEach((t) => next.add(t.id));
      }
      return next;
    });
  };

  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const selectedTenants = useMemo(
    () => subs.filter((s) => selectedTenantIds.has(s.id)),
    [subs, selectedTenantIds]
  );

  const selectedLandlordNames = useMemo(
    () => Array.from(new Set(selectedTenants.map((s) => s.landlord_name || 'Landlord'))),
    [selectedTenants]
  );

  const totalFloatAmount = useMemo(
    () => selectedTenants.reduce((sum, s) => sum + (Number(s.monthly_rent) || 0), 0),
    [selectedTenants]
  );

  const handleToggleSelectAll = () => {
    if (selectedTenantIds.size === visibleSubs.length && visibleSubs.length > 0) {
      setSelectedTenantIds(new Set());
    } else {
      setSelectedTenantIds(new Set(visibleSubs.map((s) => s.id)));
    }
  };

  const totalReceivable = subs.reduce((a, s) => a + (Number(s.receivable_total) || 0), 0);
  const monthlyReceivable = subs.reduce((a, s) => a + (Number(s.monthly_rent) || 0), 0);
  const pendingConfirmation = subs.filter((s) => !getEnrollStatus(s).ready).length;

  const bodyContent = (
    <div className={cn("space-y-4", !isPage && "p-4")}>
      {/* Stats */}
      <div className="grid grid-cols-2 gap-2.5">
        <Card><CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Enrolled</div>
          <p className="text-xl font-bold">{subs.length}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <Banknote className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Receivable</span>
            </div>
            <div
              role="tablist"
              aria-label="Receivable period"
              className="inline-flex shrink-0 items-center rounded-full bg-muted p-0.5 text-[10px] border border-border/40"
            >
              <button
                type="button"
                role="tab"
                aria-selected={receivablePeriod === 'monthly'}
                onClick={() => setReceivablePeriod('monthly')}
                className={cn(
                  'h-5 px-2 rounded-full font-medium transition-all flex items-center justify-center',
                  receivablePeriod === 'monthly'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                title="Per month receivable"
              >
                M
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={receivablePeriod === 'yearly'}
                onClick={() => setReceivablePeriod('yearly')}
                className={cn(
                  'h-5 px-2 rounded-full font-medium transition-all flex items-center justify-center',
                  receivablePeriod === 'yearly'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                title="Full 12-month receivable"
              >
                Y
              </button>
            </div>
          </div>
          <p className="text-lg font-bold">
            {formatUGX(receivablePeriod === 'monthly' ? monthlyReceivable : totalReceivable)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {receivablePeriod === 'monthly' ? 'Per month' : 'Full 12-month term'}
          </p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Your 2% earned</div>
          <p className="text-lg font-bold text-emerald-600">{formatUGX(earned)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" /> Pending payouts</div>
          <p className="text-lg font-bold text-orange-600">{formatUGX(pendingPayouts)}</p>
        </CardContent></Card>
      </div>

      {/* Recent rent payments */}
      <Card>
        <CardContent className="p-3 space-y-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <History className="h-3.5 w-3.5" /> Recent rent payments
          </div>
          {recentPayments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No rent collected yet.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {recentPayments.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.tenant_name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(p.period_month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} rent
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-emerald-600">{formatUGX(p.amount)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pendingConfirmation > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {pendingConfirmation} {pendingConfirmation === 1 ? 'tenant is' : 'tenants are'} unverified. Tap Verify to send them a verification SMS.
        </div>
      )}

      <Button
        className="w-full gap-2 bg-primary text-primary-foreground font-bold shadow-xs h-10 sm:h-11 rounded-xl text-sm"
        onClick={() => handleOpenEnroll('choose')}
      >
        <UserPlus className="h-4 w-4" /> Add Tenant
      </Button>

      {searchOpen && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            placeholder="Search by landlord, tenant or phone number"
            className="h-9 pl-8 text-sm"
          />
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : subs.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">
          No Welile Homes tenants yet. Enroll a tenant to start earning 2% on their monthly rent.
        </div>
      ) : visibleSubs.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">
          No match for "{listQuery}".
        </div>
      ) : (
        <div className="space-y-3 pb-20">
          {/* Select All Toolbar */}
          <div className="flex items-center justify-between text-xs px-1 text-muted-foreground">
            <span>
              {landlordGroups.length} {landlordGroups.length === 1 ? 'landlord' : 'landlords'} · {visibleSubs.length} {visibleSubs.length === 1 ? 'tenant' : 'tenants'}
            </span>
            <button
              type="button"
              onClick={handleToggleSelectAll}
              className="text-primary hover:underline font-medium"
            >
              {selectedTenantIds.size === visibleSubs.length && visibleSubs.length > 0
                ? 'Deselect all'
                : 'Select all'}
            </button>
          </div>

          {/* Grouped Landlords with Checking Options */}
          {landlordGroups.map((group) => {
            const allSelected = isLandlordAllSelected(group);
            const partialSelected = isLandlordPartiallySelected(group);
            const isCollapsed = collapsedGroups.has(group.key);

            return (
              <div
                key={group.key}
                className="rounded-xl border bg-card overflow-hidden shadow-xs"
              >
                {/* Landlord Group Header with Checkbox */}
                <div className="flex items-center justify-between p-3 bg-muted/40 border-b gap-2.5">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <Checkbox
                      id={`group-${group.key}`}
                      checked={allSelected ? true : partialSelected ? 'indeterminate' : false}
                      onCheckedChange={() => toggleLandlord(group)}
                      aria-label={`Select all tenants for landlord ${group.name}`}
                    />
                    <div
                      className="min-w-0 flex-1 cursor-pointer select-none"
                      onClick={() => toggleGroupCollapsed(group.key)}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-semibold text-sm truncate text-foreground flex items-center gap-1">
                          <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                          {group.name}
                        </p>
                        {group.phone && (
                          <span className="text-[11px] text-muted-foreground">({group.phone})</span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                        <span>{group.tenants.length} {group.tenants.length === 1 ? 'tenant' : 'tenants'}</span>
                        <span>·</span>
                        <span>Total float: <b className="text-foreground">{formatUGX(group.totalRent)}</b></span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="outline" className="text-[11px] font-semibold text-primary border-primary/30 bg-primary/5">
                      {formatUGX(group.totalRent)}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => toggleGroupCollapsed(group.key)}
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''
                          }`}
                      />
                    </Button>
                  </div>
                </div>

                {/* Tenants under this landlord */}
                {!isCollapsed && (
                  <div className="p-2 space-y-2 bg-background/50">
                    {group.tenants.map((s) => {
                      const isSelected = selectedTenantIds.has(s.id);
                      return (
                        <div
                          key={s.id}
                          className={`rounded-lg border p-3 space-y-2 transition-colors ${isSelected ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30' : 'bg-card'
                            }`}
                        >
                          <div className="flex items-start justify-between gap-2.5">
                            <div className="flex items-start gap-2.5 min-w-0 flex-1">
                              <div className="pt-0.5">
                                <Checkbox
                                  id={`tenant-${s.id}`}
                                  checked={isSelected}
                                  onCheckedChange={() => toggleTenant(s.id)}
                                  aria-label={`Select ${s.tenant_name}`}
                                />
                              </div>
                              <button
                                type="button"
                                aria-expanded={historyOpenId === s.id}
                                onClick={() => setHistoryOpenId((id) => (id === s.id ? null : s.id))}
                                className="min-w-0 flex-1 text-left"
                              >
                                <p className="flex items-center gap-1 font-semibold truncate text-sm">
                                  <span className="truncate">{s.tenant_name}</span>
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${historyOpenId === s.id ? 'rotate-180' : ''}`}
                                  />
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {s.tenant_phone}{s.tenant_phone ? ' · ' : ''}Tap for payment history
                                </p>
                              </button>
                            </div>
                            {!s.has_smartphone && <Badge variant="outline" className="shrink-0 text-[10px]">No phone</Badge>}
                          </div>

                          {historyOpenId === s.id && <TenantPaymentHistory subscriptionId={s.id} />}

                          {(() => {
                            const st = getEnrollStatus(s);
                            return (
                              <Badge variant="outline" className={`gap-1 font-normal ${st.className}`}>
                                {st.ready ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                                {st.label}
                              </Badge>
                            );
                          })()}

                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <div><span className="text-muted-foreground">Rent</span><br /><span className="font-semibold">{formatUGX(s.monthly_rent)}</span></div>
                            <div><span className="text-muted-foreground">Outstanding</span><br /><span className="font-semibold text-orange-600">{formatUGX(s.outstanding_balance)}</span></div>
                            <div><span className="text-muted-foreground">Payout day</span><br /><span className="font-semibold">{s.payout_day}</span></div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-1">
                            {!s.tenant_verified && (
                              <Button size="sm" className="gap-1.5 col-span-2 h-8 text-xs"
                                onClick={() => setVerifyFor(s)}>
                                <ShieldCheck className="h-3.5 w-3.5" /> Verify
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs"
                              disabled={s.outstanding_balance <= 0}
                              onClick={() => setAllocFor(s)}>
                              <Banknote className="h-3.5 w-3.5" /> Allocate
                            </Button>
                            <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs text-destructive hover:bg-destructive/10 border-destructive/30"
                              onClick={() => setDeleteFor(s)}>
                              <Trash2 className="h-3.5 w-3.5" /> Delete
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky / Fixed Floating Action Bar for Total Float Request */}
      {selectedTenantIds.size > 0 && (
        <div
          className={cn(
            isPage
              ? "fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur-md border-t p-3 shadow-xl z-30"
              : "sticky bottom-0 -mx-4 -mb-4 bg-background/95 backdrop-blur-md border-t p-3 shadow-lg z-20"
          )}
        >
          <div className={cn("flex items-center justify-between gap-3", isPage && "mx-auto w-full max-w-3xl")}>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                <span className="font-medium text-foreground">
                  {selectedLandlordNames.length} {selectedLandlordNames.length === 1 ? 'landlord' : 'landlords'} · {selectedTenantIds.size} {selectedTenantIds.size === 1 ? 'tenant' : 'tenants'}
                </span>
              </div>
              <p className="text-sm sm:text-base font-bold text-foreground truncate">
                Total Float: <span className="text-primary">{formatUGX(totalFloatAmount)}</span>
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedTenantIds(new Set())}
                className="text-xs h-9 px-2 text-muted-foreground hover:text-foreground"
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => setRequestFloatOpen(true)}
                className="h-9 gap-1.5 bg-primary text-primary-foreground font-semibold shadow-xs"
              >
                <Banknote className="h-4 w-4" />
                Request Float
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {isPage ? (
        <div className="min-h-[100dvh] bg-background flex flex-col">
          {/* Top header */}
          <header className="sticky top-0 z-20 bg-background/95 backdrop-blur-md border-b border-border">
            <div className="mx-auto w-full max-w-3xl px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (window.history.length > 1) {
                      navigate(-1);
                    } else {
                      navigate('/dashboard?tab=tenants');
                    }
                  }}
                  aria-label="Back to My Tenants"
                  className="h-9 w-9 sm:h-10 sm:w-10 shrink-0 rounded-full"
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
                  <div className="flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                    <Home className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-base sm:text-lg font-bold leading-tight truncate">Welile Homes</h1>
                    <p className="text-xs text-muted-foreground leading-tight truncate">Agent-managed tenants &amp; subscriptions</p>
                  </div>
                </div>
              </div>
            </div>
          </header>

          {/* Full-screen scrollable content */}
          <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-5 space-y-4 pb-28">
            {bodyContent}
          </main>
        </div>
      ) : (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            side="bottom"
            className="h-[92vh] w-full sm:max-w-lg sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 rounded-t-3xl border border-b-0 overflow-y-auto p-0 shadow-2xl"
          >
            <SheetHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur-md border-b px-4 py-3">
              <SheetTitle className="flex items-center gap-2">
                <Home className="h-5 w-5 text-primary" /> Welile Homes
              </SheetTitle>
            </SheetHeader>

            {bodyContent}
          </SheetContent>
        </Sheet>
      )}

      <EnrollDialog
        open={enrollOpen}
        initialMode={enrollInitialMode}
        onOpenChange={setEnrollOpen}
        agentId={user?.id}
        onDone={load}
      />
      <RequestFloatDialog
        open={requestFloatOpen}
        onClose={() => setRequestFloatOpen(false)}
        selectedTenants={selectedTenants}
        agentId={user?.id}
        onDone={() => {
          setSelectedTenantIds(new Set());
          load();
        }}
      />
      <VerifyTenantDialog sub={verifyFor} onClose={() => setVerifyFor(null)} onDone={load} />
      <AllocateDialog sub={allocFor} onClose={() => setAllocFor(null)} onDone={load} />
      <EditDialog sub={editFor} agentId={user?.id} onClose={() => setEditFor(null)} onDone={load} />

      <AlertDialog open={!!deleteFor} onOpenChange={(open) => { if (!open) setDeleteFor(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tenant enrollment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <span className="font-semibold text-foreground">{deleteFor?.tenant_name}</span> and all their monthly dues from Welile Homes. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} onClick={() => setDeleteFor(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={async () => {
                if (!deleteFor) return;
                setDeleting(true);
                try {
                  const { error } = await (supabase.rpc as any)('delete_welile_home_subscription', {
                    p_subscription_id: deleteFor.id,
                  });
                  if (error) throw error;
                  toast({ title: 'Enrollment deleted', description: `${deleteFor.tenant_name} has been removed.` });
                  setDeleteFor(null);
                  load();
                } catch (err: any) {
                  toast({ title: 'Could not delete', description: err?.message || 'Please try again.', variant: 'destructive' });
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------- Request Landlord Float Dialog ----------------
function RequestFloatDialog({
  open,
  onClose,
  selectedTenants,
  agentId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  selectedTenants: WHSubscription[];
  agentId?: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  const totalAmount = useMemo(
    () => selectedTenants.reduce((sum, s) => sum + (Number(s.monthly_rent) || 0), 0),
    [selectedTenants]
  );

  const landlordBreakdown = useMemo(() => {
    const map = new Map<string, { name: string; phone: string; tenants: WHSubscription[]; subtotal: number }>();
    selectedTenants.forEach((s) => {
      const name = s.landlord_name || 'Unassigned Landlord';
      const key = `${name.toLowerCase()}|${s.landlord_phone || ''}`;
      let item = map.get(key);
      if (!item) {
        item = { name, phone: s.landlord_phone || '', tenants: [], subtotal: 0 };
        map.set(key, item);
      }
      item.tenants.push(s);
      item.subtotal += Number(s.monthly_rent) || 0;
    });
    return Array.from(map.values());
  }, [selectedTenants]);

  useEffect(() => {
    if (open && agentId) {
      (async () => {
        const { data } = await supabase.from('profiles').select('phone').eq('id', agentId).maybeSingle();
        if (data?.phone) setPhone(data.phone);
      })();
      const landlordNames = landlordBreakdown.map((l) => l.name).join(', ');
      setNotes(`Welile Homes landlord float for: ${landlordNames} (${selectedTenants.length} tenants)`);
    }
  }, [open, agentId, landlordBreakdown, selectedTenants.length]);

  const handleSubmit = async () => {
    if (!agentId) return;
    if (totalAmount <= 0) {
      toast({ title: 'No float amount selected', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase
        .from('float_requests')
        .insert({
          agent_id: agentId,
          requested_amount: totalAmount,
          reason: notes.trim() || `Welile Homes landlord float (${selectedTenants.length} tenants)`,
          expected_recipient_phone: phone.trim() || null,
          status: 'pending',
        })
        .select('id')
        .single();

      if (error) throw error;

      try {
        await supabase.functions.invoke('notify-cfo-float-request', {
          body: {
            record: {
              id: data.id,
              agent_id: agentId,
              requested_amount: totalAmount,
              reason: notes.trim(),
              status: 'pending',
            },
          },
        });
      } catch (err) {
        console.warn('CFO notification background dispatch:', err);
      }

      toast({
        title: 'Float request submitted',
        description: `Total float of ${formatUGX(totalAmount)} requested for ${landlordBreakdown.length} landlord(s).`,
      });
      onDone();
      onClose();
    } catch (err: any) {
      toast({ title: 'Could not submit float request', description: err.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-primary" /> Request Landlord Float
          </DialogTitle>
          <DialogDescription>
            Submit a requisition to the CFO for the total float required to disburse rent to the selected landlords.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Total Banner */}
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-center">
            <p className="text-xs uppercase font-semibold tracking-wider text-muted-foreground">Total Float Requested</p>
            <p className="text-2xl font-bold text-primary mt-1">{formatUGX(totalAmount)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              For {landlordBreakdown.length} {landlordBreakdown.length === 1 ? 'landlord' : 'landlords'} · {selectedTenants.length} {selectedTenants.length === 1 ? 'tenant' : 'tenants'}
            </p>
          </div>

          {/* Breakdown per landlord */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
              Landlord Float Allocation Breakdown
            </Label>
            <div className="max-h-48 overflow-y-auto space-y-2 rounded-lg border p-2.5 bg-muted/20">
              {landlordBreakdown.map((l) => (
                <div key={`${l.name}|${l.phone}`} className="rounded-md border bg-card p-2.5 text-xs space-y-1">
                  <div className="flex items-center justify-between font-semibold">
                    <span className="flex items-center gap-1.5 truncate">
                      <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                      {l.name}
                    </span>
                    <span className="text-emerald-600 shrink-0 font-bold">{formatUGX(l.subtotal)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground pl-5 space-y-0.5">
                    {l.tenants.map((t) => (
                      <div key={t.id} className="flex justify-between">
                        <span className="truncate">{t.tenant_name}</span>
                        <span className="tabular-nums font-medium">{formatUGX(t.monthly_rent)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Phone */}
          <div>
            <Label className="text-xs">Your MoMo / Payout Phone Number</Label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07..."
              className="mt-1"
            />
          </div>

          {/* Notes */}
          <div>
            <Label className="text-xs">Purpose / Reason</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Requisition notes..."
              className="mt-1"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || totalAmount <= 0} className="gap-2">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
            Confirm Float Request ({formatUGX(totalAmount)})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Enroll dialog ----------------
interface LandlordRecord {
  id?: string;
  name: string;
  phone: string;
  address?: string;
  count: number;
}

function EnrollDialog({
  open,
  onOpenChange,
  agentId,
  onDone,
  initialMode = 'choose',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agentId?: string;
  onDone: () => void;
  initialMode?: 'choose' | 'register';
}) {
  const { toast } = useToast();

  // Step 1: Choose or Register Landlord; Step 2: Register Tenant & Terms
  const [step, setStep] = useState<'landlord' | 'tenant'>('landlord');

  // Landlord selection / registration state
  const [landlordMode, setLandlordMode] = useState<'choose' | 'register'>(initialMode);
  const [landlords, setLandlords] = useState<LandlordRecord[]>([]);
  const [landlordQuery, setLandlordQuery] = useState('');
  const [loadingLandlords, setLoadingLandlords] = useState(false);
  const [savingLandlord, setSavingLandlord] = useState(false);
  const [deleteLandlordTarget, setDeleteLandlordTarget] = useState<LandlordRecord | null>(null);
  const [deletingLandlord, setDeletingLandlord] = useState(false);

  // New landlord fields
  const [newLandlordName, setNewLandlordName] = useState('');
  const [newLandlordPhone, setNewLandlordPhone] = useState('');
  const [newLandlordAddress, setNewLandlordAddress] = useState('');

  // Selected landlord details
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');

  // Tenant fields
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [tenant, setTenant] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [newNationalId, setNewNationalId] = useState('');
  const [rent, setRent] = useState('');
  const [payoutDay, setPayoutDay] = useState('5');
  const [hasPhone, setHasPhone] = useState(true);
  const [landlordUsesWallet, setLandlordUsesWallet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Initialize or reset step and mode on open
  useEffect(() => {
    if (open) {
      setStep('landlord');
      setLandlordMode(initialMode === 'register' ? 'register' : (landlords.length === 0 ? 'register' : 'choose'));
    }
  }, [open, initialMode, landlords.length]);

  // Load existing landlords EXCLUSIVELY for THIS AGENT (never other people's landlords)
  useEffect(() => {
    if (!open || !agentId) return;
    let cancelled = false;
    (async () => {
      setLoadingLandlords(true);
      try {
        const map = new Map<string, LandlordRecord>();

        // 1. Landlords registered or managed by THIS AGENT in landlords table
        try {
          const { data: myDbLandlords } = await supabase
            .from('landlords')
            .select('id, name, phone, property_address, description, receipt_request_channel')
            .or(`registered_by.eq.${agentId},managed_by_agent_id.eq.${agentId}`)
            .order('created_at', { ascending: false })
            .limit(300);

          (myDbLandlords || []).forEach((row: any) => {
            const name = (row.name || '').trim();
            const p = (row.phone || '').trim();
            if (!name) return;
            const key = `${name.toLowerCase()}|${p}`;
            map.set(key, {
              id: row.id,
              name,
              phone: p,
              address: row.property_address || '',
              count: 0,
            });
          });
        } catch (e) {
          console.warn('Could not query agent landlords from DB:', e);
        }

        // 2. Include any landlords registered by THIS AGENT in local storage
        try {
          const storedKey = `welile_homes_landlords_${agentId}`;
          const localSaved = localStorage.getItem(storedKey);
          if (localSaved) {
            const parsed = JSON.parse(localSaved);
            if (Array.isArray(parsed)) {
              parsed.forEach((row: any) => {
                const name = (row.name || '').trim();
                const p = (row.phone || '').trim();
                if (!name) return;
                const key = `${name.toLowerCase()}|${p}`;
                const existing = map.get(key);
                if (existing) {
                  if (row.id && !existing.id) existing.id = row.id;
                  if (row.address && !existing.address) existing.address = row.address;
                } else {
                  map.set(key, { id: row.id, name, phone: p, address: row.address || '', count: 0 });
                }
              });
            }
          }
        } catch {
          // ignore
        }

        // 3. For this agent's landlords only, count attached active tenants from welile_homes_subscriptions
        try {
          const { data: mySubs } = await supabase
            .from('welile_homes_subscriptions')
            .select('landlord_name, landlord_phone, landlord_id')
            .or(`agent_id.eq.${agentId},enrolled_by.eq.${agentId}`);

          (mySubs || []).forEach((s: any) => {
            const sName = (s.landlord_name || '').trim().toLowerCase();
            const sPhone = (s.landlord_phone || '').trim();
            for (const [, item] of map.entries()) {
              if (
                (s.landlord_id && item.id && s.landlord_id === item.id) ||
                (sName && item.name.toLowerCase() === sName) ||
                (sPhone && item.phone && item.phone === sPhone)
              ) {
                item.count += 1;
              }
            }
          });
        } catch (e) {
          console.warn('Could not count subscriptions:', e);
        }

        if (cancelled) return;
        const list = Array.from(map.values()).sort((a, b) => b.count - a.count);
        setLandlords(list);
        if (list.length === 0) {
          setLandlordMode('register');
        }
      } finally {
        if (!cancelled) setLoadingLandlords(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, agentId]);

  const filteredLandlords = landlords.filter((l) => {
    const q = landlordQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      l.name.toLowerCase().includes(q) ||
      l.phone.includes(q.replace(/\s/g, '')) ||
      (l.address && l.address.toLowerCase().includes(q))
    );
  });

  const reset = () => {
    setStep('landlord');
    setLandlordMode(initialMode === 'register' ? 'register' : (landlords.length === 0 ? 'register' : 'choose'));
    setPhone('');
    setSearched(false);
    setTenant(null);
    setNewName('');
    setNewNationalId('');
    setRent('');
    setPayoutDay('5');
    setHasPhone(true);
    setLandlordUsesWallet(false);
    setLandlordName('');
    setLandlordPhone('');
    setLandlordQuery('');
    setNewLandlordName('');
    setNewLandlordPhone('');
    setNewLandlordAddress('');
  };

  const handleSelectLandlord = (l: { name: string; phone: string }) => {
    const isCurrentlySelected =
      landlordName.trim().toLowerCase() === l.name.trim().toLowerCase() &&
      (!landlordPhone || landlordPhone.trim() === (l.phone || '').trim());

    if (isCurrentlySelected) {
      // Deselect
      setLandlordName('');
      setLandlordPhone('');
    } else {
      // Select
      setLandlordName(l.name);
      setLandlordPhone(l.phone);
    }
  };

  const handleRequestDeleteLandlord = async (l: LandlordRecord) => {
    // 1. Guard against landlords with attached tenants in memory
    if (l.count > 0) {
      toast({
        title: 'Landlord is attached to tenant',
        description: `${l.name} is attached to ${l.count} active ${l.count === 1 ? 'tenant' : 'tenants'}. Landlords attached to tenants cannot be deleted 🤣`,
        variant: 'destructive',
      });
      return;
    }

    // 2. Guard against landlords attached to Welile Homes subscriptions in database
    try {
      let query = supabase
        .from('welile_homes_subscriptions')
        .select('id')
        .limit(1);

      if (l.id) {
        query = query.or(`landlord_id.eq.${l.id},landlord_name.ilike.${l.name}`);
      } else {
        query = query.ilike('landlord_name', l.name);
      }

      const { data: activeSubs } = await query;
      if (activeSubs && activeSubs.length > 0) {
        toast({
          title: 'Landlord is attached to tenant',
          description: `${l.name} is attached to an enrolled tenant. Landlords with active tenants cannot be deleted 🤣`,
          variant: 'destructive',
        });
        return;
      }
    } catch (e) {
      console.warn('Could not verify landlord subscriptions:', e);
    }

    // 3. Guard against landlords on payroll / monthly rent dues
    try {
      const { data: activeDues } = await supabase
        .from('welile_homes_monthly_dues')
        .select('id')
        .ilike('landlord_name', l.name)
        .limit(1);

      if (activeDues && activeDues.length > 0) {
        toast({
          title: 'Landlord is attached to tenant',
          description: `${l.name} is on payroll with monthly rent dues. Cannot be deleted 🤣`,
          variant: 'destructive',
        });
        return;
      }
    } catch (e) {
      console.warn('Could not verify monthly dues:', e);
    }

    // 4. Guard against rent plans or tenants if landlord has an id in landlords table
    if (l.id) {
      try {
        const [{ data: plans }, { data: directTenants }, { data: allocs }] = await Promise.all([
          supabase.from('rent_plans').select('id').eq('landlord_id', l.id).limit(1),
          supabase.from('tenants').select('id').eq('landlord_id', l.id).limit(1),
          supabase.from('landlord_float_allocations').select('id').eq('landlord_id', l.id).limit(1),
        ]);

        if ((plans && plans.length > 0) || (directTenants && directTenants.length > 0)) {
          toast({
            title: 'Landlord is attached to tenant',
            description: `${l.name} is attached to active tenants or rent plans and cannot be deleted 🤣`,
            variant: 'destructive',
          });
          return;
        }

        if (allocs && allocs.length > 0) {
          toast({
            title: 'Landlord is attached to tenant',
            description: `${l.name} has float allocations or payroll records and cannot be deleted 🤣`,
            variant: 'destructive',
          });
          return;
        }
      } catch (e) {
        console.warn('Could not verify related records:', e);
      }
    }

    setDeleteLandlordTarget(l);
  };

  const handleConfirmDeleteLandlord = async () => {
    if (!deleteLandlordTarget) return;
    const target = deleteLandlordTarget;
    setDeletingLandlord(true);
    try {
      // Delete from landlords table if an id exists
      if (target.id && agentId) {
        await supabase
          .from('landlords')
          .delete()
          .eq('id', target.id)
          .or(`registered_by.eq.${agentId},managed_by_agent_id.eq.${agentId}`);
      }

      // Remove from local storage
      if (agentId) {
        try {
          const storedKey = `welile_homes_landlords_${agentId}`;
          const localSaved = localStorage.getItem(storedKey);
          if (localSaved) {
            const parsed = JSON.parse(localSaved);
            if (Array.isArray(parsed)) {
              const updated = parsed.filter(
                (x: any) =>
                  `${(x.name || '').toLowerCase()}|${x.phone || ''}` !==
                  `${(target.name || '').toLowerCase()}|${target.phone || ''}`
              );
              localStorage.setItem(storedKey, JSON.stringify(updated));
            }
          }
        } catch {
          // ignore
        }
      }

      // Remove from state
      setLandlords((prev) =>
        prev.filter(
          (x) =>
            `${x.name.toLowerCase()}|${x.phone}` !==
            `${target.name.toLowerCase()}|${target.phone}`
        )
      );

      // Clear selection if currently selected
      if (landlordName.trim().toLowerCase() === target.name.trim().toLowerCase()) {
        setLandlordName('');
        setLandlordPhone('');
      }

      toast({
        title: 'Landlord deleted 🤣',
        description: `${target.name} was removed from your landlords list.`,
      });
      setDeleteLandlordTarget(null);
    } catch (err: any) {
      toast({
        title: 'Failed to delete landlord',
        description: err.message || 'Could not delete landlord',
        variant: 'destructive',
      });
    } finally {
      setDeletingLandlord(false);
    }
  };

  const handleProceedWithSelectedLandlord = () => {
    if (!landlordName.trim()) {
      toast({
        title: 'Please select a landlord',
        description: 'Choose a landlord from the list or register a new one.',
        variant: 'destructive',
      });
      return;
    }
    setStep('tenant');
  };

  const handleSaveNewLandlord = async () => {
    const name = newLandlordName.trim();
    const p = newLandlordPhone.trim();
    const addr = newLandlordAddress.trim();

    if (name.length < 2) {
      toast({ title: 'Enter landlord name', description: 'Please provide at least 2 characters.', variant: 'destructive' });
      return;
    }
    if (p.length < 7) {
      toast({ title: 'Enter landlord phone', description: 'Please provide a valid phone number.', variant: 'destructive' });
      return;
    }

    setSavingLandlord(true);
    let createdId: string | undefined;
    try {
      if (agentId) {
        const { data: inserted } = await supabase
          .from('landlords')
          .insert({
            name,
            phone: p,
            property_address: addr || 'Welile Homes Property',
            registered_by: agentId,
            managed_by_agent_id: agentId,
            is_agent_managed: true,
            has_smartphone: false,
            ready_to_receive: false,
            description: 'welile_homes',
            receipt_request_channel: 'welile_homes',
            service_center_comment: 'Welile Homes Landlord',
          })
          .select('id')
          .maybeSingle();

        if (inserted?.id) {
          createdId = inserted.id;
        }
      }
    } catch (err: any) {
      console.warn('Could not mirror landlord record to landlords table:', err);
    } finally {
      setSavingLandlord(false);
    }

    // Save locally so they persist and are immediately discoverable for THIS AGENT in Welile Homes
    try {
      const storedKey = `welile_homes_landlords_${agentId}`;
      const existingRaw = localStorage.getItem(storedKey);
      const existingList = existingRaw ? JSON.parse(existingRaw) : [];
      const updatedList = [
        { id: createdId, name, phone: p, address: addr, count: 0 },
        ...existingList.filter((x: any) => `${(x.name || '').toLowerCase()}|${x.phone}` !== `${name.toLowerCase()}|${p}`),
      ];
      localStorage.setItem(storedKey, JSON.stringify(updatedList));
    } catch {
      // ignore storage error
    }

    // Add to local state so they appear immediately in list
    setLandlords((prev) => {
      const key = `${name.toLowerCase()}|${p}`;
      if (prev.some((x) => `${x.name.toLowerCase()}|${x.phone}` === key)) return prev;
      return [{ id: createdId, name, phone: p, address: addr, count: 0 }, ...prev];
    });

    setLandlordName(name);
    setLandlordPhone(p);
    toast({ title: 'Landlord registered for Welile Homes 🤣', description: `${name} selected. Now enter tenant details.` });
    setStep('tenant');
  };

  const findTenant = async () => {
    const p = phone.trim();
    if (!p) return;
    setSearching(true);
    setTenant(null);
    try {
      const { data } = await supabase
        .from('profiles').select('id, full_name, phone')
        .ilike('phone', `%${p.replace(/\s/g, '')}%`).limit(1).maybeSingle();
      if (data) setTenant(data as any);
    } finally { setSearching(false); setSearched(true); }
  };

  const submit = async () => {
    if (!agentId) return;
    if (!landlordName.trim()) {
      toast({ title: 'Choose or register a landlord first', variant: 'destructive' });
      setStep('landlord');
      return;
    }
    const coreError = validateEnrollmentCore({ rent, payoutDay, hasSmartphone: hasPhone });
    if (coreError) { toast({ title: coreError, variant: 'destructive' }); return; }
    if (!tenant) {
      if (!phone.trim()) { toast({ title: 'Enter the tenant phone', variant: 'destructive' }); return; }
      if (newName.trim().length < 2) { toast({ title: 'Enter the tenant full name', variant: 'destructive' }); return; }
    }
    await finalizeEnroll();
  };

  const finalizeEnroll = async () => {
    if (!agentId) return;
    const rentNum = parseFloat(rent);
    setSubmitting(true);
    try {
      let tenantId = tenant?.id;
      if (!tenantId) {
        const { data: reg, error: regErr } = await supabase.functions.invoke('register-tenant', {
          body: {
            full_name: newName.trim(),
            phone: phone.trim(),
            national_id: newNationalId.trim() || null,
            telemetry: await collectAgentSignupTelemetry('/agent/welile-homes', 'tenant'),
          },
        });
        if (regErr) throw new Error(regErr.message || 'Could not create tenant account');
        if ((reg as any)?.error) throw new Error((reg as any).error);
        tenantId = (reg as any)?.user_id;
        if (!tenantId) throw new Error('Could not create tenant account');
      }
      const { data, error } = await supabase.rpc('enroll_welile_home_tenant', {
        p_tenant_id: tenantId,
        p_agent_id: agentId,
        p_monthly_rent: rentNum,
        p_payout_day: parseInt(payoutDay) || 5,
        p_has_smartphone: hasPhone,
        p_landlord_uses_wallet: landlordUsesWallet,
        p_landlord_id: null,
        p_landlord_name: landlordName || null,
        p_landlord_phone: landlordPhone || null,
        p_notes: null,
      });
      if (error) throw error;
      const res = data as any;
      if (!res?.success) throw new Error(res?.error || 'Enrollment failed');
      toast({
        title: 'Tenant enrolled successfully. Pending verification.',
        description: `${formatUGX(rentNum)}/mo · you earn ${formatUGX(res.agent_commission_per_month)}/mo`,
      });
      reset();
      onOpenChange(false);
      onDone();
    } catch (err: any) {
      toast({ title: 'Enrollment failed', description: err.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            {step === 'landlord'
              ? (landlordMode === 'register' ? 'Register New Landlord' : 'Choose Existing Landlord')
              : 'Register Tenant'}
          </DialogTitle>
          <DialogDescription>
            {step === 'landlord'
              ? (landlordMode === 'register'
                ? 'Enter the landlord details. They will be saved to your landlords list and linked to the tenant.'
                : 'Select an existing landlord from your file or switch to register a new one.')
              : 'Link the tenant to the selected landlord and set the monthly rent terms.'}
          </DialogDescription>
        </DialogHeader>

        {/* Step Indicator */}
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2 text-xs">
          <button
            type="button"
            onClick={() => setStep('landlord')}
            className={`flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-colors ${step === 'landlord'
                ? 'bg-background shadow-xs text-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${landlordName ? 'bg-emerald-500 text-white' : 'bg-primary text-primary-foreground'
                }`}
            >
              {landlordName ? '✓' : '1'}
            </span>
            <span className="truncate">1. Landlord{landlordName ? `: ${landlordName}` : ''}</span>
          </button>

          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

          <button
            type="button"
            disabled={!landlordName}
            onClick={() => { if (landlordName) setStep('tenant'); }}
            className={`flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-colors disabled:opacity-50 ${step === 'tenant'
                ? 'bg-background shadow-xs text-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${step === 'tenant' ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/30 text-muted-foreground'
                }`}
            >
              2
            </span>
            <span className="truncate">2. Tenant & Rent</span>
          </button>
        </div>

        {/* STEP 1: LANDLORD */}
        {step === 'landlord' && (
          <div className="space-y-4">
            <Tabs value={landlordMode} onValueChange={(v) => setLandlordMode(v as any)} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="choose" className="text-xs">
                  My Landlords ({landlords.length})
                </TabsTrigger>
                <TabsTrigger value="register" className="text-xs">
                  + Register New Landlord
                </TabsTrigger>
              </TabsList>

              {/* CHOOSE EXISTING LANDLORD */}
              <TabsContent value="choose" className="space-y-3 pt-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={landlordQuery}
                    onChange={(e) => setLandlordQuery(e.target.value)}
                    placeholder="Find your landlord by name or phone..."
                    className="h-9 pl-8 text-sm"
                  />
                </div>

                <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                  {loadingLandlords ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : filteredLandlords.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-4 text-center">
                      <Building2 className="mx-auto h-7 w-7 text-muted-foreground/50 mb-1" />
                      <p className="text-xs font-medium text-foreground">
                        {landlords.length === 0 ? 'No landlords registered by you yet 🤣' : `No match for "${landlordQuery}"`}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 mb-3">
                        {landlords.length === 0
                          ? 'This search engine only looks at your own landlords instead of other people’s. Register your landlord to get started!'
                          : 'No landlord in your list matched this search.'}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (landlordQuery) {
                            if (/^\d+$/.test(landlordQuery.replace(/\s/g, ''))) {
                              setNewLandlordPhone(landlordQuery);
                            } else {
                              setNewLandlordName(landlordQuery);
                            }
                          }
                          setLandlordMode('register');
                        }}
                        className="gap-1.5 text-xs"
                      >
                        <UserPlus className="h-3.5 w-3.5" /> Register new landlord
                      </Button>
                    </div>
                  ) : (
                    filteredLandlords.map((l) => {
                      const isSelected =
                        landlordName.trim().toLowerCase() === l.name.toLowerCase() &&
                        (!landlordPhone || landlordPhone.trim() === l.phone);
                      return (
                        <div
                          key={`${l.name}|${l.phone}`}
                          onClick={() => handleSelectLandlord(l)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') handleSelectLandlord(l);
                          }}
                          className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors cursor-pointer ${isSelected
                              ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary'
                              : 'hover:bg-muted/60'
                            }`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-foreground truncate flex items-center gap-1.5">
                              {l.name}
                              {isSelected && (
                                <Badge variant="default" className="text-[9px] h-4 px-1 py-0 font-normal">
                                  Selected
                                </Badge>
                              )}
                            </p>
                            <p className="text-muted-foreground truncate text-[11px]">
                              {l.phone || 'No phone'}
                              {l.address ? ` · ${l.address}` : ''}
                            </p>
                          </div>
                          <div className="shrink-0 flex items-center gap-1.5">
                            {l.count > 0 ? (
                              <Badge variant="secondary" className="text-[10px]">
                                {l.count} {l.count === 1 ? 'tenant' : 'tenants'}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-primary/80 border-primary/30 bg-primary/5">
                                Welile Homes
                              </Badge>
                            )}
                            {isSelected ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs border-primary/40 bg-primary/10 text-primary hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition-colors"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSelectLandlord(l);
                                }}
                                title="Click to deselect"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-primary shrink-0" /> Selected
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs hover:bg-primary/10 hover:text-primary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSelectLandlord(l);
                                }}
                              >
                                Select →
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRequestDeleteLandlord(l);
                              }}
                              title={l.count > 0 ? 'Landlord is attached to tenant' : 'Delete landlord'}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="pt-2 flex gap-2">
                  <Button
                    type="button"
                    onClick={handleProceedWithSelectedLandlord}
                    disabled={!landlordName}
                    className="w-full gap-2"
                  >
                    <span>Continue to Tenant Registration</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </TabsContent>

              {/* REGISTER NEW LANDLORD */}
              <TabsContent value="register" className="space-y-3 pt-2">
                <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                  <div>
                    <Label className="text-xs">Landlord Full Name *</Label>
                    <Input
                      value={newLandlordName}
                      onChange={(e) => setNewLandlordName(e.target.value)}
                      placeholder="e.g. Chemayek Abraham"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Landlord Phone Number *</Label>
                    <Input
                      value={newLandlordPhone}
                      onChange={(e) => setNewLandlordPhone(e.target.value)}
                      placeholder="e.g. 0772 123 456"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Property Address / Location (optional)</Label>
                    <Input
                      value={newLandlordAddress}
                      onChange={(e) => setNewLandlordAddress(e.target.value)}
                      placeholder="e.g. Kansanga, Block 4"
                      className="mt-1"
                    />
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Once registered, this landlord will be saved to your landlords list and selected for tenant registration.
                </p>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={handleSaveNewLandlord}
                    disabled={savingLandlord || !newLandlordName.trim() || !newLandlordPhone.trim()}
                    className="w-full gap-2"
                  >
                    {savingLandlord ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <UserCheck className="h-4 w-4" />
                    )}
                    <span>Save Landlord & Continue to Tenant →</span>
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}

        {/* STEP 2: TENANT & RENT */}
        {step === 'tenant' && (
          <div className="space-y-3">
            {/* Selected Landlord Summary Banner */}
            <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 p-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Building2 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase font-semibold text-primary tracking-wider">Landlord</p>
                  <p className="text-sm font-bold text-foreground truncate">{landlordName}</p>
                  <p className="text-xs text-muted-foreground truncate">{landlordPhone || 'No phone on file'}</p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep('landlord')}
                className="text-xs shrink-0 gap-1 h-8"
              >
                Change
              </Button>
            </div>

            <div>
              <Label>Tenant phone *</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={phone}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPhone(val);
                    setSearched(false);
                    setTenant(null);
                  }}
                  onBlur={() => {
                    if (phone.trim().length >= 9 && !tenant) {
                      findTenant();
                    }
                  }}
                  placeholder="e.g. 0772 123 456"
                />
                <Button type="button" variant="outline" onClick={findTenant} disabled={searching}>
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>
              {tenant ? (
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Existing account: {tenant.full_name} ({tenant.phone})
                </div>
              ) : searched ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  New tenant number — please enter their name below.
                </p>
              ) : null}
            </div>

            {!tenant && (
              <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                <p className="text-xs font-semibold text-foreground">New tenant details</p>
                <div>
                  <Label className="text-xs">Tenant full name *</Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. John Doe"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">National ID (optional)</Label>
                  <Input
                    value={newNationalId}
                    onChange={(e) => setNewNationalId(e.target.value)}
                    placeholder="CM..."
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between">
                <Label>Monthly rent (UGX)</Label>
                {Number(rent) > 0 && (
                  <span className="text-[11px] text-emerald-600 font-medium">
                    You earn {formatUGX(Number(rent) * 0.02)}/mo
                  </span>
                )}
              </div>
              <Input
                type="number"
                inputMode="numeric"
                value={rent}
                onChange={(e) => setRent(e.target.value)}
                placeholder="500000"
                className="mt-1"
              />
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {['200000', '350000', '500000', '800000', '1000000'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setRent(preset)}
                    className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${rent === preset
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'hover:bg-muted text-muted-foreground'
                      }`}
                  >
                    {formatUGX(Number(preset))}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Landlord payout day (1–28)</Label>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                The date of each month when the landlord receives their rent payout (e.g. 5 = 5th of every month).
              </p>
              <Input
                type="number"
                inputMode="numeric"
                value={payoutDay}
                onChange={(e) => setPayoutDay(e.target.value)}
                min={1}
                max={28}
                placeholder="5"
                className="mt-1"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Tenant has a smartphone</p>
                <p className="text-xs text-muted-foreground">Off = you allocate their rent</p>
              </div>
              <Switch checked={hasPhone} onCheckedChange={setHasPhone} />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Landlord uses Welile wallet</p>
                <p className="text-xs text-muted-foreground">Off = paid to your landlord float</p>
              </div>
              <Switch checked={landlordUsesWallet} onCheckedChange={setLandlordUsesWallet} />
            </div>

            <div className="pt-2 flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('landlord')}
                className="gap-1.5"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button
                onClick={submit}
                disabled={submitting || (!tenant && newName.trim().length < 2) || !phone.trim() || !rent.trim()}
                className="flex-1 gap-2"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
                Enroll Tenant for {landlordName}
              </Button>
            </div>
          </div>
        )}

        <AlertDialog open={!!deleteLandlordTarget} onOpenChange={(o) => { if (!o) setDeleteLandlordTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleteLandlordTarget?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to remove this landlord from your Welile Homes list? This landlord has no tenants attached.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deletingLandlord}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDeleteLandlord}
                disabled={deletingLandlord}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deletingLandlord ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                Delete Landlord
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Verify tenant dialog ----------------
function VerifyTenantDialog({ sub, onClose, onDone }: {
  sub: WHSubscription | null; onClose: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [otpValue, setOtpValue] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (sub) { setSent(false); setOtpValue(''); setOtpError(null); setCooldown(0); }
  }, [sub?.id]);

  const phone = sub?.tenant_phone?.trim() || '';

  const sendOtp = async () => {
    if (!phone) { toast({ title: 'This tenant has no phone number', variant: 'destructive' }); return; }
    setSending(true); setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'send', phone, category: 'welile_homes_tenant_verify' },
      });
      if (error) throw new Error(error.message || 'Could not send the code');
      if ((data as any)?.error) throw new Error((data as any).error);
      setSent(true);
      setOtpValue('');
      setCooldown(60);
      toast({ title: 'Verification SMS sent to tenant', description: phone });
    } catch (err: any) {
      toast({ title: 'Could not send verification SMS', description: err.message, variant: 'destructive' });
    } finally { setSending(false); }
  };

  const verifyOtp = async (code: string) => {
    if (!sub) return;
    setVerifying(true); setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'verify', phone, otp: code, category: 'welile_homes_tenant_verify' },
      });
      if (error) throw new Error('Invalid or expired code');
      if ((data as any)?.error) throw new Error((data as any).error);
      if (!(data as any)?.success) throw new Error('Verification failed');

      const { data: markRes, error: markErr } = await supabase.rpc('welile_home_mark_tenant_verified', {
        p_subscription_id: sub.id,
      });
      if (markErr) throw markErr;
      if (!(markRes as any)?.success) throw new Error((markRes as any)?.error || 'Could not mark tenant verified');

      toast({ title: 'Tenant verified', description: sub.tenant_name });
      onClose();
      onDone();
    } catch (err: any) {
      setOtpValue('');
      setOtpError(err.message || 'Verification failed');
    } finally { setVerifying(false); }
  };

  return (
    <Dialog open={!!sub} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> Verify tenant
          </DialogTitle>
          <DialogDescription>
            {sent
              ? `Enter the 6-digit code sent to ${phone}.`
              : `Send a verification SMS to ${sub?.tenant_name || 'this tenant'} on ${phone || 'no phone on file'}.`}
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="space-y-4">
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={otpValue}
                disabled={verifying}
                onChange={(v) => {
                  setOtpValue(v);
                  setOtpError(null);
                  if (v.length === 6) verifyOtp(v);
                }}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            {verifying && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
              </div>
            )}
            {otpError && <p className="text-sm text-destructive text-center">{otpError}</p>}
            <div className="text-center">
              <button
                type="button"
                onClick={() => { if (cooldown === 0 && !sending) sendOtp(); }}
                disabled={cooldown > 0 || sending || verifying}
                className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline inline-flex items-center gap-1"
              >
                <RefreshCw className="h-3 w-3" />
                {cooldown > 0 ? `Resend code in ${cooldown}s` : sending ? 'Sending…' : 'Resend code'}
              </button>
            </div>
          </div>
        ) : (
          <DialogFooter>
            <Button className="w-full gap-2" onClick={sendOtp} disabled={sending || !phone}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Send verification SMS
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Edit dialog ----------------
function PreviewRow({ label, oldText, newText, changed }: {
  label: string; oldText: string; newText: string; changed: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {changed ? (
        <span className="text-right">
          <span className="text-muted-foreground line-through">{oldText}</span>{' '}
          <span className="font-semibold text-foreground">→ {newText}</span>
        </span>
      ) : (
        <span className="font-medium text-foreground">{newText}</span>
      )}
    </div>
  );
}

function EditDialog({ sub, agentId, onClose, onDone }: {
  sub: WHSubscription | null; agentId?: string; onClose: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [rent, setRent] = useState('');
  const [payoutDay, setPayoutDay] = useState('5');
  const [hasPhone, setHasPhone] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<EnrollmentAuditRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadHistory = useCallback(async (subscriptionId: string) => {
    setHistoryLoading(true);
    try {
      const { data } = await supabase
        .from('welile_homes_enrollment_audit')
        .select('id, edited_by, changes, months_adjusted, created_at')
        .eq('subscription_id', subscriptionId)
        .order('created_at', { ascending: false })
        .limit(20);
      const rows = (data ?? []) as EnrollmentAuditRow[];
      const editorIds = Array.from(new Set(rows.map((r) => r.edited_by)));
      if (editorIds.length) {
        const { data: profs } = await supabase
          .from('profiles').select('id, full_name').in('id', editorIds);
        const nameMap = new Map((profs ?? []).map((p: any) => [p.id, p.full_name]));
        rows.forEach((r) => { r.editor_name = nameMap.get(r.edited_by) ?? 'Someone'; });
      }
      setHistory(rows);
    } finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => {
    if (sub) {
      setRent(String(sub.monthly_rent ?? ''));
      setPayoutDay(String(sub.payout_day ?? 5));
      setHasPhone(!!sub.has_smartphone);
      setHistory([]);
      setStep('form');
      setPreview(null);
      loadHistory(sub.id);
    }
  }, [sub, loadHistory]);

  const review = async () => {
    if (!sub || !agentId) return;
    const coreError = validateEnrollmentCore({ rent, payoutDay, hasSmartphone: hasPhone });
    if (coreError) { toast({ title: coreError, variant: 'destructive' }); return; }
    const rentNum = parseFloat(rent);
    setPreviewLoading(true);
    try {
      const { data, error } = await supabase.rpc('preview_welile_home_enrollment_edit', {
        p_subscription_id: sub.id,
        p_agent_id: agentId,
        p_monthly_rent: rentNum,
        p_payout_day: parseInt(payoutDay) || 5,
        p_has_smartphone: hasPhone,
      });
      if (error) throw error;
      const res = data as unknown as EditPreview;
      if (!res?.success) throw new Error(res?.error || 'Could not build preview');
      if (!res.changes || res.changes.length === 0) {
        toast({ title: 'No changes to save', description: 'The values match the current enrollment.' });
        return;
      }
      setPreview(res);
      setStep('confirm');
    } catch (err: any) {
      toast({ title: 'Preview failed', description: err.message, variant: 'destructive' });
    } finally { setPreviewLoading(false); }
  };

  const submit = async () => {
    if (!sub || !agentId) return;
    const coreError = validateEnrollmentCore({ rent, payoutDay, hasSmartphone: hasPhone });
    if (coreError) { toast({ title: coreError, variant: 'destructive' }); return; }
    const rentNum = parseFloat(rent);
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('edit_welile_home_enrollment', {
        p_subscription_id: sub.id,
        p_agent_id: agentId,
        p_monthly_rent: rentNum,
        p_payout_day: parseInt(payoutDay) || 5,
        p_has_smartphone: hasPhone,
      });
      if (error) throw error;
      const res = data as any;
      if (!res?.success) throw new Error(res?.error || 'Update failed');
      // Notify the tenant that their dues/payout day changed. Fire-and-forget;
      // the edge function is idempotent and no-ops when nothing meaningful changed.
      if ((res.changes?.length ?? 0) > 0) {
        supabase.functions.invoke('welile-home-enrollment-update-sms', {
          body: { subscription_id: sub.id },
        }).catch(() => { });
      }
      toast({
        title: 'Enrollment updated',
        description: `${res.months_adjusted} upcoming ${res.months_adjusted === 1 ? 'month' : 'months'} adjusted · you earn ${formatUGX(res.agent_commission_per_month)}/mo`,
      });
      onDone();
      onClose();
    } catch (err: any) {
      toast({ title: 'Update failed', description: err.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={!!sub} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {step === 'confirm' ? 'Confirm changes' : 'Edit enrollment'} — {sub?.tenant_name}
          </DialogTitle>
          <DialogDescription>
            {step === 'confirm'
              ? 'Review how dues and totals will change before saving. Nothing is saved yet.'
              : 'Changes apply to upcoming, uncollected months only. Collected and paid months stay as they were.'}
          </DialogDescription>
        </DialogHeader>
        {step === 'confirm' && preview ? (
          <div className="space-y-3">
            <div className="rounded-lg border divide-y">
              <PreviewRow label="Monthly rent" oldText={formatUGX(preview.monthly_rent.old)} newText={formatUGX(preview.monthly_rent.new)} changed={preview.monthly_rent.old !== preview.monthly_rent.new} />
              <PreviewRow label="Landlord payout day" oldText={String(preview.payout_day.old ?? '—')} newText={String(preview.payout_day.new)} changed={preview.payout_day.old !== preview.payout_day.new} />
              <PreviewRow label="Collection mode" oldText={preview.has_smartphone.old ? 'Tenant pays' : 'Agent allocates'} newText={preview.has_smartphone.new ? 'Tenant pays' : 'Agent allocates'} changed={preview.has_smartphone.old !== preview.has_smartphone.new} />
              <PreviewRow label="Your commission / mo" oldText={formatUGX(preview.agent_commission_per_month.old)} newText={formatUGX(preview.agent_commission_per_month.new)} changed={preview.agent_commission_per_month.old !== preview.agent_commission_per_month.new} />
              <PreviewRow label="Landlord payout / mo" oldText={formatUGX(preview.landlord_net_per_month.old)} newText={formatUGX(preview.landlord_net_per_month.new)} changed={preview.landlord_net_per_month.old !== preview.landlord_net_per_month.new} />
              <PreviewRow label="Receivable total" oldText={formatUGX(preview.receivable_total.old)} newText={formatUGX(preview.receivable_total.new)} changed={preview.receivable_total.old !== preview.receivable_total.new} />
              <PreviewRow label="Outstanding balance" oldText={formatUGX(preview.outstanding_balance.old)} newText={formatUGX(preview.outstanding_balance.new)} changed={preview.outstanding_balance.old !== preview.outstanding_balance.new} />
              <PreviewRow label="Next due date" oldText={preview.next_due_date.old ? new Date(preview.next_due_date.old).toLocaleDateString() : '—'} newText={preview.next_due_date.new ? new Date(preview.next_due_date.new).toLocaleDateString() : '—'} changed={preview.next_due_date.old !== preview.next_due_date.new} />
            </div>
            <p className="text-xs text-muted-foreground">
              {preview.months_adjusted} upcoming {preview.months_adjusted === 1 ? 'month' : 'months'} will be re-priced. Collected and paid months are untouched.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label>Monthly rent (UGX)</Label>
              <Input type="number" inputMode="numeric" value={rent} onChange={(e) => setRent(e.target.value)} placeholder="500000" />
            </div>
            <div>
              <Label>Landlord payout day (1–28)</Label>
              <Input type="number" inputMode="numeric" value={payoutDay} onChange={(e) => setPayoutDay(e.target.value)} min={1} max={28} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div><p className="text-sm font-medium">Tenant has a smartphone</p><p className="text-xs text-muted-foreground">Off = you allocate their rent</p></div>
              <Switch checked={hasPhone} onCheckedChange={setHasPhone} />
            </div>

            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
                <History className="h-3.5 w-3.5" /> Edit history
              </div>
              {historyLoading ? (
                <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
              ) : history.length === 0 ? (
                <p className="text-xs text-muted-foreground">No edits yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {history.map((h) => (
                    <div key={h.id} className="text-xs border-l-2 border-muted pl-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{h.editor_name}</span>
                        <span className="text-muted-foreground">{new Date(h.created_at).toLocaleString()}</span>
                      </div>
                      <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                        {(h.changes ?? []).map((c, i) => (
                          <li key={i}>
                            <span className="text-foreground">{FIELD_LABELS[c.field] ?? c.field}:</span>{' '}
                            {formatAuditValue(c.field, c.old)} → <span className="text-foreground">{formatAuditValue(c.field, c.new)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          {step === 'confirm' ? (
            <div className="flex w-full gap-2">
              <Button variant="outline" onClick={() => setStep('form')} disabled={submitting} className="flex-1">
                <ArrowLeft className="h-4 w-4 mr-1.5" /> Back
              </Button>
              <Button onClick={submit} disabled={submitting} className="flex-1">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Confirm &amp; save
              </Button>
            </div>
          ) : (
            <Button onClick={review} disabled={previewLoading} className="w-full">
              {previewLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Review changes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Allocate dialog ----------------
function AllocateDialog({ sub, onClose, onDone }: {
  sub: WHSubscription | null; onClose: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Month options: current month plus the 5 previous and 2 upcoming months.
  const monthOptions = (() => {
    const now = new Date();
    const opts: { value: string; label: string }[] = [];
    for (let i = 5; i >= -2; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      opts.push({ value, label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }) });
    }
    return opts;
  })();

  useEffect(() => {
    if (sub) {
      setAmount(String(Math.min(sub.monthly_rent, sub.outstanding_balance)));
      const now = new Date();
      setPeriod(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
    }
  }, [sub]);

  const submit = async () => {
    if (!sub) return;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast({ title: 'Enter a valid amount', variant: 'destructive' }); return; }
    if (!period) { toast({ title: 'Select the month being paid for', variant: 'destructive' }); return; }
    const periodLabel = monthOptions.find((m) => m.value === period)?.label || period;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('welile_home_record_collection', {
        p_subscription_id: sub.id,
        p_amount: amt,
        p_source: 'agent_allocation',
        p_notes: `Agent allocation — rent for ${periodLabel}`,
      });
      if (error) throw error;
      const res = data as any;
      if (!res?.success) throw new Error(res?.error || 'Allocation failed');
      toast({ title: 'Rent allocated', description: `${formatUGX(res.amount_collected)} · you earned ${formatUGX(res.agent_commission)}` });
      // Fire-and-forget: send the tenant an SMS receipt for this collection.
      supabase.functions.invoke('welile-homes-sms-dispatch', { body: { since_minutes: 10 } }).catch(() => { });
      onClose();
      onDone();
    } catch (err: any) {
      toast({ title: 'Allocation failed', description: err.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={!!sub} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allocate rent — {sub?.tenant_name}</DialogTitle>
          <DialogDescription>
            Records cash collected from the tenant. Outstanding: {sub ? formatUGX(sub.outstanding_balance) : ''}. Drawn from your float.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Amount (UGX)</Label>
          <Input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Month being paid for</Label>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger>
              <SelectValue placeholder="Select month" />
            </SelectTrigger>
            <SelectContent>
              {monthOptions.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting} className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Allocate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AgentWelileHomesSheet;