import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ShieldCheck, Wallet, User, Filter, X, Loader2, XCircle, Mail, AlertTriangle, History, ScrollText, KeyRound } from 'lucide-react';
import { CalendarIcon } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format } from 'date-fns';
import { TidVerification } from './TidVerification';
import { FieldDepositVerificationQueue } from './FieldDepositVerificationQueue';
import { RecentlyVerifiedList } from './RecentlyVerifiedList';
import { RejectedFieldDepositsList } from './RejectedFieldDepositsList';
import { EmailAutoMatchPanel } from './EmailAutoMatchPanel';
import { PendingUserDepositsPanel } from './PendingUserDepositsPanel';
import { EmailNeedsReviewPanel } from './EmailNeedsReviewPanel';
import { EmailMatchAuditLogPanel } from './EmailMatchAuditLogPanel';
import { DepositDecisionAuditPanel } from './DepositDecisionAuditPanel';
import { supabase } from '@/integrations/supabase/client';
import type { DepositChannel } from '@/lib/fieldDepositBatches';
import { cn } from '@/lib/utils';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { VerifyDepositsChecklist } from './VerifyDepositsChecklist';
import type { LucideIcon } from 'lucide-react';

/**
 * Compact, mobile-friendly section heading used inside the User Deposits tab.
 * Gives every panel a clear icon + title + one-line explanation so operators
 * who skim never have to guess what they're looking at.
 */
