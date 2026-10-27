import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { ACTIVE_RENT_STATUSES } from '@/hooks/useAgentCapacityMap';
import { Home, Loader2, Plus, Banknote, TrendingUp, Users, Clock, Search, CheckCircle2, ShieldCheck, RefreshCw, ArrowLeft, ArrowRight, Pencil, History, Trash2, ChevronDown, Building2, UserCheck, UserPlus, AlertCircle, Receipt, XCircle, Lock, Camera, Upload, Navigation, MapPin, X, Image as ImageIcon, AlertTriangle } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { z } from 'zod';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';
import { requestWelileHomesFloat, WH_REASON_ILIKE } from '@/lib/welileHomesFloat';
import {
  resolveWhPlanStage, isWhPlanLocked, dueHasCollection, fetchWhFloatLinks,
  WH_STAGE_META, type WhPlanStage, type WhStageMeta,
} from '@/lib/welileHomesPlanStatus';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { captureGps, type CapturedGps } from '@/lib/captureGps';
import { optimizeImage } from '@/lib/imageOptimizer';

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
  subscription_status?: string | null;
  notes?: string | null;
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
  if (s.subscription_status === 'cancelled') {
    return { label: 'Declined', ready: false, className: 'border-destructive/40 bg-destructive/10 text-destructive font-semibold' };
  }
  if (s.tenant_verified) {
    return { label: 'Verified', ready: true, className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' };
  }
  return { label: 'Unverified', ready: false, className: 'border-amber-500/40 bg-amber-500/10 text-amber-600' };
}

const STAGE_TONE_CLASS: Record<WhStageMeta['tone'], string> = {
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive font-medium',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-semibold',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300 font-medium',
  violet: 'border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300 font-medium',
  neutral: 'border-amber-500/30 text-amber-600 bg-amber-500/5',
};

interface FloatPipelineInfo extends WhStageMeta {
  stage: WhPlanStage;
  badgeClass: string;
  /** Delete is withheld (money or a live request is attached). Server enforces the same. */
  isLocked: boolean;
}

