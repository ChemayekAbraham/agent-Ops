import { useState, useEffect, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
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
import { Home, Loader2, Plus, Banknote, TrendingUp, Users, Clock, Search, CheckCircle2, ShieldCheck, RefreshCw, ArrowLeft, Pencil, History, Trash2, ChevronDown } from 'lucide-react';
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentWelileHomesSheet({ open, onOpenChange }: AgentWelileHomesSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [subs, setSubs] = useState<WHSubscription[]>([]);
  const [earned, setEarned] = useState(0);
  const [pendingPayouts, setPendingPayouts] = useState(0);
  const [recentPayments, setRecentPayments] = useState<RecentRentPayment[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [allocFor, setAllocFor] = useState<WHSubscription | null>(null);
  const [editFor, setEditFor] = useState<WHSubscription | null>(null);
  const [verifyFor, setVerifyFor] = useState<WHSubscription | null>(null);
  const [deleteFor, setDeleteFor] = useState<WHSubscription | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data: rows, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, monthly_rent, outstanding_balance, receivable_total, has_smartphone, landlord_uses_wallet, payout_day, next_due_date, landlord_name, created_at')
        .eq('agent_id', user.id)
        .eq('mode', 'agent_collection')
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

  useEffect(() => { if (open) load(); }, [open, load]);

  const totalReceivable = subs.reduce((a, s) => a + (Number(s.receivable_total) || 0), 0);
  const [receivablePeriod, setReceivablePeriod] = useState<'monthly' | 'yearly'>('yearly');
  const monthlyReceivable = subs.reduce((a, s) => a + (Number(s.monthly_rent) || 0), 0);
  const pendingConfirmation = subs.filter((s) => !getEnrollStatus(s).ready).length;
  const [searchOpen, setSearchOpen] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const visibleSubs = (() => {
    const q = listQuery.trim().toLowerCase();
    if (!q) return subs;
    return subs.filter((s) =>
      (s.tenant_name ?? '').toLowerCase().includes(q) ||
      (s.tenant_phone ?? '').toLowerCase().includes(q) ||
      (s.landlord_name ?? '').toLowerCase().includes(q),
    );
  })();

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="sticky top-0 z-10 bg-background border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2">
              <Home className="h-5 w-5 text-primary" /> Welile Homes
            </SheetTitle>
          </SheetHeader>

          <div className="p-4 space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-2.5">
              <Card><CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Enrolled</div>
                <p className="text-xl font-bold">{subs.length}</p>
              </CardContent></Card>
              <Card><CardContent className="p-3">
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Banknote className="h-3.5 w-3.5" /> Receivable</div>
                  <div className="flex items-center rounded-md border border-border/60 overflow-hidden">
                    {(['monthly', 'yearly'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setReceivablePeriod(p)}
                        className={`px-1.5 py-0.5 text-[10px] font-medium capitalize transition-colors ${
                          receivablePeriod === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {p === 'monthly' ? 'M' : 'Y'}
                      </button>
                    ))}
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

            <div className="flex gap-2">
              <Button className="flex-1 gap-2" onClick={() => setEnrollOpen(true)}>
                <Plus className="h-4 w-4" /> Enroll a tenant
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Search enrolled tenants"
                onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setListQuery(''); }}
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>

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
              <div className="space-y-2.5">
                {visibleSubs.map((s) => (
                  <Card key={s.id}>
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          aria-expanded={historyOpenId === s.id}
                          onClick={() => setHistoryOpenId((id) => (id === s.id ? null : s.id))}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="flex items-center gap-1 font-semibold truncate">
                            <span className="truncate">{s.tenant_name}</span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${historyOpenId === s.id ? 'rotate-180' : ''}`}
                            />
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {s.tenant_phone}{s.tenant_phone ? ' · ' : ''}Tap for payment history
                          </p>
                        </button>
                        {!s.has_smartphone && <Badge variant="outline" className="shrink-0">No phone</Badge>}
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
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Badge variant="secondary" className="font-normal">
                          {s.landlord_uses_wallet ? 'Landlord: Welile wallet' : `Landlord float${s.landlord_name ? ` · ${s.landlord_name}` : ''}`}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {!s.tenant_verified && (
                          <Button size="sm" className="gap-1.5 col-span-3"
                            onClick={() => setVerifyFor(s)}>
                            <ShieldCheck className="h-3.5 w-3.5" /> Verify
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="gap-1.5"
                          onClick={() => setEditFor(s)}>
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5"
                          disabled={s.outstanding_balance <= 0}
                          onClick={() => setAllocFor(s)}>
                          <Banknote className="h-3.5 w-3.5" /> Allocate
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:bg-destructive/10 border-destructive/30"
                          onClick={() => setDeleteFor(s)}>
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} agentId={user?.id} onDone={load} />
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

// ---------------- Enroll dialog ----------------
function EnrollDialog({ open, onOpenChange, agentId, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; agentId?: string; onDone: () => void;
}) {
  const { toast } = useToast();
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
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Existing Welile Homes landlords, for quick reuse instead of retyping.
  const [landlords, setLandlords] = useState<{ name: string; phone: string; count: number }[]>([]);
  const [landlordQuery, setLandlordQuery] = useState('');
  const [loadingLandlords, setLoadingLandlords] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingLandlords(true);
      try {
        const { data } = await supabase
          .from('welile_homes_subscriptions')
          .select('landlord_name, landlord_phone')
          .not('landlord_name', 'is', null)
          .order('created_at', { ascending: false })
          .limit(500);
        if (cancelled) return;
        const map = new Map<string, { name: string; phone: string; count: number }>();
        (data || []).forEach((row: any) => {
          const name = (row.landlord_name || '').trim();
          const phone = (row.landlord_phone || '').trim();
          if (!name) return;
          const key = `${name.toLowerCase()}|${phone}`;
          const existing = map.get(key);
          if (existing) existing.count += 1;
          else map.set(key, { name, phone, count: 1 });
        });
        setLandlords(Array.from(map.values()).sort((a, b) => b.count - a.count));
      } finally {
        if (!cancelled) setLoadingLandlords(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const filteredLandlords = landlords.filter((l) => {
    const q = landlordQuery.trim().toLowerCase();
    if (!q) return true;
    return l.name.toLowerCase().includes(q) || l.phone.includes(q.replace(/\s/g, ''));
  });

  const reset = () => {
    setPhone(''); setSearched(false); setTenant(null); setNewName(''); setNewNationalId('');
    setRent(''); setPayoutDay('5');
    setHasPhone(true); setLandlordUsesWallet(false); setLandlordName(''); setLandlordPhone('');
    setLandlordQuery('');
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

  // Validate the form, then save the enrollment immediately. No SMS is sent
  // here — verification is a separate, manual step from the tenant list.
  const submit = async () => {
    if (!agentId) return;
    const coreError = validateEnrollmentCore({ rent, payoutDay, hasSmartphone: hasPhone });
    if (coreError) { toast({ title: coreError, variant: 'destructive' }); return; }
    // Require either a found tenant, or enough info to create a new one.
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
      // Auto-create the tenant account when no existing profile was found.
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enroll tenant in Welile Homes</DialogTitle>
          <DialogDescription>Rent is booked as receivable × 12 months. You earn 2% of every month's rent.</DialogDescription>
        </DialogHeader>
        <>
        <div className="space-y-3">
          <div>
            <Label>Tenant phone</Label>
            <div className="flex gap-2">
              <Input
                value={phone}
                onChange={(e) => { setPhone(e.target.value); setSearched(false); setTenant(null); }}
                placeholder="07..."
              />
              <Button type="button" variant="outline" onClick={findTenant} disabled={searching}>
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>
            {tenant && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> {tenant.full_name} · {tenant.phone}
              </div>
            )}
            {searched && !tenant && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                No registered tenant with that phone — a new account will be created below. You can verify their phone afterwards from the tenant list.
              </p>
            )}
          </div>
          {searched && !tenant && (
            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <p className="text-xs font-medium text-muted-foreground">Create new tenant</p>
              <div>
                <Label>Tenant full name</Label>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="First Last" />
              </div>
              <div>
                <Label>National ID (optional)</Label>
                <Input value={newNationalId} onChange={(e) => setNewNationalId(e.target.value)} placeholder="CM..." />
              </div>
            </div>
          )}
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
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div><p className="text-sm font-medium">Landlord uses Welile wallet</p><p className="text-xs text-muted-foreground">Off = paid to your landlord float</p></div>
            <Switch checked={landlordUsesWallet} onCheckedChange={setLandlordUsesWallet} />
          </div>
          {!landlordUsesWallet && (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Registered Welile Homes landlords</p>
                {loadingLandlords && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={landlordQuery}
                  onChange={(e) => setLandlordQuery(e.target.value)}
                  placeholder="Search landlord by name or phone"
                  className="h-9 pl-8 text-sm"
                />
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {filteredLandlords.length === 0 && !loadingLandlords && (
                  <p className="py-2 text-xs text-muted-foreground">
                    {landlords.length === 0 ? 'No landlords enrolled yet — type the details below.' : 'No match. Type the details below.'}
                  </p>
                )}
                {filteredLandlords.map((l) => {
                  const selected = landlordName.trim().toLowerCase() === l.name.toLowerCase()
                    && (landlordPhone.trim() === l.phone);
                  return (
                    <button
                      key={`${l.name}|${l.phone}`}
                      type="button"
                      onClick={() => { setLandlordName(l.name); setLandlordPhone(l.phone); }}
                      className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${selected ? 'border-primary bg-primary/10' : 'hover:bg-muted'}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{l.name}</span>
                        <span className="block truncate text-muted-foreground">{l.phone || 'No phone on file'}</span>
                      </span>
                      {selected
                        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                        : <Badge variant="secondary" className="shrink-0 text-[10px]">{l.count}</Badge>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {!landlordUsesWallet && (
            <div className="grid grid-cols-2 gap-2">
              <div><Label>Landlord name</Label><Input value={landlordName} onChange={(e) => setLandlordName(e.target.value)} /></div>
              <div><Label>Landlord phone</Label><Input value={landlordPhone} onChange={(e) => setLandlordPhone(e.target.value)} /></div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={submitting || (!tenant && !(searched && newName.trim().length >= 2))}
            className="w-full"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Enroll tenant
          </Button>
        </DialogFooter>
        </>
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
        }).catch(() => {});
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
      supabase.functions.invoke('welile-homes-sms-dispatch', { body: { since_minutes: 10 } }).catch(() => {});
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