function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 px-1 pb-2 pt-1">
      <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm sm:text-base font-bold tracking-tight leading-tight">
          {title}
        </h3>
        {subtitle && (
          <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One place to verify every deposit that reaches the platform — whether it
 * came from a tenant/funder topping up their own wallet (TID-based) or from
 * a field agent depositing collected cash to a merchant code.
 *
 * Per CFO mandate: Financial Ops should never have to remember which queue
 * to open. A single button on the dashboard lands here, and the two tabs
 * surface the live pending counts so the team can drain whichever queue is
 * fuller first.
 */
export function VerifyDepositsHub() {
  const [tab, setTab] = useState<'user' | 'field' | 'rejected'>('user');
  const [counts, setCounts] = useState<{ user: number; field: number; rejected: number }>({ user: 0, field: 0, rejected: 0 });
  // Honor the shared Financial Ops auto-refresh toggle. When the operator
  // pauses on the Wallet card, the badges here freeze too — no surprise
  // count changes mid-review.
  const autoRefresh = useFinOpsAutoRefresh();
  // Hub-level filters — apply across both tabs so the operator can scope the
  // queue to a single channel (e.g. only MTN) and an amount window before
  // verifying. Channels are limited to MTN, Airtel and Bank as requested;
  // cash-merchant batches are still visible until explicitly filtered out.
  const [channelFilters, setChannelFilters] = useState<DepositChannel[]>([]);
  const [minAmount, setMinAmount] = useState<string>('');
  const [maxAmount, setMaxAmount] = useState<string>('');
  // Collapse the filter & export panel by default so the queue tabs and
  // the TID form are the first things the operator sees on every visit.
  // Auto-opens whenever a filter is active so applied scopes stay visible.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Verifier (operator) filter — only narrows resolved/recently-verified rows.
  // Pending rows have no verifier yet so they are excluded when this is set.
  // Restored from localStorage so the operator's last selection survives a
  // reload. The sentinel value `'me'` means "the current user" — resolved
  // to the real id once auth completes (id is unknown on first render).
  const VERIFIER_STORAGE_KEY = 'finops:verifier-last-selection';
  const [verifierId, setVerifierIdRaw] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all';
    const saved = window.localStorage.getItem(VERIFIER_STORAGE_KEY);
    return saved && saved.length > 0 ? saved : 'all';
  });
  /**
   * Wraps `setVerifierId` so every change is persisted. We store the literal
   * `'me'` sentinel (not the resolved user id) so the preference still maps
   * to "the current user" if a different operator signs in on the same
   * device. Real operator ids are stored as-is.
   */
  const setVerifierId = (next: string) => {
    setVerifierIdRaw(next);
    try {
      const toStore = meId && next === meId ? 'me' : next;
      window.localStorage.setItem(VERIFIER_STORAGE_KEY, toStore);
    } catch { /* storage may be unavailable */ }
  };
  const [verifiers, setVerifiers] = useState<{ id: string; full_name: string | null }[]>([]);
  // Free-text filter over the verifier dropdown — handy once dozens of
  // operators have processed deposits and scrolling is tedious.
  const [verifierSearch, setVerifierSearch] = useState<string>('');
  // Export-only date window. Applied to Verified at / processed timestamp
  // when the operator clicks Export. Does NOT affect the live tables — the
  // queue tables remain a real-time view of the latest activity.
  const [exportFrom, setExportFrom] = useState<Date | undefined>(undefined);
  const [exportTo, setExportTo] = useState<Date | undefined>(undefined);
  // Current operator (used for the "Me" quick-select). Null until we resolve
  // the auth user; the "Me" option stays disabled until then.
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState<string | null>(null);
  // Persisted preference: when true, the verifier filter auto-defaults to the
  // current operator on every visit. Operators can still switch to "Any" or
  // another verifier — that doesn't disable the preference.
  const [defaultToMe, setDefaultToMe] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('finops:verifier-default-to-me') === '1';
  });
  // Tracks whether we've already applied the "default to me" preference this
  // mount, so we don't keep snapping the operator back to themselves after
  // they manually change it.
  const [appliedDefaultMe, setAppliedDefaultMe] = useState(false);

  // Resolve the current user once. Profile name is best-effort — falls back
  // to "Me" so the dropdown item is always usable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      setMeId(user.id);
      const { data: prof } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle();
      if (!cancelled) setMeName((prof?.full_name as string | null) ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  // Apply the "default to me" preference once the user id is known and only
  // if the operator hasn't already changed the filter this session.
  useEffect(() => {
    if (appliedDefaultMe) return;
    if (!meId) return;
    // Resolve the persisted `'me'` sentinel to the real user id now that
    // we know who the operator is. This takes priority over the
    // "default to me" preference because it's an explicit prior choice.
    if (verifierId === 'me') {
      setVerifierIdRaw(meId);
      setAppliedDefaultMe(true);
      return;
    }
    if (!defaultToMe) { setAppliedDefaultMe(true); return; }
    if (verifierId !== 'all') { setAppliedDefaultMe(true); return; }
    setVerifierIdRaw(meId);
    setAppliedDefaultMe(true);
  }, [defaultToMe, meId, verifierId, appliedDefaultMe]);

  const toggleDefaultToMe = () => {
    setDefaultToMe((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          'finops:verifier-default-to-me',
          next ? '1' : '0',
        );
      } catch { /* storage may be unavailable */ }
      // When turning it on, immediately apply to the current session.
      if (next && meId) setVerifierId(meId);
      return next;
    });
  };

  // Build a single distinct list of operators who have ever resolved a deposit
  // — pulled from both deposit_requests (user side) and field_deposit_batches
  // (field side). Loaded once; refreshed when auto-refresh tick fires so newly
  // active operators show up without a manual reload.
  useEffect(() => {
    let cancelled = false;
    const loadVerifiers = async () => {
      const [userRes, fieldRes] = await Promise.all([
        supabase
          .from('deposit_requests')
          .select('processed_by')
          .in('status', ['approved', 'rejected'])
          .not('processed_by', 'is', null)
          .limit(500),
        supabase
          .from('field_deposit_batches')
          .select('finops_verified_by')
          .in('status', ['verified', 'rejected'])
          .not('finops_verified_by', 'is', null)
          .limit(500),
      ]);
      const ids = new Set<string>();
      for (const r of (userRes.data ?? []) as any[]) if (r.processed_by) ids.add(r.processed_by);
      for (const r of (fieldRes.data ?? []) as any[]) if (r.finops_verified_by) ids.add(r.finops_verified_by);
      if (ids.size === 0) {
        if (!cancelled) setVerifiers([]);
        return;
      }
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', Array.from(ids));
      if (cancelled) return;
      const sorted = ((profs ?? []) as any[])
        .map((p) => ({ id: p.id as string, full_name: (p.full_name as string | null) ?? null }))
        .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
      setVerifiers(sorted);
    };
    loadVerifiers();
    if (!autoRefresh) return () => { cancelled = true; };
    const id = setInterval(loadVerifiers, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [autoRefresh]);

  const toggleChannel = (c: DepositChannel) =>
    setChannelFilters((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );

  const clearFilters = () => {
    setChannelFilters([]);
    setMinAmount('');
    setMaxAmount('');
    setVerifierId('all');
  };

  const minNum = minAmount ? Number(minAmount) : undefined;
  const maxNum = maxAmount ? Number(maxAmount) : undefined;
  const filtersActive =
    channelFilters.length > 0 ||
    (typeof minNum === 'number' && !Number.isNaN(minNum)) ||
    (typeof maxNum === 'number' && !Number.isNaN(maxNum)) ||
    (verifierId !== 'all' && verifierId !== 'me');
  // The `'me'` sentinel is treated as "no filter yet" until the auth user
  // resolves and the effect above swaps it for the real id. This prevents
  // a stray `processed_by = 'me'` query during the brief unresolved window.
  const verifierFilter =
    verifierId === 'all' || verifierId === 'me' ? undefined : verifierId;

  // Convert the date pickers to ISO bounds — inclusive day-windows so a
  // single-day selection covers the full 24h. Children only use these for
  // export queries; the live tables ignore them.
  const exportFromIso = exportFrom
    ? new Date(exportFrom.getFullYear(), exportFrom.getMonth(), exportFrom.getDate(), 0, 0, 0).toISOString()
    : undefined;
  const exportToIso = exportTo
    ? new Date(exportTo.getFullYear(), exportTo.getMonth(), exportTo.getDate(), 23, 59, 59, 999).toISOString()
    : undefined;

  const CHANNEL_CHIPS: { value: DepositChannel; label: string }[] = [
    { value: 'mtn', label: 'MTN MoMo' },
    { value: 'airtel', label: 'Airtel Money' },
    { value: 'bank', label: 'Bank' },
  ];

  // Lightweight pending counts so each tab shows a live badge.
  // Sequential awaits to keep PostgREST type unions cheap.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const userRes = await supabase
        .from('deposit_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      const fieldRes = await supabase
        .from('field_deposit_batches')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_finops_verification');
      const [rejectedFieldRes, rejectedUserRes] = await Promise.all([
        supabase
          .from('field_deposit_batches')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'rejected'),
        supabase
          .from('deposit_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'rejected'),
      ]);
      if (cancelled) return;
      setCounts({
        user: userRes.count ?? 0,
        field: fieldRes.count ?? 0,
        rejected: (rejectedFieldRes.count ?? 0) + (rejectedUserRes.count ?? 0),
      });
    };
    load();
    if (!autoRefresh) {
      return () => { cancelled = true; };
    }
    const id = setInterval(load, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [autoRefresh]);

  return (
    <div className="space-y-5">
      <div className="px-1">
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5 tracking-tight">
          <ShieldCheck className="h-6 w-6 text-primary" />
          Verify Deposits
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          One queue for every incoming payment. Approving credits the right
          wallet and posts to the ledger automatically.
        </p>
      </div>

      {/* Plain-language playbook for the currently-selected tab. Keeps
          newer operators oriented without slowing experienced ones down —
          collapses to a single row once every step is ticked. */}
      <VerifyDepositsChecklist tab={tab} />

      {/* Tabs first — operators told us the queue switcher is the most-used
          control, so it now sits at the top instead of below the filters. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'user' | 'field' | 'rejected')}>
        {/* Sticky on mobile so the queue switcher (and live counts) is always
            reachable while scrolling through long panels. */}
        <TabsList className="sticky top-0 z-20 grid grid-cols-3 w-full h-auto p-1.5 gap-1.5 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-sm rounded-xl">
          <TabsTrigger value="user" className="flex flex-col items-center gap-1 py-3.5 sm:py-3.5 min-h-[64px]">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <User className="h-5 w-5" />
              <span className="font-semibold text-sm sm:text-base">Users</span>
              {counts.user > 0 && (
                <Badge className="h-5 min-w-5 px-1.5 text-[11px] bg-primary text-primary-foreground hover:bg-primary">
                  {counts.user}
                </Badge>
              )}
            </div>
            <span className="text-[10px] sm:text-xs text-muted-foreground font-normal">
              Top-ups &amp; TID
            </span>
          </TabsTrigger>
          <TabsTrigger value="field" className="flex flex-col items-center gap-1 py-3.5 sm:py-3.5 min-h-[64px]">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Wallet className="h-5 w-5" />
              <span className="font-semibold text-sm sm:text-base">Field</span>
              {counts.field > 0 && (
                <Badge className="h-5 min-w-5 px-1.5 text-[11px] bg-primary text-primary-foreground hover:bg-primary">
                  {counts.field}
                </Badge>
              )}
            </div>
            <span className="text-[10px] sm:text-xs text-muted-foreground font-normal">
              Agent cash
            </span>
          </TabsTrigger>
          <TabsTrigger value="rejected" className="flex flex-col items-center gap-1 py-3.5 sm:py-3.5 min-h-[64px]">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <XCircle className="h-5 w-5" />
              <span className="font-semibold text-sm sm:text-base">Rejected</span>
              {counts.rejected > 0 && (
                <Badge variant="destructive" className="h-5 min-w-5 px-1.5 text-[11px]">
                  {counts.rejected}
                </Badge>
              )}
            </div>
            <span className="text-[10px] sm:text-xs text-muted-foreground font-normal">
              Re-review
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="user" className="mt-5 space-y-3">
          <p className="text-xs sm:text-sm text-muted-foreground">
            CFO credits from <span className="font-semibold text-foreground">Welile Technologies Finance</span> are auto-approved and skip this queue.
          </p>

          {/* Mobile-first jump bar — long page of panels otherwise forces
              a lot of scrolling. Horizontally scrollable pill row keeps
              every section one tap away without dominating the screen.
              Hidden on md+ where the page fits comfortably. */}
          <nav
            aria-label="Jump to section"
            className="md:hidden -mx-1 px-1 overflow-x-auto scrollbar-none"
          >
            <ul className="flex items-center gap-2 py-1 w-max">
              {[
                { id: 'sec-pending-user', label: 'Pending', Icon: AlertTriangle },
                { id: 'sec-auto-match', label: 'Auto-match', Icon: Mail },
                { id: 'sec-needs-review', label: 'Needs review', Icon: AlertTriangle },
                { id: 'sec-verify-tid', label: 'Verify TID', Icon: KeyRound },
                { id: 'sec-recently', label: 'Recent', Icon: History },
                { id: 'sec-audit', label: 'Audit log', Icon: ScrollText },
              ].map(({ id, label, Icon }) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document
                        .getElementById(id)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="inline-flex items-center gap-1.5 h-10 px-3 rounded-full border border-border/60 bg-card text-xs font-semibold text-foreground shadow-sm active:scale-[0.97] transition"
                  >
                    <Icon className="h-3.5 w-3.5 text-primary" />
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <section
            id="sec-pending-user"
            aria-label="Pending user deposits"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={AlertTriangle}
              title="Pending user deposits"
              subtitle="Every submitted deposit still awaiting verification — shown even before a receipt arrives."
            />
            <PendingUserDepositsPanel />
          </section>

          <section
            id="sec-verify-tid"
            aria-label="Verify by Transaction ID"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={KeyRound}
              title="Verify by Transaction ID"
              subtitle="Paste a TID to credit the matching wallet."
            />
            <TidVerification />
          </section>

          <section
            id="sec-auto-match"
            aria-label="Auto-matched Gmail receipts"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={Mail}
              title="Auto-matched receipts"
              subtitle="Gmail receipts already linked to a deposit request."
            />
            <EmailAutoMatchPanel />
          </section>

          <section
            id="sec-needs-review"
            aria-label="Gmail receipts that need review"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={AlertTriangle}
              title="Needs review"
              subtitle="Receipts the system couldn't link automatically."
            />
            <EmailNeedsReviewPanel />
          </section>

          {filtersActive && (
            <p className="text-xs sm:text-sm text-muted-foreground italic">
              User deposits are looked up by Transaction ID — channel and amount
              filters only narrow the Field Deposits tab.
            </p>
          )}

          <section
            id="sec-recently"
            aria-label="Recently verified deposits"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={History}
              title="Recently verified"
              subtitle="Last approvals and rejections from this queue."
            />
            <RecentlyVerifiedList
              source="user"
              verifierId={verifierFilter}
              exportFromIso={exportFromIso}
              exportToIso={exportToIso}
            />
          </section>

          <section
            id="sec-audit"
            aria-label="Email match audit log"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={ScrollText}
              title="Audit log"
              subtitle="Every match, cancellation and skip is recorded here."
            />
            <EmailMatchAuditLogPanel />
          </section>

          <section
            id="sec-decision-audit"
            aria-label="Deposit decision audit trail"
            className="scroll-mt-24"
          >
            <SectionHeader
              icon={ScrollText}
              title="Decision audit trail"
              subtitle="Every matcher/poller decision and approval rejection, with the exact reason per deposit attempt."
            />
            <DepositDecisionAuditPanel />
          </section>
        </TabsContent>

        <TabsContent value="field" className="mt-5 space-y-3">
          <p className="text-xs sm:text-sm text-muted-foreground">
            Approving credits the agent's float, allocates rent to tagged
            tenants, and posts agent commission instantly.
          </p>
          <FieldDepositVerificationQueue
            channels={channelFilters}
            minAmount={minNum !== undefined && !Number.isNaN(minNum) ? minNum : undefined}
            maxAmount={maxNum !== undefined && !Number.isNaN(maxNum) ? maxNum : undefined}
            verifierId={verifierFilter}
            exportFromIso={exportFromIso}
            exportToIso={exportToIso}
          />
        </TabsContent>

        <TabsContent value="rejected" className="mt-5 space-y-3">
          <RejectedFieldDepositsList />
        </TabsContent>
      </Tabs>

      {/* Collapsible "Filters & export" section — kept below the tabs so the
          page leads with the action area. Auto-opens when a filter is
          active so the operator can always see what's narrowing the view. */}
      <div className="rounded-lg border bg-muted/20">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen || filtersActive}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/40 transition-colors rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            Filters &amp; export
            {filtersActive && (
              <Badge variant="primary" className="h-4 px-1.5 text-[9px]">
                Active
              </Badge>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {filtersOpen || filtersActive ? 'Hide' : 'Show'}
          </span>
        </button>
        {(filtersOpen || filtersActive) && (
          <div className="p-3 pt-0 space-y-3">
      {/* Filter bar — channel chips + amount window. Kept inline (no popover)
          so operators can see at a glance what's narrowing the queue. */}
      <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            Filter pending deposits
          </div>
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] gap-1"
              onClick={clearFilters}
            >
              <X className="h-3 w-3" /> Clear
            </Button>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Channel
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {CHANNEL_CHIPS.map((c) => {
              const active = channelFilters.includes(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggleChannel(c.value)}
                  className={cn(
                    'h-7 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30',
                  )}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="finops-min-amount" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Min amount (UGX)
            </Label>
            <Input
              id="finops-min-amount"
              type="number"
              inputMode="numeric"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              placeholder="e.g. 50,000"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="finops-max-amount" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Max amount (UGX)
            </Label>
            <Input
              id="finops-max-amount"
              type="number"
              inputMode="numeric"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              placeholder="e.g. 1,000,000"
              className="h-8 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 min-h-[14px]">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Verified by
            </Label>
            {verifierId !== 'all' && (
              <button
                type="button"
                onClick={() => setVerifierId('all')}
                className="text-[10px] font-medium text-primary hover:underline focus:underline focus:outline-none"
                title="Clear the verifier filter and show all operators"
                aria-label="Reset verifier filter to Any operator"
              >
                Reset to Any operator
              </button>
            )}
          </div>
          <Select value={verifierId} onValueChange={setVerifierId}>
            <SelectTrigger
              className={cn(
                'h-8 text-sm',
                // Strong, theme-aware focus ring so keyboard operators can
                // see exactly where focus lands. Stacked over the default
                // Radix focus styles for extra contrast on dark themes.
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              <SelectValue placeholder="Any operator" />
            </SelectTrigger>
            <SelectContent>
              <div className="sticky top-0 z-10 bg-popover p-1.5 border-b border-border/60">
                <Input
                  value={verifierSearch}
                  onChange={(e) => setVerifierSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // Let Radix Select handle navigation keys (Arrow/Enter/
                    // Home/End/Escape) so the operator can type to filter,
                    // then press ↓ + Enter to pick "Me" or any item without
                    // leaving the keyboard. Other keys stay scoped to the
                    // search input so typeahead doesn't hijack them.
                    const navKeys = [
                      'ArrowDown', 'ArrowUp', 'Enter',
                      'Home', 'End', 'Escape',
                    ];
                    if (!navKeys.includes(e.key)) e.stopPropagation();
                  }}
                  placeholder="Search operator…"
                  className="h-7 text-xs"
                  aria-label="Search verifiers by name"
                />
              </div>
              <SelectItem
                value="all"
                className="focus-visible:ring-2 focus-visible:ring-primary focus:ring-2 focus:ring-primary"
              >
                Any operator
              </SelectItem>
              {meId ? (
                <SelectItem
                  value={meId}
                  // Highlighted ring for the "Me" quick-pick so it's the
                  // most discoverable option when tabbing through.
                  className="focus-visible:ring-2 focus-visible:ring-primary focus:ring-2 focus:ring-primary data-[highlighted]:ring-2 data-[highlighted]:ring-primary"
                >
                  Me{meName ? ` (${meName})` : ''}
                </SelectItem>
              ) : (
                // Keep the "Me" slot visible but disabled while the current
                // user profile is still resolving, so operators get clear
                // feedback instead of a missing option.
                <SelectItem value="me" disabled>
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading your profile…
                  </span>
                </SelectItem>
              )}
              {meId && (
                <div className="px-1.5 py-1 border-t border-border/60 mt-1">
                  <label className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={defaultToMe}
                      onChange={toggleDefaultToMe}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="h-3 w-3 accent-primary"
                      aria-label="Default verifier filter to me on every visit"
                    />
                    Default to me on every visit
                  </label>
                </div>
              )}
              {(() => {
                if (verifiers.length === 0) {
                  return (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground italic">
                      No verifiers on record yet
                    </div>
                  );
                }
                const q = verifierSearch.trim().toLowerCase();
                const filtered = q
                  ? verifiers.filter((v) =>
                      (v.full_name ?? `Operator ${v.id.slice(0, 8)}`)
                        .toLowerCase()
                        .includes(q),
                    )
                  : verifiers;
                if (filtered.length === 0) {
                  return (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground italic">
                      No operators match “{verifierSearch}”
                    </div>
                  );
                }
                return filtered.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.full_name ?? `Operator ${v.id.slice(0, 8)}`}
                  </SelectItem>
                ));
              })()}
            </SelectContent>
          </Select>
          {verifierFilter && (
            <p className="text-[10px] text-muted-foreground italic">
              Hides pending deposits — only resolved items have a verifier.
            </p>
          )}
        </div>
      </div>

      {/* Export-only date window. Operators can scope the CSV download to a
          specific verification period without filtering the live queue. */}
      <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Export date range
            <span className="text-[10px] font-normal text-muted-foreground italic">
              (applies to CSV download only)
            </span>
          </div>
          {(exportFrom || exportTo) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] gap-1"
              onClick={() => { setExportFrom(undefined); setExportTo(undefined); }}
            >
              <X className="h-3 w-3" /> Clear
            </Button>
          )}
        </div>
        {/* Quick shortcuts so operators can scope the export window to a
            common review period in one click instead of opening both
            calendars. Computed against local midnight so a "Today" pick
            covers the operator's full working day. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
            Quick range
          </span>
          {(() => {
            const startOfToday = () => {
              const d = new Date();
              d.setHours(0, 0, 0, 0);
              return d;
            };
            const startOfThisWeek = () => {
              const d = startOfToday();
              // Treat Monday as the first day of the week (ISO). Sunday=0.
              const day = d.getDay();
              const diff = day === 0 ? -6 : 1 - day;
              d.setDate(d.getDate() + diff);
              return d;
            };
            const startOfThisMonth = () => {
              const d = startOfToday();
              d.setDate(1);
              return d;
            };
            const today = startOfToday();
            const weekStart = startOfThisWeek();
            const monthStart = startOfThisMonth();
            const isSameDay = (a?: Date, b?: Date) =>
              !!a && !!b &&
              a.getFullYear() === b.getFullYear() &&
              a.getMonth() === b.getMonth() &&
              a.getDate() === b.getDate();
            const now = new Date();
            const shortcuts: { key: string; label: string; from: Date; to: Date }[] = [
              { key: 'today', label: 'Today', from: today, to: now },
              { key: 'week', label: 'This week', from: weekStart, to: now },
              { key: 'month', label: 'This month', from: monthStart, to: now },
            ];
            return shortcuts.map((s) => {
              const active =
                isSameDay(exportFrom, s.from) && isSameDay(exportTo, now);
              return (
                <Button
                  key={s.key}
                  type="button"
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => { setExportFrom(s.from); setExportTo(now); }}
                  aria-pressed={active}
                >
                  {s.label}
                </Button>
              );
            });
          })()}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              From
            </Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'h-8 w-full justify-start text-left text-sm font-normal',
                    !exportFrom && 'text-muted-foreground',
                  )}
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {exportFrom ? format(exportFrom, 'PP') : 'Pick a start date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={exportFrom}
                  onSelect={setExportFrom}
                  disabled={(d) => (exportTo ? d > exportTo : false) || d > new Date()}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              To
            </Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'h-8 w-full justify-start text-left text-sm font-normal',
                    !exportTo && 'text-muted-foreground',
                  )}
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {exportTo ? format(exportTo, 'PP') : 'Pick an end date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={exportTo}
                  onSelect={setExportTo}
                  disabled={(d) => (exportFrom ? d < exportFrom : false) || d > new Date()}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {verifierFilter && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Active filter
          </span>
          <Badge
            variant="primary"
            className="flex items-center gap-1.5 pl-2 pr-1 py-1"
          >
            <span className="text-[11px]">
              Verifier: {verifierFilter === meId
                ? `Me${meName ? ` (${meName})` : ''}`
                : verifiers.find((v) => v.id === verifierFilter)?.full_name
                  ?? `Operator ${verifierFilter.slice(0, 8)}`}
            </span>
            <button
              type="button"
              onClick={() => setVerifierId('all')}
              aria-label="Clear verifier filter"
              className="rounded-full p-0.5 hover:bg-primary/20 transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      )}
          </div>
        )}
      </div>
    </div>
  );
}