function pipelineInfo(stage: WhPlanStage, isLocked: boolean, description?: string): FloatPipelineInfo {
  const meta = WH_STAGE_META[stage];
  return {
    ...meta,
    description: description || meta.description,
    stage,
    badgeClass: STAGE_TONE_CLASS[meta.tone],
    isLocked,
  };
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
  const [floatRequests, setFloatRequests] = useState<any[]>([]);
  // Recorded facts behind each plan's stage and delete lock (see src/lib/welileHomesPlanStatus.ts).
  const [floatLinks, setFloatLinks] = useState<Map<string, string>>(new Map());
  const [collectedSubIds, setCollectedSubIds] = useState<Set<string>>(new Set());
  const [collectionsUnknown, setCollectionsUnknown] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // No funding_status: that column is not on welile_homes_subscriptions.
      const { data: subRows, error: subErr } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, monthly_rent, outstanding_balance, receivable_total, has_smartphone, landlord_uses_wallet, payout_day, next_due_date, landlord_name, landlord_phone, created_at, subscription_status, notes')
        .or(`agent_id.eq.${user.id},enrolled_by.eq.${user.id}`)
        .order('created_at', { ascending: false });
      if (subErr) throw new Error(subErr.message);
      const list = (subRows ?? []) as WHSubscription[];
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

      // Which plans have collections or landlord payouts recorded (locks Delete).
      // A failed read locks every plan rather than offering Delete on unknown history.
      const subIds = list.map((s) => s.id);
      if (subIds.length) {
        const { data: dueRows, error: duesErr } = await supabase
          .from('welile_homes_monthly_dues')
          .select('subscription_id, amount_collected, collection_status, payout_status')
          .in('subscription_id', subIds)
          .or('amount_collected.gt.0,collection_status.eq.collected,payout_status.neq.unpaid')
          .limit(1000);
        // An error or a possibly truncated page locks every plan rather than guessing.
        if (duesErr || (dueRows?.length ?? 0) >= 1000) {
          setCollectionsUnknown(true);
        } else {
          setCollectedSubIds(new Set((dueRows ?? []).filter(dueHasCollection).map((d: any) => d.subscription_id)));
          setCollectionsUnknown(false);
        }
      } else {
        setCollectedSubIds(new Set());
        setCollectionsUnknown(false);
      }

      // Float request linked to each subscription (empty until the float-link migration).
      try {
        setFloatLinks(await fetchWhFloatLinks());
      } catch (linkErr) {
        console.warn('Welile Homes float links unavailable:', linkErr);
        setFloatLinks(new Map());
      }

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

      // Load agent's float requests to track pipeline stage for each landlord/tenant
      const { data: floatReqs } = await supabase
        .from('float_requests')
        .select('id, agent_id, requested_amount, reason, status, created_at, approved_at, rejection_reason')
        .eq('agent_id', user.id)
        .ilike('reason', WH_REASON_ILIKE)
        .order('created_at', { ascending: false });
      setFloatRequests(floatReqs ?? []);
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

  const activeSubs = useMemo(() => subs.filter((s) => s.subscription_status !== 'cancelled'), [subs]);
  const declinedSubs = useMemo(() => subs.filter((s) => s.subscription_status === 'cancelled'), [subs]);

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
      if (s.subscription_status !== 'cancelled') {
        group.totalRent += Number(s.monthly_rent) || 0;
        group.totalOutstanding += Number(s.outstanding_balance) || 0;
      }
    });

    return Array.from(map.values());
  }, [visibleSubs]);

  // Stage and delete lock per subscription, from recorded facts only.
  const getSubscriptionPipeline = useCallback((sub: WHSubscription): FloatPipelineInfo => {
    const facts = {
      subscriptionStatus: sub.subscription_status,
      linkedRequestStatus: floatLinks.get(sub.id) ?? null,
      hasCollections: collectedSubIds.has(sub.id),
      collectionsUnknown,
    };
    const stage = resolveWhPlanStage(facts);
    return pipelineInfo(stage, isWhPlanLocked(facts), stage === 'declined' ? sub.notes || undefined : undefined);
  }, [floatLinks, collectedSubIds, collectionsUnknown]);

  // Landlord badge: all declined, else the first tenant with a recorded stage.
  const getLandlordPipeline = useCallback((group: { name: string; phone?: string; tenants: WHSubscription[] }): FloatPipelineInfo => {
    const active = group.tenants.filter((t) => t.subscription_status !== 'cancelled');
    if (active.length === 0 && group.tenants.length > 0) {
      return pipelineInfo('declined', false, 'All applications under this landlord were declined');
    }
    for (const t of active) {
      const p = getSubscriptionPipeline(t);
      if (p.stage !== 'not_requested') return p;
    }
    return pipelineInfo('not_requested', false);
  }, [getSubscriptionPipeline]);

  const toggleTenant = (tenantId: string) => {
    const target = subs.find((s) => s.id === tenantId);
    if (target?.subscription_status === 'cancelled') return;
    setSelectedTenantIds((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  };

  const isLandlordAllSelected = (group: { tenants: WHSubscription[] }) => {
    const active = group.tenants.filter((t) => t.subscription_status !== 'cancelled');
    return active.length > 0 && active.every((t) => selectedTenantIds.has(t.id));
  };

  const isLandlordPartiallySelected = (group: { tenants: WHSubscription[] }) => {
    const active = group.tenants.filter((t) => t.subscription_status !== 'cancelled');
    return active.some((t) => selectedTenantIds.has(t.id)) && !isLandlordAllSelected(group);
  };

  const toggleLandlord = (group: { tenants: WHSubscription[] }) => {
    setSelectedTenantIds((prev) => {
      const next = new Set(prev);
      const active = group.tenants.filter((t) => t.subscription_status !== 'cancelled');
      const allSelected = active.length > 0 && active.every((t) => next.has(t.id));
      if (allSelected) {
        active.forEach((t) => next.delete(t.id));
      } else {
        active.forEach((t) => next.add(t.id));
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
    () => subs.filter((s) => selectedTenantIds.has(s.id) && s.subscription_status !== 'cancelled'),
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
    const active = visibleSubs.filter((s) => s.subscription_status !== 'cancelled');
    if (selectedTenantIds.size === active.length && active.length > 0) {
      setSelectedTenantIds(new Set());
    } else {
      setSelectedTenantIds(new Set(active.map((s) => s.id)));
    }
  };

  const totalReceivable = activeSubs.reduce((a, s) => a + (Number(s.receivable_total) || 0), 0);
  const monthlyReceivable = activeSubs.reduce((a, s) => a + (Number(s.monthly_rent) || 0), 0);
  const pendingConfirmation = activeSubs.filter((s) => !getEnrollStatus(s).ready).length;

  const bodyContent = (
    <div className={cn("space-y-4", !isPage && "p-4")}>
      {/* Stats */}
      <div className="grid grid-cols-2 gap-2.5">
        <Card><CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Enrolled</div>
          <div className="flex items-baseline gap-2">
            <p className="text-xl font-bold">{loading ? '...' : activeSubs.length}</p>
            {declinedSubs.length > 0 && (
              <span className="text-[10px] text-destructive font-medium">
                ({declinedSubs.length} declined)
              </span>
            )}
          </div>
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
          {/* Latest float request rejected: show the reviewer's note */}
          {floatRequests[0]?.status === 'rejected' && floatRequests[0]?.rejection_reason && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl border border-destructive/30 bg-destructive/5">
              <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs">
                <p className="font-semibold text-foreground">
                  Your float request of {formatUGX(Number(floatRequests[0].requested_amount) || 0)} was rejected
                </p>
                <p className="text-muted-foreground mt-0.5">“{floatRequests[0].rejection_reason}”</p>
                <p className="text-muted-foreground mt-1">
                  Your tenants are still enrolled. Select them below and tap Request Float to send a new request.
                </p>
              </div>
            </div>
          )}
          {/* Select All Toolbar */}
          <div className="flex items-center justify-between text-xs px-1 text-muted-foreground">
            <span>
              {landlordGroups.length} {landlordGroups.length === 1 ? 'landlord' : 'landlords'} · {visibleSubs.length} {visibleSubs.length === 1 ? 'tenant' : 'tenants'}
              {declinedSubs.length > 0 && (
                <span className="text-destructive font-medium ml-1">
                  ({declinedSubs.length} declined)
                </span>
              )}
            </span>
            {visibleSubs.some((s) => s.subscription_status !== 'cancelled') && (
              <button
                type="button"
                onClick={handleToggleSelectAll}
                className="text-primary hover:underline font-medium"
              >
                {selectedTenantIds.size === visibleSubs.filter((s) => s.subscription_status !== 'cancelled').length && selectedTenantIds.size > 0
                  ? 'Deselect all'
                  : 'Select all'}
              </button>
            )}
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
                      disabled={group.tenants.every((t) => t.subscription_status === 'cancelled')}
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
                        {/* Landlord Float Pipeline Status */}
                        {(() => {
                          const lp = getLandlordPipeline(group);
                          if (lp.stage === 'not_requested') {
                            return (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal border-amber-500/30 text-amber-600 bg-amber-500/10">
                                Float Not Requested
                              </Badge>
                            );
                          }
                          return (
                            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 font-normal gap-1", lp.badgeClass)}>
                              {lp.isPending ? <Clock className="h-2.5 w-2.5 animate-pulse" />
                                : lp.tone === 'destructive' ? <XCircle className="h-2.5 w-2.5" />
                                : lp.tone === 'success' ? <CheckCircle2 className="h-2.5 w-2.5" />
                                : <AlertCircle className="h-2.5 w-2.5" />}
                              {lp.label}
                            </Badge>
                          );
                        })()}
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
                                  disabled={s.subscription_status === 'cancelled'}
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

                          {/* Declined Reason Notice */}
                          {s.subscription_status === 'cancelled' && (
                            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-destructive/10 border border-destructive/25 text-xs text-destructive">
                              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                              <div className="min-w-0">
                                <p className="font-semibold">Application Declined by Operations</p>
                                <p className="text-[11px] text-destructive/90 mt-0.5">
                                  {s.notes || 'This tenant application was reviewed and declined by operations.'}
                                </p>
                              </div>
                            </div>
                          )}

                          {/* Status and Float Pipeline Badges */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {s.subscription_status === 'cancelled' ? (
                              <Badge variant="outline" className="gap-1 font-semibold border-destructive/40 bg-destructive/10 text-destructive">
                                <XCircle className="h-3 w-3 text-destructive" />
                                Application Declined
                              </Badge>
                            ) : (
                              <>
                                {(() => {
                                  const st = getEnrollStatus(s);
                                  return (
                                    <Badge variant="outline" className={`gap-1 font-normal ${st.className}`}>
                                      {st.ready ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                                      {st.label}
                                    </Badge>
                                  );
                                })()}

                                {(() => {
                                  const fp = getSubscriptionPipeline(s);
                                  return (
                                    <Badge variant="outline" className={cn("gap-1 font-normal", fp.badgeClass)} title={fp.description}>
                                      {fp.isPending ? (
                                        <Clock className="h-3 w-3 animate-pulse text-amber-500" />
                                      ) : fp.tone === 'success' ? (
                                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                      ) : fp.tone === 'destructive' ? (
                                        <XCircle className="h-3 w-3 text-destructive" />
                                      ) : (
                                        <AlertCircle className="h-3 w-3 text-amber-500" />
                                      )}
                                      {fp.label}
                                    </Badge>
                                  );
                                })()}
                              </>
                            )}
                          </div>

                          {/* Float Approval Stepper (Shown while float request traverses pipeline) */}
                          {(() => {
                            const fp = getSubscriptionPipeline(s);
                            if (!fp.isPending) return null;
                            return (
                              <div className="rounded-lg border border-border/60 bg-muted/30 p-2 space-y-1">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="font-semibold text-foreground flex items-center gap-1">
                                    <Clock className="h-3 w-3 text-amber-500 animate-spin" /> Float Approval Flow
                                  </span>
                                  <span className="text-[10px] text-muted-foreground">{fp.label}</span>
                                </div>
                                <div className="grid grid-cols-4 gap-1 text-[10px] pt-0.5">
                                  <div className={cn("text-center py-1 rounded border", fp.stage === 'pending_agent_ops' ? "bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300 font-bold" : "bg-background/50 border-border/40 text-muted-foreground")}>
                                    1. Agent Ops
                                  </div>
                                  <div className={cn("text-center py-1 rounded border", fp.stage === 'pending_tenant_ops' ? "bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300 font-bold" : "bg-background/50 border-border/40 text-muted-foreground")}>
                                    2. Tenant Ops
                                  </div>
                                  <div className={cn("text-center py-1 rounded border", fp.stage === 'pending_coo' ? "bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-300 font-bold" : "bg-background/50 border-border/40 text-muted-foreground")}>
                                    3. COO
                                  </div>
                                  <div className={cn("text-center py-1 rounded border", fp.stage === 'pending_cfo' ? "bg-purple-500/20 border-purple-500/40 text-purple-700 dark:text-purple-300 font-bold" : "bg-background/50 border-border/40 text-muted-foreground")}>
                                    4. CFO Allocates
                                  </div>
                                </div>
                              </div>
                            );
                          })()}

                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <div><span className="text-muted-foreground">Rent</span><br /><span className="font-semibold">{formatUGX(s.monthly_rent)}</span></div>
                            <div><span className="text-muted-foreground">Outstanding</span><br /><span className="font-semibold text-orange-600">{formatUGX(s.outstanding_balance)}</span></div>
                            <div><span className="text-muted-foreground">Payout day</span><br /><span className="font-semibold">{s.payout_day}</span></div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-1">
                            {!s.tenant_verified && s.subscription_status !== 'cancelled' && (
                              <Button size="sm" className="gap-1.5 col-span-2 h-8 text-xs"
                                onClick={() => setVerifyFor(s)}>
                                <ShieldCheck className="h-3.5 w-3.5" /> Verify
                              </Button>
                            )}
                            {(() => {
                              if (s.subscription_status === 'cancelled') {
                                return (
                                  <Button size="sm" variant="outline" disabled className="gap-1.5 h-8 text-xs text-destructive border-destructive/30 bg-destructive/5 cursor-not-allowed">
                                    <XCircle className="h-3.5 w-3.5" /> Declined
                                  </Button>
                                );
                              }
                              const fp = getSubscriptionPipeline(s);
                              if (fp.canCollect) {
                                return (
                                  <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs"
                                    disabled={s.outstanding_balance <= 0}
                                    onClick={() => setAllocFor(s)}>
                                    <Receipt className="h-3.5 w-3.5 text-primary" /> Collect Rent
                                  </Button>
                                );
                              }
                              if (!fp.canRequestFloat) {
                                return (
                                  <Button size="sm" variant="outline" disabled className="gap-1.5 h-8 text-xs bg-muted/40 text-muted-foreground border-border/60 cursor-not-allowed">
                                    <Clock className="h-3.5 w-3.5 text-amber-500 animate-pulse" /> Awaiting Float
                                  </Button>
                                );
                              }
                              return (
                                <Button size="sm" className="gap-1.5 h-8 text-xs bg-primary text-primary-foreground font-semibold shadow-xs"
                                  onClick={() => {
                                    setSelectedTenantIds(new Set([s.id]));
                                    setRequestFloatOpen(true);
                                  }}>
                                  <Banknote className="h-3.5 w-3.5" /> {fp.stage === 'request_rejected' ? 'Request Float Again' : 'Request Float'}
                                </Button>
                              );
                            })()}
                            {(() => {
                              if (getSubscriptionPipeline(s).isLocked) {
                                return (
                                  <Badge
                                    variant="outline"
                                    className="gap-1 h-8 px-2 justify-center text-[11px] text-muted-foreground border-border/60 bg-muted/20 font-normal select-none"
                                    title={collectionsUnknown
                                      ? 'Payment history could not be loaded, so Delete is unavailable'
                                      : 'Plans with collections, a float request or funding cannot be deleted'}
                                  >
                                    <Lock className="h-3 w-3 text-muted-foreground" /> Non-deletable Plan
                                  </Badge>
                                );
                              }
                              return (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="gap-1.5 h-8 text-xs text-destructive hover:bg-destructive/10 border-destructive/30"
                                  onClick={() => setDeleteFor(s)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" /> Delete
                                </Button>
                              );
                            })()}
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
                if (getSubscriptionPipeline(deleteFor).isLocked) {
                  toast({
                    title: 'This plan cannot be deleted',
                    description: 'It has collections, a float request or funding recorded.',
                    variant: 'destructive',
                  });
                  setDeleteFor(null);
                  return;
                }
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
      setNotes(`For: ${landlordNames}`);
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
      // Sends the exact tenants (subscription IDs) this request covers; the server computes the amount.
      const result = await requestWelileHomesFloat({
        agentId,
        subscriptionIds: selectedTenants.map((s) => s.id),
        legacyAmount: totalAmount,
        tenantCount: selectedTenants.length,
        recipientPhone: phone,
        notes,
      });
      const data = { id: result.requestId };

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
  passportUrl?: string | null;
  housePhotos?: string[];
  gps?: CapturedGps | null;
  ugLocation?: UgLocationSelection | null;
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

  // Landlord photo, house photos, Uganda location, and live GPS
  const passportCameraRef = useRef<HTMLInputElement>(null);
  const passportGalleryRef = useRef<HTMLInputElement>(null);
  const houseCameraRef = useRef<HTMLInputElement>(null);
  const houseGalleryRef = useRef<HTMLInputElement>(null);

  const [passportPhoto, setPassportPhoto] = useState<{ file: File; previewUrl: string } | null>(null);
  const [housePhotos, setHousePhotos] = useState<{ id: string; file: File; previewUrl: string }[]>([]);
  const [ugLocation, setUgLocation] = useState<UgLocationSelection | null>(null);
  const [optimizingImage, setOptimizingImage] = useState(false);

  // Selected landlord details
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [selectedLandlordRecord, setSelectedLandlordRecord] = useState<LandlordRecord | null>(null);

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
            .select('id, name, phone, property_address, description, receipt_request_channel, district, county, sub_county, village, cell, ug_village_id, latitude, longitude')
            .or(`registered_by.eq.${agentId},managed_by_agent_id.eq.${agentId}`)
            .order('created_at', { ascending: false })
            .limit(300);

          (myDbLandlords || []).forEach((row: any) => {
            const name = (row.name || '').trim();
            const p = (row.phone || '').trim();
            if (!name) return;
            const key = `${name.toLowerCase()}|${p}`;

            let passportUrl: string | null = null;
            let housePhotoUrls: string[] = [];
            let gps: CapturedGps | null = null;
            let ugLoc: UgLocationSelection | null = null;

            if (typeof row.latitude === 'number' && typeof row.longitude === 'number') {
              gps = { latitude: row.latitude, longitude: row.longitude, accuracy: null };
            }
            if (row.village || row.district) {
              ugLoc = {
                villageId: row.ug_village_id || 0, parishId: 0, subcountyId: 0, countyId: 0, districtId: 0,
                village: row.village || '',
                parish: row.cell || '',
                subcounty: row.sub_county || '',
                county: row.county || '',
                district: row.district || '',
                region: row.region || '',
                fullPath: [row.village, row.sub_county, row.district].filter(Boolean).join(', '),
              };
            }
            try {
              if (row.description && row.description.startsWith('{')) {
                const meta = JSON.parse(row.description);
                if (meta.passport_photo || meta.passportUrl) passportUrl = meta.passport_photo || meta.passportUrl;
                if (Array.isArray(meta.house_photos)) housePhotoUrls = meta.house_photos;
                if (meta.gps) gps = meta.gps;
                if (meta.ug_location) ugLoc = meta.ug_location;
              }
            } catch {
              // ignore json parse error
            }

            map.set(key, {
              id: row.id,
              name,
              phone: p,
              address: row.property_address || '',
              count: 0,
              passportUrl,
              housePhotos: housePhotoUrls,
              gps,
              ugLocation: ugLoc,
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
                  if (row.passportUrl && !existing.passportUrl) existing.passportUrl = row.passportUrl;
                  if (row.housePhotos && (!existing.housePhotos || existing.housePhotos.length === 0)) existing.housePhotos = row.housePhotos;
                  if (row.gps && !existing.gps) existing.gps = row.gps;
                  if (row.ugLocation && !existing.ugLocation) existing.ugLocation = row.ugLocation;
                } else {
                  map.set(key, {
                    id: row.id,
                    name,
                    phone: p,
                    address: row.address || '',
                    count: 0,
                    passportUrl: row.passportUrl || null,
                    housePhotos: row.housePhotos || [],
                    gps: row.gps || null,
                    ugLocation: row.ugLocation || null,
                  });
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
    setSelectedLandlordRecord(null);
    setLandlordQuery('');
    setNewLandlordName('');
    setNewLandlordPhone('');
    setNewLandlordAddress('');
    if (passportPhoto?.previewUrl) {
      URL.revokeObjectURL(passportPhoto.previewUrl);
    }
    setPassportPhoto(null);
    housePhotos.forEach((h) => URL.revokeObjectURL(h.previewUrl));
    setHousePhotos([]);
    setUgLocation(null);
  };

  const handlePassportFile = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid image', description: 'Please choose an image file (JPG, PNG, WebP).', variant: 'destructive' });
      return;
    }
    setOptimizingImage(true);
    try {
      const optimized = await optimizeImage(file, { maxWidth: 900, maxHeight: 900, quality: 0.85 });
      if (passportPhoto?.previewUrl) {
        URL.revokeObjectURL(passportPhoto.previewUrl);
      }
      setPassportPhoto({ file: optimized.file, previewUrl: optimized.previewUrl });
      toast({ title: 'Passport photo attached 🪪' });
    } catch (e: any) {
      toast({ title: 'Could not process photo', description: e.message, variant: 'destructive' });
    } finally {
      setOptimizingImage(false);
    }
  };

  const handleRemovePassportPhoto = () => {
    if (passportPhoto?.previewUrl) {
      URL.revokeObjectURL(passportPhoto.previewUrl);
    }
    setPassportPhoto(null);
  };

  const handleHouseFiles = async (files?: FileList | null) => {
    if (!files || files.length === 0) return;
    const remaining = 5 - housePhotos.length;
    if (remaining <= 0) {
      toast({ title: 'Photo limit reached', description: 'You can upload up to 5 photos of the house.', variant: 'destructive' });
      return;
    }
    const toProcess = Array.from(files).slice(0, remaining);
    setOptimizingImage(true);
    try {
      const newItems: { id: string; file: File; previewUrl: string }[] = [];
      for (const f of toProcess) {
        if (!f.type.startsWith('image/')) continue;
        const optimized = await optimizeImage(f, { maxWidth: 1200, maxHeight: 1200, quality: 0.8 });
        newItems.push({
          id: `himg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          file: optimized.file,
          previewUrl: optimized.previewUrl,
        });
      }
      setHousePhotos((prev) => [...prev, ...newItems]);
      toast({ title: `${newItems.length} house photo(s) added 🏠` });
    } catch (e: any) {
      toast({ title: 'Could not process photos', description: e.message, variant: 'destructive' });
    } finally {
      setOptimizingImage(false);
    }
  };

  const handleRemoveHousePhoto = (id: string) => {
    setHousePhotos((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((x) => x.id !== id);
    });
  };

  const handleSelectLandlord = (l: LandlordRecord) => {
    const isCurrentlySelected =
      landlordName.trim().toLowerCase() === l.name.trim().toLowerCase() &&
      (!landlordPhone || landlordPhone.trim() === (l.phone || '').trim());

    if (isCurrentlySelected) {
      // Deselect
      setLandlordName('');
      setLandlordPhone('');
      setSelectedLandlordRecord(null);
    } else {
      // Select
      setLandlordName(l.name);
      setLandlordPhone(l.phone);
      setSelectedLandlordRecord(l);
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
          supabase.from('rent_requests').select('id').eq('landlord_id', l.id).in('status', ACTIVE_RENT_STATUSES).limit(1),
          supabase.from('landlords').select('tenant_id').eq('id', l.id).not('tenant_id', 'is', null).limit(1),
          supabase.from('agent_landlord_float_allocations').select('id').eq('landlord_id', l.id).limit(1),
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
    if (!selectedLandlordRecord) {
      const match = landlords.find(
        (l) => l.name.trim().toLowerCase() === landlordName.trim().toLowerCase()
      );
      if (match) setSelectedLandlordRecord(match);
    }
    setStep('tenant');
  };

  const handleSaveNewLandlord = async () => {
    const name = newLandlordName.trim();
    const p = newLandlordPhone.trim();
    const landmark = newLandlordAddress.trim();

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
    let uploadedPassportUrl: string | null = null;
    const uploadedHouseUrls: string[] = [];

    try {
      // 1. Upload landlord passport photo if provided
      if (passportPhoto?.file) {
        try {
          const path = `landlords/${agentId || 'agent'}/${Date.now()}_passport_${Math.random().toString(36).slice(2, 7)}.webp`;
          const { error: upErr } = await supabase.storage
            .from('house-images')
            .upload(path, passportPhoto.file, { contentType: 'image/webp', upsert: true });
          if (!upErr) {
            uploadedPassportUrl = supabase.storage.from('house-images').getPublicUrl(path).data.publicUrl;
          }
        } catch (e) {
          console.warn('Storage upload error for passport photo:', e);
        }
      }

      // 2. Upload house photos if provided
      for (let i = 0; i < housePhotos.length; i++) {
        try {
          const item = housePhotos[i];
          const path = `landlords/${agentId || 'agent'}/${Date.now()}_house_${i}_${Math.random().toString(36).slice(2, 7)}.webp`;
          const { error: upErr } = await supabase.storage
            .from('house-images')
            .upload(path, item.file, { contentType: 'image/webp', upsert: true });
          if (!upErr) {
            const pubUrl = supabase.storage.from('house-images').getPublicUrl(path).data.publicUrl;
            uploadedHouseUrls.push(pubUrl);
          }
        } catch (e) {
          console.warn(`Storage upload error for house photo ${i}:`, e);
        }
      }

      // 3. Format address from Uganda location + landmark
      const addressParts = [
        landmark,
        ugLocation?.village,
        ugLocation?.parish,
        ugLocation?.subcounty,
        ugLocation?.district,
      ].filter(Boolean);
      const finalAddress = addressParts.join(', ') || 'Welile Homes Property';

      const metadataObj = {
        welile_homes: true,
        passport_photo: uploadedPassportUrl || passportPhoto?.previewUrl || null,
        house_photos: uploadedHouseUrls.length > 0 ? uploadedHouseUrls : housePhotos.map((h) => h.previewUrl),
        ug_location: ugLocation,
        landmark: landmark || null,
        registered_at: new Date().toISOString(),
      };

      if (agentId) {
        try {
          const { data: inserted, error: insertErr } = await supabase
            .from('landlords')
            .insert({
              name,
              phone: p,
              property_address: finalAddress,
              district: ugLocation?.district || null,
              county: ugLocation?.county || null,
              sub_county: ugLocation?.subcounty || null,
              village: ugLocation?.village || null,
              region: ugLocation?.region || null,
              ug_village_id: ugLocation?.villageId || null,
              latitude: null,
              longitude: null,
              location_captured_at: null,
              location_captured_by: null,
              registered_by: agentId,
              managed_by_agent_id: agentId,
              is_agent_managed: true,
              has_smartphone: false,
              ready_to_receive: false,
              description: JSON.stringify(metadataObj),
              receipt_request_channel: 'welile_homes',
              service_center_comment: 'Welile Homes Landlord',
            })
            .select('id')
            .maybeSingle();

          if (inserted?.id) {
            createdId = inserted.id;
          }
          if (insertErr) {
            console.warn('Could not insert landlord record:', insertErr);
          }
        } catch (err: any) {
          console.warn('Could not mirror landlord record to landlords table:', err);
        }
      }

      const newRecord: LandlordRecord = {
        id: createdId,
        name,
        phone: p,
        address: finalAddress,
        count: 0,
        passportUrl: uploadedPassportUrl || passportPhoto?.previewUrl || null,
        housePhotos: uploadedHouseUrls.length > 0 ? uploadedHouseUrls : housePhotos.map((h) => h.previewUrl),
        gps: null,
        ugLocation,
      };

      // 4. Save locally
      try {
        const storedKey = `welile_homes_landlords_${agentId}`;
        const existingRaw = localStorage.getItem(storedKey);
        const existingList = existingRaw ? JSON.parse(existingRaw) : [];
        const updatedList = [
          newRecord,
          ...existingList.filter((x: any) => `${(x.name || '').toLowerCase()}|${x.phone}` !== `${name.toLowerCase()}|${p}`),
        ];
        localStorage.setItem(storedKey, JSON.stringify(updatedList));
      } catch {
        // ignore storage error
      }

      // 5. Add to local state & select
      setLandlords((prev) => [
        newRecord,
        ...prev.filter((x) => `${x.name.toLowerCase()}|${x.phone}` !== `${name.toLowerCase()}|${p}`),
      ]);

      setLandlordName(name);
      setLandlordPhone(p);
      setSelectedLandlordRecord(newRecord);

      toast({
        title: 'Landlord registered successfully 🏡',
        description: `${name} has been enrolled with house details. Now enter tenant details to proceed.`,
      });
      setStep('tenant');
    } catch (err: any) {
      toast({
        title: 'Registration saved locally',
        description: err.message || 'Proceeding to tenant details.',
      });
      setStep('tenant');
    } finally {
      setSavingLandlord(false);
    }
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
        p_landlord_id: selectedLandlordRecord?.id || null,
        p_landlord_name: landlordName || null,
        p_landlord_phone: landlordPhone || null,
        p_notes: JSON.stringify({
          welile_homes: true,
          landlord_name: landlordName,
          landlord_phone: landlordPhone,
          property_address: selectedLandlordRecord?.address || null,
          ug_location: selectedLandlordRecord?.ugLocation || null,
          gps: selectedLandlordRecord?.gps || null,
          house_photos: selectedLandlordRecord?.housePhotos || [],
          landlord_passport: selectedLandlordRecord?.passportUrl || null,
        }),
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
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            {l.passportUrl ? (
                              <img
                                src={l.passportUrl}
                                alt={l.name}
                                className="h-9 w-9 rounded-full object-cover border border-primary/30 shrink-0"
                              />
                            ) : (
                              <div className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 font-semibold text-xs">
                                {l.name.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-foreground truncate flex items-center gap-1.5">
                                {l.name}
                                {isSelected && (
                                  <Badge variant="default" className="text-[9px] h-4 px-1 py-0 font-normal">
                                    Selected
                                  </Badge>
                                )}
                                {l.gps && (
                                  <span className="text-[9px] font-normal text-emerald-600 bg-emerald-500/10 px-1 py-0.2 rounded shrink-0">
                                    📍 GPS
                                  </span>
                                )}
                              </p>
                              <p className="text-muted-foreground truncate text-[11px]">
                                {l.phone || 'No phone'}
                                {l.address ? ` · ${l.address}` : ''}
                              </p>
                            </div>
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
              <TabsContent value="register" className="space-y-4 pt-2">
                {/* Hidden File Inputs */}
                <input
                  ref={passportCameraRef}
                  type="file"
                  accept="image/*"
                  capture="user"
                  className="hidden"
                  onChange={(e) => {
                    handlePassportFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={passportGalleryRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    handlePassportFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={houseCameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    handleHouseFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={houseGalleryRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    handleHouseFiles(e.target.files);
                    e.target.value = '';
                  }}
                />

                {/* 1. Landlord Identity & Passport Photo */}
                <div className="rounded-xl border bg-card p-3.5 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between border-b pb-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Building2 className="h-4 w-4 text-primary" />
                      <span>Landlord Information</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-normal">
                      Step 1 of 2
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  </div>

                  {/* Landlord Passport Photo */}
                  <div className="pt-1 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs flex items-center gap-1.5 font-medium">
                        <span>🪪 Landlord Passport / Face Photo</span>
                        {passportPhoto && (
                          <span className="text-[10px] text-emerald-600 font-normal">✓ Photo attached</span>
                        )}
                      </Label>
                    </div>

                    {passportPhoto ? (
                      <div className="flex items-center gap-3 p-2.5 rounded-lg border bg-muted/30">
                        <div className="relative h-20 w-16 rounded-md overflow-hidden border border-border shrink-0 shadow-xs">
                          <img
                            src={passportPhoto.previewUrl}
                            alt="Landlord Passport"
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={handleRemovePassportPhoto}
                            className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] shadow"
                            title="Remove photo"
                          >
                            ✕
                          </button>
                        </div>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <p className="text-xs font-medium text-foreground">Landlord photo captured</p>
                          <p className="text-[11px] text-muted-foreground leading-tight">
                            Passport headshot saved. Used for Landlord Ops identity verification.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 text-[11px] px-2 gap-1"
                              onClick={() => passportCameraRef.current?.click()}
                              disabled={optimizingImage}
                            >
                              <Camera className="h-3 w-3" /> Retake
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[11px] px-2 text-destructive hover:bg-destructive/10"
                              onClick={handleRemovePassportPhoto}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3 rounded-lg border border-dashed bg-muted/20 space-y-2">
                        <p className="text-[11px] text-muted-foreground">
                          Take a clear live photo of the landlord or upload their passport photo headshot.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs gap-1.5 flex-1"
                            onClick={() => passportCameraRef.current?.click()}
                            disabled={optimizingImage}
                          >
                            <Camera className="h-3.5 w-3.5 text-primary" />
                            <span>Take Live Photo</span>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs gap-1.5 flex-1"
                            onClick={() => passportGalleryRef.current?.click()}
                            disabled={optimizingImage}
                          >
                            <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Upload Photo</span>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. Official Location of the House (District -> Village) */}
                <div className="rounded-xl border bg-card p-3.5 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between border-b pb-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <MapPin className="h-4 w-4 text-primary" />
                      <span>House Location (Uganda Hierarchy)</span>
                    </div>
                    <span className="text-[11px] text-muted-foreground">District → Village</span>
                  </div>

                  <UgLocationPicker
                    value={ugLocation}
                    onChange={setUgLocation}
                    defaultMode="cascade"
                    label="Official House Location"
                  />

                  <div>
                    <Label className="text-xs">Plot / Landmark / House Number (optional)</Label>
                    <Input
                      value={newLandlordAddress}
                      onChange={(e) => setNewLandlordAddress(e.target.value)}
                      placeholder="e.g. Near Total Petrol Station, Plot 14, Blue Gate"
                      className="mt-1"
                    />
                  </div>
                </div>

                {/* 4. House / Property Photos */}
                <div className="rounded-xl border bg-card p-3.5 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between border-b pb-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Home className="h-4 w-4 text-primary" />
                      <span>House Photos ({housePhotos.length}/5)</span>
                    </div>
                    <span className="text-[11px] text-muted-foreground">Exterior / Entrance</span>
                  </div>

                  {housePhotos.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-1 pt-0.5 snap-x">
                      {housePhotos.map((item, idx) => (
                        <div
                          key={item.id}
                          className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border shadow-xs"
                        >
                          <img
                            src={item.previewUrl}
                            alt={`House photo ${idx + 1}`}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveHousePhoto(item.id)}
                            className="absolute top-1 right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] shadow"
                            title="Remove photo"
                          >
                            ✕
                          </button>
                          <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] text-center py-0.5">
                            Photo {idx + 1}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1.5 flex-1"
                      onClick={() => houseCameraRef.current?.click()}
                      disabled={housePhotos.length >= 5 || optimizingImage}
                    >
                      <Camera className="h-3.5 w-3.5 text-primary" />
                      <span>Take Live Photo</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1.5 flex-1"
                      onClick={() => houseGalleryRef.current?.click()}
                      disabled={housePhotos.length >= 5 || optimizingImage}
                    >
                      <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>Upload Photos</span>
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Take live photos or upload pictures of the front facade, side views, or compound.
                  </p>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Once registered, this landlord, location, GPS, and photos will be linked and saved for tenant registration.
                </p>

                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    onClick={handleSaveNewLandlord}
                    disabled={savingLandlord || !newLandlordName.trim() || !newLandlordPhone.trim()}
                    className="w-full gap-2 h-11"
                  >
                    {savingLandlord ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Saving Landlord & Uploading Photos...</span>
                      </>
                    ) : (
                      <>
                        <UserCheck className="h-4 w-4" />
                        <span>Save Landlord & Continue to Tenant →</span>
                      </>
                    )}
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
                {selectedLandlordRecord?.passportUrl ? (
                  <img
                    src={selectedLandlordRecord.passportUrl}
                    alt={landlordName}
                    className="h-10 w-10 shrink-0 rounded-full object-cover border border-primary/40 shadow-xs"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Building2 className="h-5 w-5" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-[10px] uppercase font-semibold text-primary tracking-wider flex items-center gap-1.5">
                    <span>Landlord</span>
                    {selectedLandlordRecord?.gps && (
                      <span className="text-[9px] font-normal text-emerald-600 bg-emerald-500/10 px-1 py-0.2 rounded">
                        📍 GPS
                      </span>
                    )}
                  </p>
                  <p className="text-sm font-bold text-foreground truncate">{landlordName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {landlordPhone || 'No phone on file'}
                    {selectedLandlordRecord?.address ? ` · ${selectedLandlordRecord.address}` : ''}
                  </p>
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

// ---------------- Record Collection dialog ----------------
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
        p_notes: `Agent collection — rent for ${periodLabel}`,
      });
      if (error) throw error;
      const res = data as any;
      if (!res?.success) throw new Error(res?.error || 'Collection recording failed');
      toast({ title: 'Rent payment recorded', description: `${formatUGX(res.amount_collected)} · you earned ${formatUGX(res.agent_commission)}` });
      // Fire-and-forget: send the tenant an SMS receipt for this collection.
      supabase.functions.invoke('welile-homes-sms-dispatch', { body: { since_minutes: 10 } }).catch(() => { });
      onClose();
      onDone();
    } catch (err: any) {
      toast({ title: 'Collection failed', description: err.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={!!sub} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record rent collection — {sub?.tenant_name}</DialogTitle>
          <DialogDescription>
            Records cash collected from the tenant into the system. Outstanding: {sub ? formatUGX(sub.outstanding_balance) : ''}.
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
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Receipt className="h-4 w-4 mr-2" />} Record Collection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AgentWelileHomesSheet;