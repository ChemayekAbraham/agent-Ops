import { useState, useCallback, useEffect, useRef } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  Hash,
  Search,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Clock,
  Ban,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Users,
  Receipt,
  Info,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { decodeAllocationsFromNote } from '@/components/payments/OperationalFloatTenantAllocator';
import type { TenantAllocation } from '@/components/payments/OperationalFloatTenantAllocator';
import { OpFloatReopenNotifier } from '@/components/financial-ops/OpFloatReopenNotifier';

interface MatchResult {
  id: string;
  user_id: string;
  amount: number;
  transaction_id: string | null;
  provider: string | null;
  created_at: string;
  notes: string | null;
  userName: string;
  userPhone: string;
  status: 'matched' | 'amount_mismatch';
  /** When set, this is an operational_float deposit — show tenant breakdown. */
  deposit_purpose?: string | null;
  /** Decoded per-tenant allocations from the notes payload. */
  allocations?: TenantAllocation[] | null;
  /** True when the search matched against the notes (receipt/reference) rather than the TID column. */
  matchedVia?: 'tid' | 'notes';
  /** Audit blob carrying the depositor's purpose-choice trail.
   *  For agent personal deposits, presence of `agent_personal_confirmed_at`
   *  proves the agent acknowledged the in-app gate. */
  purpose_audit?: Record<string, unknown> | null;
  /** Agent who collected the deposit, when applicable. NULL means self-deposit. */
  agent_id?: string | null;
}

type ResultState = 'idle' | 'searching' | 'found' | 'not_found';

/** Compact chip-style filter row used above the pending pick-list. Each
 *  chip is a small toggle button; the active option uses the primary
 *  color so the operator can see at a glance which facets are narrowed. */
function FilterChipRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 w-12">
        {label}
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={`h-6 px-2 rounded-full text-[10px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Tiny self-view shown to the operator inside the verify card. Surfaces
 * how many provider-mismatch *attempts* the operator has triggered today
 * so they can self-correct before a CFO review. Stays silent (renders
 * nothing) when the count is zero — no need to add chrome that just
 * congratulates "0 mistakes".
 */
function OperatorMismatchTodayBadge() {
  const { user } = useAuth();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const { count: c, error } = await (supabase as any)
        .from('system_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'finops_provider_mismatch')
        .eq('user_id', user.id)
        .gte('created_at', startOfDay.toISOString());
      if (cancelled) return;
      if (error) {
        console.warn('[OperatorMismatchTodayBadge] fetch failed', error);
        return;
      }
      setCount(c ?? 0);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  if (!count || count === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
      <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
      <span className="text-warning-foreground">
        You've hit{' '}
        <span className="font-semibold">{count}</span>{' '}
        provider-mismatch warning{count === 1 ? '' : 's'} today. Restore the
        original provider after picking a deposit to avoid blocked submissions.
      </span>
    </div>
  );
}

export function TidVerification() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tid, setTid] = useState('');
  const [operatorAmount, setOperatorAmount] = useState('');
  const [provider, setProvider] = useState('mtn');
  // Pick-list provider filter — independent of the verify form's `provider`.
  // Defaults to 'all' so operators see EVERY pending deposit and don't miss
  // anything tagged to a different channel. Operators can still narrow to a
  // single provider via the Provider chip row.
  const [pendingProviderFilter, setPendingProviderFilter] = useState<string>('all');
  const [resultState, setResultState] = useState<ResultState>('idle');
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [approving, setApproving] = useState<string | null>(null);
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  // Pending (deferred) approvals — each entry holds an in-flight 5-second
  // undo window. While a match id is in this map we show the row as
  // "Approving (undoable)" and the backend `approve-deposit` call is
  // NOT fired. When the timer elapses we commit; if the operator clicks
  // Undo we cancel the timer and nothing reaches the server.
  const undoTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Use state (not just ref) so the per-row UI updates when entries
  // are added/removed.
  const [pendingUndoIds, setPendingUndoIds] = useState<Set<string>>(new Set());
  // Mirror of every match currently waiting in the undo window, keyed
  // by match id. We need this in a ref (not just React state) so the
  // unmount + `beforeunload` flush handlers can still find the row data
  // after React has torn down. Without this, closing the dialog or
  // navigating away during the undo window silently drops the approval —
  // which is the bug operators on phones kept hitting ("verified
  // deposits don't disappear").
  const pendingMatchesRef = useRef<Map<string, MatchResult>>(new Map());
  // Per-row countdown (seconds remaining) so we can render
  // "Approving in 3…2…1" in the pending pick-list and on the match card.
  const [undoCountdown, setUndoCountdown] = useState<Map<string, number>>(new Map());
  const countdownTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Pending depositor pick-list — narrow the user-visible queue by the
  // currently selected provider so the operator can click a row, see who
  // they're verifying for, and let the form prefill the expected amount.
  // Reloads whenever the provider changes; cap at 25 to keep the panel
  // scannable on a 950px viewport.
  type PendingDeposit = {
    id: string;
    user_id: string;
    amount: number;
    provider: string | null;
    created_at: string;
    depositorName: string;
    depositorPhone: string;
    transaction_id: string | null;
    deposit_purpose: string | null;
    agent_id: string | null;
  };
  const [pending, setPending] = useState<PendingDeposit[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingLoadingMore, setPendingLoadingMore] = useState(false);
  const [pendingHasMore, setPendingHasMore] = useState(false);
  // Persist the current pick across page refreshes so the
  // provider-mismatch warning (and the "About to verify" recap) survive a
  // reload. Scoped to sessionStorage — operator-session-local.
  const PICKED_ID_KEY = 'finops:tid:pickedId';
  const PICKED_PROVIDER_KEY = 'finops:tid:pickedProvider';
  const [pickedId, setPickedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return sessionStorage.getItem(PICKED_ID_KEY); } catch { return null; }
  });
  const [pendingSearch, setPendingSearch] = useState('');
  // Quick filter chips that narrow the pick-list locally. All three are
  // additive — a row must satisfy every active chip to show. Defaults are
  // the most permissive ('any') so the panel behaves as before until the
  // operator opts in.
  type MatchField = 'any' | 'name' | 'phone' | 'amount';
  type AmountRange = 'any' | 'low' | 'mid' | 'high';
  type Verification = 'any' | 'verified' | 'unverified';
  type OpFloatFilter = 'any' | 'non_op_float';
  const [matchField, setMatchField] = useState<MatchField>('any');
  const [amountRange, setAmountRange] = useState<AmountRange>('any');
  const [verification, setVerification] = useState<Verification>('any');
  const [opFloatFilter, setOpFloatFilter] = useState<OpFloatFilter>('any');
  // Sort controls for the pick-list. Default is the natural newest-first
  // order returned by the server query. Each click on a column header
  // cycles asc → desc → none.
  type SortColumn = 'name' | 'phone' | 'amount';
  type SortDir = 'asc' | 'desc';
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // The provider the picked row was originally tagged with — used to
  // detect when the operator changes the provider after picking. Persisted
  // alongside pickedId so the mismatch warning survives a refresh.
  const [pickedProvider, setPickedProvider] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return sessionStorage.getItem(PICKED_PROVIDER_KEY); } catch { return null; }
  });
  // Keyboard navigation state for the pick-list. -1 means nothing
  // highlighted; arrow keys move within `pendingFiltered`.
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  // Screen-reader announcement for keyboard navigation of the pending
  // depositors list. Updated when the highlight moves and when a row is
  // picked via Enter, so non-sighted operators get the same feedback as
  // sighted ones.
  const [pendingLiveMessage, setPendingLiveMessage] = useState('');
  // Lightweight banner shown for a few seconds when the search/filters
  // narrow the list to one row and we auto-pick it for the operator.
  // Holds the auto-picked row + the previous form snapshot so Undo can
  // restore exactly what the operator had before the auto-pick fired.
  type AutoPickInfo = {
    id: string;
    name: string;
    amount: number;
    prev: {
      pickedId: string | null;
      pickedProvider: string | null;
      operatorAmount: string;
      provider: string;
    };
  };
  const [autoPicked, setAutoPicked] = useState<AutoPickInfo | null>(null);
  const pendingListRef = useRef<HTMLUListElement>(null);
  const pendingItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Ref to the pending search input so the global "/" hotkey can focus it.
  const pendingSearchInputRef = useRef<HTMLInputElement>(null);
  // Synchronous reentrancy guard for the "Load more" button — see
  // loadMorePending below for rationale.
  const loadMoreInFlightRef = useRef(false);
  // Sentinel element observed by IntersectionObserver to drive infinite
  // scrolling for the pending pick-list.
  const pendingSentinelRef = useRef<HTMLDivElement | null>(null);

  // Page size for the pending pick-list. Kept small so the panel stays
  // scannable; operators can press "Load more" to fetch the next batch.
  const PENDING_PAGE_SIZE = 25;

  // Internal fetch — `append=false` resets the list (provider switch /
  // post-action refresh); `append=true` paginates from the current count.
  const fetchPendingPage = useCallback(
    async (append: boolean, currentCount: number) => {
      const from = append ? currentCount : 0;
      const to = from + PENDING_PAGE_SIZE - 1;
      let query = supabase
        .from('deposit_requests')
        .select('id, user_id, amount, provider, created_at, transaction_id, deposit_purpose, agent_id')
        .eq('status', 'pending');
      if (pendingProviderFilter !== 'all') {
        query = query.eq('provider', pendingProviderFilter);
      }
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) throw error;
      const rows = data ?? [];
      const userIds = Array.from(new Set(rows.map((d) => d.user_id)));
      const profileMap = new Map<string, { name: string; phone: string }>();
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', userIds);
        (profiles ?? []).forEach((p: any) => {
          profileMap.set(p.id, {
            name: p.full_name ?? 'Unknown depositor',
            phone: p.phone ?? '',
          });
        });
      }
      const mapped: PendingDeposit[] = rows.map((d: any) => ({
        id: d.id,
        user_id: d.user_id,
        amount: Number(d.amount),
        provider: d.provider,
        created_at: d.created_at,
        depositorName: profileMap.get(d.user_id)?.name ?? 'Unknown depositor',
        depositorPhone: profileMap.get(d.user_id)?.phone ?? '',
        transaction_id: d.transaction_id ?? null,
        deposit_purpose: d.deposit_purpose ?? null,
        agent_id: d.agent_id ?? null,
      }));
      setPending((prev) => {
        if (!append) return mapped;
        // De-dupe in case a row shifted pages between calls.
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...mapped.filter((m) => !seen.has(m.id))];
      });
      setPendingHasMore(rows.length === PENDING_PAGE_SIZE);
    },
    [pendingProviderFilter],
  );

  // Extracted so we can refresh the pick-list after verify/reject without
  // a full page reload — the just-actioned row simply disappears.
  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      await fetchPendingPage(false, 0);
    } catch (e) {
      console.warn('[TidVerification] load pending failed', e);
    } finally {
      setPendingLoading(false);
    }
  }, [fetchPendingPage]);

  const loadMorePending = useCallback(async () => {
    // Guard against rapid double-clicks: even though the button is
    // visually disabled while `pendingLoadingMore` is true, React's
    // state update is async and a fast second click can sneak in
    // before re-render. The ref check is synchronous and ignores any
    // re-entrant call until the in-flight fetch settles.
    if (loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    setPendingLoadingMore(true);
    try {
      await fetchPendingPage(true, pending.length);
    } catch (e) {
      console.warn('[TidVerification] load more pending failed', e);
      toast.error('Failed to load more pending deposits');
    } finally {
      setPendingLoadingMore(false);
      loadMoreInFlightRef.current = false;
    }
  }, [fetchPendingPage, pending.length]);

  // Infinite scroll: observe the sentinel beneath the list and call
  // loadMorePending whenever it enters the viewport. The hook re-binds
  // when has-more / search / loading state changes so we stop observing
  // the moment paging is exhausted or a search filter is active.
  useEffect(() => {
    const node = pendingSentinelRef.current;
    if (!node) return;
    if (!pendingHasMore) return;
    if (pendingSearch.trim()) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !pendingLoadingMore && !loadMoreInFlightRef.current) {
            void loadMorePending();
          }
        }
      },
      { root: null, rootMargin: '200px 0px', threshold: 0 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [pendingHasMore, pendingLoadingMore, pendingSearch, loadMorePending, pending.length]);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  // Keep the visible queue honest even when an approval completes from an
  // undo flush, another tab, or another operator session. Polled every 30s
  // (doc 147) — the old Realtime listener was on deposit_requests, which was
  // never in the publication, so it never fired:
  //  - on the first page only: full reload (also picks up new deposits);
  //  - once the operator has scrolled past page 1: only drop rows that are no
  //    longer pending, so their loaded pages / scroll position survive.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const refreshPendingQueue = useCallback(async () => {
    const ids = pendingRef.current.map((p) => p.id);
    if (ids.length <= PENDING_PAGE_SIZE) {
      await loadPending();
      return;
    }
    const stillPending = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase
        .from('deposit_requests')
        .select('id, status, provider')
        .in('id', ids.slice(i, i + 100));
      if (error) return;
      (data ?? []).forEach((d: { id: string; status: string; provider: string | null }) => {
        if (d.status === 'pending' && (pendingProviderFilter === 'all' || d.provider === pendingProviderFilter)) {
          stillPending.add(d.id);
        }
      });
    }
    setPending((prev) => prev.filter((p) => stillPending.has(p.id)));
    setPickedId((cur) => (cur && ids.includes(cur) && !stillPending.has(cur) ? null : cur));
  }, [loadPending, pendingProviderFilter]);

  // usePolling also refreshes on window focus / tab becoming visible, which
  // replaces the old focus + visibilitychange listeners.
  const { lastUpdatedAt: pendingUpdatedAt, refresh: refreshPending } = usePolling(
    refreshPendingQueue,
    30_000,
  );

  // Global "/" hotkey to focus the pending search input — same shortcut
  // pattern as GitHub/Slack, so operators can start filtering instantly
  // without reaching for the mouse. Skipped when the user is already
  // typing in another input/textarea/contenteditable, when a modifier
  // key is held, or when the search input itself isn't mounted yet
  // (e.g. before any pending rows have loaded).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const input = pendingSearchInputRef.current;
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // When the operator switches the provider dropdown, immediately reset
  // the pending list to its first-page state. `loadPending` will refetch
  // automatically (it depends on `provider` via `fetchPendingPage`), but
  // clearing the rows + `pendingHasMore` synchronously avoids a flash of
  // stale rows from the previous provider and ensures the "Load more"
  // button reappears only after the new first page reports a full batch.
  useEffect(() => {
    setPending([]);
    setPendingHasMore(false);
    // Don't reset `pickedId` / `pickedProvider` here — that's intentional
    // so the mismatch warning + recap stay visible when the operator
    // changes providers after picking a row.
  }, [provider]);

  // Sync pick state to sessionStorage so a refresh restores the same pick
  // (and therefore the mismatch warning, recap, and prefilled amount).
  useEffect(() => {
    try {
      if (pickedId) sessionStorage.setItem(PICKED_ID_KEY, pickedId);
      else sessionStorage.removeItem(PICKED_ID_KEY);
    } catch {
      // sessionStorage may be unavailable (private mode, quota) — ignore.
    }
  }, [pickedId]);

  useEffect(() => {
    try {
      if (pickedProvider) sessionStorage.setItem(PICKED_PROVIDER_KEY, pickedProvider);
      else sessionStorage.removeItem(PICKED_PROVIDER_KEY);
    } catch {
      // ignore
    }
  }, [pickedProvider]);

  /** Click a pending row to prefill the form (amount + provider). The TID
   *  input intentionally stays empty — the operator types it from their
   *  bank/MoMo statement to confirm the match. */
  const pickPending = (p: PendingDeposit) => {
    const prevProvider = provider;
    setPickedId(p.id);
    setOperatorAmount(String(p.amount));
    setPickedProvider(p.provider ?? null);
    // Always restore the Provider dropdown to match the picked row's
    // original channel — including when re-clicking the same already-picked
    // row after the operator changed the dropdown away from it.
    if (p.provider) {
      setProvider(p.provider);
      // If the picked deposit was submitted on a different channel than the
      // tab the operator was browsing, surface a toast so the auto-switch
      // is explicit (and reversible) rather than silent.
      if (p.provider !== prevProvider) {
        const labelOf = (k: string) =>
          k === 'mtn' ? 'MTN'
          : k === 'airtel' ? 'Airtel'
          : k === 'bank_transfer' ? 'Bank'
          : k === 'agent_cash' ? 'Agent Cash'
          : k.replace('_', ' ').toUpperCase();
        toast.info(
          `Switched to ${labelOf(p.provider)} — this deposit was submitted on that channel.`,
          {
            action: {
              label: `Back to ${labelOf(prevProvider)}`,
              onClick: () => setProvider(prevProvider),
            },
          },
        );
      }
    }
  };



  // True if the operator picked a row and then changed the provider away
  // from what that row was submitted as — almost always a mistake.
  const providerMismatch =
    !!pickedId && !!pickedProvider && pickedProvider !== provider;

  // Local filter — search text + chip filters. A row must satisfy every
  // active filter to show.
  //  • matchField: which column the search text targets (default = any)
  //  • amountRange: low (<50K) / mid (50K–200K) / high (>200K)
  //  • verification: 'verified' = has BOTH a real name and a phone on file
  //                  (i.e. profile looks complete enough to trust the match)
  const isVerifiedProfile = (p: PendingDeposit) =>
    !!p.depositorPhone &&
    !!p.depositorName &&
    p.depositorName.toLowerCase() !== 'unknown depositor';
  const isNonOpFloat = (p: PendingDeposit) =>
    p.deposit_purpose !== 'operational_float' || p.agent_id === null;
  const pendingFiltered = (() => {
    const q = pendingSearch.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    return pending.filter((p) => {
      // Operational float category chip
      if (opFloatFilter === 'non_op_float' && !isNonOpFloat(p)) return false;
      // Amount range chip
      if (amountRange === 'low' && p.amount >= 50000) return false;
      if (amountRange === 'mid' && (p.amount < 50000 || p.amount > 200000)) return false;
      if (amountRange === 'high' && p.amount <= 200000) return false;
      // Verification chip
      if (verification === 'verified' && !isVerifiedProfile(p)) return false;
      if (verification === 'unverified' && isVerifiedProfile(p)) return false;
      // Search text — scoped by matchField chip
      if (q) {
        const inName = p.depositorName.toLowerCase().includes(q);
        const inPhone = p.depositorPhone.toLowerCase().includes(q);
        const inAmount = !!qDigits && String(p.amount).includes(qDigits);
        if (matchField === 'name' && !inName) return false;
        if (matchField === 'phone' && !inPhone) return false;
        if (matchField === 'amount' && !inAmount) return false;
        if (matchField === 'any' && !(inName || inPhone || inAmount)) return false;
      }
      return true;
    });
  })();
  const filtersActive =
    matchField !== 'any' || amountRange !== 'any' || verification !== 'any' || opFloatFilter !== 'any';

  // Apply column sort on top of the filtered list. When no column is
  // active we keep the server's natural newest-first order so toggling
  // sort off feels like an undo.
  const pendingSorted = (() => {
    if (!sortColumn) return pendingFiltered;
    const dir = sortDir === 'asc' ? 1 : -1;
    const copy = [...pendingFiltered];
    copy.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      if (sortColumn === 'amount') {
        av = a.amount; bv = b.amount;
      } else if (sortColumn === 'phone') {
        av = a.depositorPhone || ''; bv = b.depositorPhone || '';
      } else {
        av = a.depositorName.toLowerCase();
        bv = b.depositorName.toLowerCase();
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return copy;
  })();

  // Cycle sort: same column → flip asc/desc; different column → start asc;
  // a third click on the same column clears sort entirely (back to natural
  // order).
  const toggleSort = (col: SortColumn) => {
    if (sortColumn !== col) {
      setSortColumn(col);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortColumn(null);
      setSortDir('asc');
    }
  };

  // Reset highlight when the visible list shape changes (search, provider,
  // refresh) so the focus indicator never points to a stale row.
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [pendingSearch, provider, pending.length, matchField, amountRange, verification, sortColumn, sortDir]);

  // Keep the highlighted row in view when arrow-keying through a long list.
  useEffect(() => {
    if (highlightedIndex < 0) return;
    const el = pendingItemRefs.current[highlightedIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  // Announce the currently highlighted depositor to assistive tech so
  // keyboard-only / screen-reader users hear who they're about to pick.
  // Cleared when nothing is highlighted to avoid stale announcements.
  useEffect(() => {
    if (highlightedIndex < 0 || highlightedIndex >= pendingSorted.length) {
      setPendingLiveMessage('');
      return;
    }
    const row = pendingSorted[highlightedIndex];
    setPendingLiveMessage(
      `Highlighted ${highlightedIndex + 1} of ${pendingSorted.length}: ` +
      `${row.depositorName}, ${formatUGX(row.amount)}. Press Enter to pick.`
    );
  }, [highlightedIndex, pendingSorted]);

  // Auto-select when the search/filters narrow the list to exactly one row.
  // Saves a click for the common "type a name → one match" case. We only
  // auto-pick when the operator has actively narrowed (search text or a
  // non-default filter), to avoid surprising picks on a fresh page.
  useEffect(() => {
    const hasActiveNarrowing =
      pendingSearch.trim().length > 0 ||
      matchField !== 'any' ||
      amountRange !== 'any' ||
      verification !== 'any';
    if (!hasActiveNarrowing) return;
    if (pendingSorted.length !== 1) return;
    const only = pendingSorted[0];
    if (pickedId === only.id) return;
    // Snapshot the form *before* the auto-pick mutates it so Undo can
    // restore exactly what the operator had.
    const snapshot = {
      pickedId,
      pickedProvider,
      operatorAmount,
      provider,
    };
    pickPending(only);
    const info: AutoPickInfo = {
      id: only.id,
      name: only.depositorName,
      amount: only.amount,
      prev: snapshot,
    };
    setAutoPicked(info);
    // Toast with Undo — gives operators a fast keyboard/mouse path even
    // if they've already scrolled away from the inline badge.
    toast.success(`Auto-picked ${only.depositorName} (${formatUGX(only.amount)})`, {
      action: {
        label: 'Undo',
        onClick: () => {
          setPickedId(info.prev.pickedId);
          setPickedProvider(info.prev.pickedProvider);
          setOperatorAmount(info.prev.operatorAmount);
          setProvider(info.prev.provider);
          setAutoPicked(null);
        },
      },
      duration: 6000,
    });
    // Hide the inline badge after the same window so it doesn't linger.
    const t = setTimeout(() => {
      setAutoPicked((curr) => (curr?.id === info.id ? null : curr));
    }, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSorted, pendingSearch, matchField, amountRange, verification]);

  const handlePendingKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (pendingSorted.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => {
        const next = i < pendingSorted.length - 1 ? i + 1 : 0;
        pendingItemRefs.current[next]?.focus();
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => {
        const next = i > 0 ? i - 1 : pendingSorted.length - 1;
        pendingItemRefs.current[next]?.focus();
        return next;
      });
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlightedIndex(0);
      pendingItemRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = pendingSorted.length - 1;
      setHighlightedIndex(last);
      pendingItemRefs.current[last]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (highlightedIndex >= 0 && highlightedIndex < pendingSorted.length) {
        e.preventDefault();
        const row = pendingSorted[highlightedIndex];
        pickPending(row);
        setPendingLiveMessage(
          `Picked ${row.depositorName}, ${formatUGX(row.amount)}. Amount auto-filled.`
        );
      }
    } else if (e.key === 'Escape') {
      // Esc priority: clear the search box first (most common case while
      // narrowing the list); only if search is empty does Esc clear the
      // current pick.
      if (pendingSearch) {
        e.preventDefault();
        setPendingSearch('');
      } else if (pickedId) {
        e.preventDefault();
        setPickedId(null);
        setPickedProvider(null);
        setOperatorAmount('');
      }
    }
  };

  // Logs a "blocked Verify attempt" to the system event stream so ops
  // metrics can show how often operators try to verify with a mismatched
  // provider. Debounced per-pick so a frustrated double-click only counts
  // once until the operator changes the pick or the provider.
  const lastLoggedRef = useRef<string | null>(null);
  const logMismatchAttempt = useCallback(async () => {
    if (!pickedId || !pickedProvider) return;
    const dedupeKey = `${pickedId}|${pickedProvider}|${provider}`;
    if (lastLoggedRef.current === dedupeKey) return;
    lastLoggedRef.current = dedupeKey;
    try {
      await supabase.rpc('log_finops_provider_mismatch', {
        _picked_deposit_id: pickedId,
        _picked_provider: pickedProvider,
        _selected_provider: provider,
        _attempted_amount: operatorAmount ? parseFloat(operatorAmount) : null,
        _attempted_tid: tid.trim() || null,
      });
    } catch (err) {
      // Logging is best-effort — never block the operator on a metrics call.
      console.warn('[TidVerification] mismatch log failed', err);
    }
  }, [pickedId, pickedProvider, provider, operatorAmount, tid]);

  // Reset the dedupe key whenever the pick or provider changes — that's a
  // distinct "attempt context" and a new mismatch click should be counted.
  useEffect(() => {
    lastLoggedRef.current = null;
  }, [pickedId, pickedProvider, provider]);

  const handleVerify = useCallback(async () => {
    const trimmedTid = tid.trim();
    if (!user) return;
    if (!operatorAmount) { toast.error('Enter the amount'); return; }

    // FAST PATH — when the operator picked a row from the pending pick-list,
    // that row is the source of truth. The typed TID is informational only;
    // a typo there must NOT make the verify button silently fail. We pull
    // the picked deposit by id and run the exact same MatchResult logic
    // the typed-search path uses below.
    if (pickedId) {
      setResultState('searching');
      setMatches([]);
      try {
        const parsedAmount = parseFloat(operatorAmount);
        const { data: d, error } = await supabase
          .from('deposit_requests')
          .select('*')
          .eq('id', pickedId)
          .eq('status', 'pending')
          .maybeSingle();
        if (error) throw error;
        if (!d) {
          // Row no longer pending (already approved/rejected by another op,
          // or refreshed away). Fall through to typed-TID search if we have
          // one; otherwise surface not_found.
          if (!trimmedTid) { setResultState('not_found'); return; }
        } else {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .eq('id', d.user_id)
            .maybeSingle();
          const amountMatches = Math.abs(d.amount - parsedAmount) < 1;
          const isOpFloat = d.deposit_purpose === 'operational_float';
          const decoded = isOpFloat ? decodeAllocationsFromNote(d.notes) : null;
          const result: MatchResult = {
            id: d.id, user_id: d.user_id, amount: d.amount,
            transaction_id: d.transaction_id, provider: d.provider,
            created_at: d.created_at, notes: d.notes,
            userName: profile?.full_name || 'Unknown',
            userPhone: profile?.phone || '',
            status: amountMatches ? 'matched' : 'amount_mismatch',
            deposit_purpose: d.deposit_purpose ?? null,
            allocations: decoded?.allocations ?? null,
            matchedVia: 'tid',
            purpose_audit: (d as any).purpose_audit ?? null,
            agent_id: (d as any).agent_id ?? null,
          };
          setMatches([result]);
          setResultState('found');
          if (amountMatches) toast.info('Picked deposit ready to approve.');
          else toast.warning('Amount differs from the picked deposit — review before approving.');
          return;
        }
      } catch (err: any) {
        toast.error(err.message || 'Verification failed');
        setResultState('idle');
        return;
      }
    }

    // TYPED-TID PATH — no row picked, fall back to searching the queue.
    if (!trimmedTid) { toast.error('Enter a Transaction ID or pick a depositor from the list'); return; }

    // TID format validation
    if (provider === 'mtn' && !trimmedTid.startsWith('MP')) {
      toast.error('MTN Transaction IDs must start with "MP"');
      return;
    }
    if (provider === 'airtel' && trimmedTid.startsWith('MP')) {
      toast.error('This looks like an MTN TID. Select the correct provider.');
      return;
    }

    setResultState('searching');
    setMatches([]);

    try {
      const parsedAmount = parseFloat(operatorAmount);

      // Extract numeric-only portion for legacy fallback matching
      const numericPortion = trimmedTid.replace(/[^0-9]/g, '');

      // Step 1: Search pending deposits with matching TID (two-pass: exact + numeric fallback)
      // We also widen the search to match the same token inside `notes`
      // so an op-float deposit that was reconciled via the agent's
      // "Collect from receipt/reference" flow can be approved here using
      // either the auto-matched TID or the original receipt text the
      // agent originally pasted.
      const [exactResult, numericResult, notesResult] = await Promise.all([
        supabase
          .from('deposit_requests')
          .select('*')
          .eq('status', 'pending')
          .ilike('transaction_id', `%${trimmedTid}%`)
          .limit(20),
        numericPortion && numericPortion !== trimmedTid
          ? supabase
              .from('deposit_requests')
              .select('*')
              .eq('status', 'pending')
              .ilike('transaction_id', `%${numericPortion}%`)
              .limit(20)
          : Promise.resolve({ data: [] as any[], error: null }),
        supabase
          .from('deposit_requests')
          .select('*')
          .eq('status', 'pending')
          .ilike('notes', `%${trimmedTid}%`)
          .limit(20),
      ]);

      if (exactResult.error) throw exactResult.error;
      if (numericResult.error) throw numericResult.error;
      if (notesResult.error) throw notesResult.error;

      // Merge and deduplicate by id, remembering which channel produced
      // each row so we can show a "matched via receipt note" badge.
      const tidIds = new Set<string>([
        ...(exactResult.data || []).map((d: any) => d.id),
        ...(numericResult.data || []).map((d: any) => d.id),
      ]);
      const seen = new Set<string>();
      const deposits = [
        ...(exactResult.data || []),
        ...(numericResult.data || []),
        ...(notesResult.data || []),
      ].filter((d) => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });

      if (deposits?.length) {
        // Found pending deposits — resolve profiles and show matches
        const userIds = [...new Set(deposits.map(d => d.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', userIds);
        const pm = new Map(profiles?.map(p => [p.id, p]) || []);

        const results: MatchResult[] = deposits.map(d => {
          const profile = pm.get(d.user_id);
          const amountMatches = Math.abs(d.amount - parsedAmount) < 1;
          // Decode the per-tenant allocations the agent submitted so
          // operators can verify the breakdown before clicking Approve.
          const isOpFloat = d.deposit_purpose === 'operational_float';
          const decoded = isOpFloat ? decodeAllocationsFromNote(d.notes) : null;
          return {
            id: d.id, user_id: d.user_id, amount: d.amount,
            transaction_id: d.transaction_id, provider: d.provider,
            created_at: d.created_at, notes: d.notes,
            userName: profile?.full_name || 'Unknown',
            userPhone: profile?.phone || '',
            status: amountMatches ? 'matched' : 'amount_mismatch',
            deposit_purpose: d.deposit_purpose ?? null,
            allocations: decoded?.allocations ?? null,
            matchedVia: tidIds.has(d.id) ? 'tid' : 'notes',
            purpose_audit: (d as any).purpose_audit ?? null,
            agent_id: (d as any).agent_id ?? null,
          };
        });

        results.sort((a, b) => (a.status === 'matched' ? -1 : 1) - (b.status === 'matched' ? -1 : 1));
        setMatches(results);
        setResultState('found');

        const exact = results.filter(r => r.status === 'matched');
        if (exact.length === 1) toast.info('Exact match found — ready to auto-approve.');
        else if (exact.length > 1) toast.warning(`${exact.length} matches — review individually.`);
        return;
      }

      // No pending deposit found
      setResultState('not_found');
    } catch (err: any) {
      toast.error(err.message || 'Verification failed');
      setResultState('idle');
    }
  }, [tid, operatorAmount, provider, user, pickedId]);

  // Actual backend commit. Kept private — public callers go through
  // `handleAutoApprove`, which adds the 5-second undo window.
  const commitApprove = useCallback(async (match: MatchResult) => {
    if (!user) return;
    setApproving(match.id);
    // Optimistically remove from the pending pick-list so the row
    // disappears instantly even on a slow phone connection. If the
    // backend later fails, we restore via `loadPending()` below.
    setPending((prev) => prev.filter((p) => p.id !== match.id));
    pendingMatchesRef.current.delete(match.id);

    try {
      // ── Retry wrapper ────────────────────────────────────────────
      // Large-amount deposits (≥10M) trigger the rent-repayment +
      // float-sweep branches inside `approve-deposit`, which can take
      // 3-6s and occasionally cold-start past the gateway timeout. The
      // server-side idempotency guard (existing wallet_deposit ledger
      // entry → skip ledger RPC) makes a retry SAFE: a successful first
      // attempt that times out at the network layer will be detected
      // and reconciled on retry without double-crediting.
      const MAX_ATTEMPTS = 3;
      const tag = `[approve-deposit] ${match.id} (${formatUGX(match.amount)})`;
      let data: any = null;
      let lastErr: any = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        try {
          console.info(`${tag} attempt ${attempt}/${MAX_ATTEMPTS} → invoking`);
          const res = await supabase.functions.invoke('approve-deposit', {
            body: { deposit_request_id: match.id, action: 'approve' },
          });
          const dt = Date.now() - t0;
          if (res.error) {
            console.warn(`${tag} attempt ${attempt} failed in ${dt}ms`, res.error);
            lastErr = res.error;
            // Only retry on transient signals — auth/validation errors
            // (4xx) won't get better with a retry.
            const status = (res.error as any)?.context?.status ?? (res.error as any)?.status;
            const transient =
              !status || status >= 500 || status === 408 || status === 429
              || /network|timeout|fetch failed|aborted|FunctionsFetchError/i.test(String(res.error?.message || ''));
            if (!transient || attempt === MAX_ATTEMPTS) {
              const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
              const msg = await extractFromErrorObject(res.error, 'Failed to approve deposit');
              throw new Error(msg);
            }
            // Exponential backoff: 600ms, 1.5s
            await new Promise((r) => setTimeout(r, attempt === 1 ? 600 : 1500));
            continue;
          }
          console.info(`${tag} attempt ${attempt} succeeded in ${dt}ms`);
          data = res.data;
          lastErr = null;
          break;
        } catch (thrown: any) {
          // Network / fetch-level throw (no res object). Same retry rule.
          const dt = Date.now() - t0;
          lastErr = thrown;
          const transient = /network|timeout|fetch failed|aborted|load failed/i.test(String(thrown?.message || ''));
          console.warn(`${tag} attempt ${attempt} threw in ${dt}ms (transient=${transient})`, thrown);
          if (!transient || attempt === MAX_ATTEMPTS) throw thrown;
          await new Promise((r) => setTimeout(r, attempt === 1 ? 600 : 1500));
        }
      }
      if (lastErr) throw lastErr;

      const result = Array.isArray((data as any)?.results)
        ? (data as any).results.find((r: any) => r.id === match.id)
        : null;
      if ((data as any)?.success === false || result?.status === 'error') {
        throw new Error('Approval did not complete — deposit remains pending for retry.');
      }

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'tid_verified_approve',
        table_name: 'deposit_requests',
        record_id: match.id,
        metadata: {
          transaction_id: match.transaction_id,
          amount: match.amount,
          depositor_name: match.userName,
          operator_entered_tid: tid.trim(),
          operator_entered_amount: operatorAmount,
        },
      });

      setApprovedIds(prev => new Set(prev).add(match.id));
      toast.success(
        `Removed from pending list ✓ — ${match.userName}, ${formatUGX(match.amount)} approved`,
      );

      queryClient.invalidateQueries({ queryKey: ['approval-queue-deposits'] });
      queryClient.invalidateQueries({ queryKey: ['financial-ops-pulse'] });

      // Refresh the pick-list so the just-approved depositor disappears.
      if (pickedId === match.id) setPickedId(null);
      loadPending();
    } catch (err: any) {
      const msg = err?.message || 'Approval failed';
      toast.error(msg);
      // Diagnostic safety net — surfaces any silent failures to CFO
      // review even when the operator dismisses the toast.
      try {
        await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'tid_approve_failed',
          table_name: 'deposit_requests',
          record_id: match.id,
          metadata: {
            transaction_id: match.transaction_id,
            amount: match.amount,
            depositor_name: match.userName,
            error_message: String(msg).slice(0, 500),
          },
        });
      } catch { /* non-blocking */ }
      // Restore the optimistically-removed row so the operator can retry.
      loadPending();
    } finally {
      setApproving(null);
    }
  }, [user, tid, operatorAmount, queryClient, pickedId, loadPending]);

  // Cancel a pending undo timer (no backend call has happened yet).
  const cancelPendingApprove = useCallback((id: string) => {
    const timer = undoTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      undoTimersRef.current.delete(id);
    }
    const cd = countdownTimersRef.current.get(id);
    if (cd) {
      clearInterval(cd);
      countdownTimersRef.current.delete(id);
    }
    pendingMatchesRef.current.delete(id);
    setUndoCountdown((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setPendingUndoIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Schedules an approval to fire in `UNDO_DELAY_MS`. The row is shown
  // as "approving (undoable)" immediately for instant feedback, but the
  // backend `approve-deposit` call only runs if the operator doesn't
  // click Undo before the timer elapses.
  // On phones (where this dialog gets backgrounded most often) we
  // shorten the window so commits land faster and there's less chance
  // of the operator wandering off mid-undo.
  const isMobileViewport =
    typeof window !== 'undefined' && window.innerWidth < 640;
  const UNDO_DELAY_MS = isMobileViewport ? 3000 : 5000;
  const handleAutoApprove = useCallback((match: MatchResult) => {
    // If a previous undo for this row is still queued, ignore the
    // duplicate click — the timer is already running.
    if (undoTimersRef.current.has(match.id)) return;

    setPendingUndoIds(prev => new Set(prev).add(match.id));
    pendingMatchesRef.current.set(match.id, match);
    // Start a 1-second-tick countdown for the per-row UI.
    const totalSeconds = Math.ceil(UNDO_DELAY_MS / 1000);
    setUndoCountdown((prev) => {
      const next = new Map(prev);
      next.set(match.id, totalSeconds);
      return next;
    });
    const interval = setInterval(() => {
      setUndoCountdown((prev) => {
        const cur = prev.get(match.id);
        if (cur === undefined) return prev;
        const next = new Map(prev);
        if (cur <= 1) {
          next.delete(match.id);
        } else {
          next.set(match.id, cur - 1);
        }
        return next;
      });
    }, 1000);
    countdownTimersRef.current.set(match.id, interval);

    const timer = setTimeout(() => {
      undoTimersRef.current.delete(match.id);
      const cd = countdownTimersRef.current.get(match.id);
      if (cd) {
        clearInterval(cd);
        countdownTimersRef.current.delete(match.id);
      }
      setUndoCountdown((prev) => {
        if (!prev.has(match.id)) return prev;
        const next = new Map(prev);
        next.delete(match.id);
        return next;
      });
      setPendingUndoIds(prev => {
        if (!prev.has(match.id)) return prev;
        const next = new Set(prev);
        next.delete(match.id);
        return next;
      });
      void commitApprove(match);
    }, UNDO_DELAY_MS);
    undoTimersRef.current.set(match.id, timer);

    toast(`Approving ${formatUGX(match.amount)} — ${match.userName}`, {
      description: `Will commit in ${totalSeconds} seconds. Tap Undo to cancel.`,
      duration: UNDO_DELAY_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          cancelPendingApprove(match.id);
          toast.info(`Cancelled approval for ${match.userName}`);
        },
      },
    });
  }, [commitApprove, cancelPendingApprove, UNDO_DELAY_MS]);

  const handleAutoApproveAll = useCallback(() => {
    const exact = matches.filter(
      m => m.status === 'matched' &&
           !approvedIds.has(m.id) &&
           !undoTimersRef.current.has(m.id),
    );
    if (exact.length === 0) return;
    exact.forEach(match => handleAutoApprove(match));
  }, [matches, approvedIds, handleAutoApprove]);

  // Keep a ref to the latest `commitApprove` so the unmount /
  // `beforeunload` flush handlers always see the current closure
  // (state, user, etc.) rather than a stale one captured on first
  // mount. Without this, flushing-on-unmount would commit against an
  // outdated `tid`/`operatorAmount`/`user`.
  const commitApproveRef = useRef(commitApprove);
  useEffect(() => {
    commitApproveRef.current = commitApprove;
  }, [commitApprove]);

  // On unmount: do NOT silently drop queued approvals. If the operator
  // approved a row and then closed the dialog before the undo window
  // elapsed, fire the backend commit anyway. This is the durability
  // guarantee that fixes "verified deposits don't disappear".
  useEffect(() => {
    const timers = undoTimersRef.current;
    const countdowns = countdownTimersRef.current;
    const queued = pendingMatchesRef.current;
    return () => {
      // Cancel the timers (we're about to fire manually).
      timers.forEach(t => clearTimeout(t));
      timers.clear();
      countdowns.forEach(c => clearInterval(c));
      countdowns.clear();
      // Flush any in-flight approvals — fire-and-forget through the
      // latest closure so credentials + payload are correct.
      queued.forEach((match) => {
        try { void commitApproveRef.current(match); } catch { /* noop */ }
      });
      queued.clear();
    };
  }, []);

  // If the user closes the tab or navigates away during the undo
  // window, use sendBeacon to flush queued approvals to the edge
  // function before the page unloads. This is best-effort — sendBeacon
  // doesn't surface a response, but it reliably gets the request out
  // even from a backgrounded mobile tab.
  useEffect(() => {
    const handler = () => {
      const queued = pendingMatchesRef.current;
      if (queued.size === 0) return;
      try {
        const url =
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/approve-deposit`;
        // Auth — pull the access token from the active session
        // synchronously via the cached supabase auth storage.
        // sendBeacon doesn't accept custom headers, so we ship the
        // token in the body. The edge function's auth check accepts
        // `access_token` in the body as a fallback for beacons.
        let accessToken: string | null = null;
        try {
          const raw = localStorage.getItem(
            `sb-${import.meta.env.VITE_SUPABASE_PROJECT_ID}-auth-token`,
          );
          if (raw) accessToken = JSON.parse(raw)?.access_token ?? null;
        } catch { /* ignore */ }
        queued.forEach((match) => {
          const blob = new Blob(
            [JSON.stringify({
              deposit_request_id: match.id,
              action: 'approve',
              access_token: accessToken,
            })],
            { type: 'application/json' },
          );
          navigator.sendBeacon?.(url, blob);
        });
      } catch { /* best-effort */ }
    };
    window.addEventListener('beforeunload', handler);
    window.addEventListener('pagehide', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('pagehide', handler);
    };
  }, []);

  const openRejectDialog = (id: string) => {
    setRejectingId(id);
    setRejectionReason('');
    setRejectDialogOpen(true);
  };

  const handleReject = useCallback(async () => {
    if (!user || !rejectingId || rejectionReason.trim().length < 10) return;
    setRejecting(true);

    try {
      const { data, error } = await supabase.functions.invoke('approve-deposit', {
        body: { deposit_request_id: rejectingId, action: 'reject', rejection_reason: rejectionReason.trim() },
      });

      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Failed to reject deposit');
        throw new Error(msg);
      }

      const result = Array.isArray((data as any)?.results)
        ? (data as any).results.find((r: any) => r.id === rejectingId)
        : null;
      if ((data as any)?.success === false || result?.status === 'error') {
        throw new Error('Rejection did not complete — deposit remains pending for retry.');
      }

      // Reject can be triggered from the matched-results card OR from a row
      // in the pending pick-list. Fall back to the pending row so the audit
      // log still captures who/what we rejected.
      const match = matches.find(m => m.id === rejectingId);
      const pendingRow = !match ? pending.find(p => p.id === rejectingId) : null;
      const depositorName = match?.userName || pendingRow?.depositorName;
      const depositorAmount = match?.amount ?? pendingRow?.amount;
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'tid_verified_reject',
        table_name: 'deposit_requests',
        record_id: rejectingId,
        metadata: {
          transaction_id: match?.transaction_id,
          amount: depositorAmount,
          depositor_name: depositorName,
          rejection_reason: rejectionReason.trim(),
          operator_entered_tid: tid.trim(),
          operator_entered_amount: operatorAmount,
          source: match ? 'matched_card' : 'pending_list',
        },
      });

      setRejectedIds(prev => new Set(prev).add(rejectingId));
      toast.success(`Rejected deposit for ${depositorName || 'user'}`);

      queryClient.invalidateQueries({ queryKey: ['approval-queue-deposits'] });
      queryClient.invalidateQueries({ queryKey: ['financial-ops-pulse'] });

      // Refresh the pick-list so the just-rejected depositor disappears.
      if (pickedId === rejectingId) setPickedId(null);
      loadPending();
    } catch (err: any) {
      toast.error(err.message || 'Rejection failed');
    } finally {
      setRejecting(false);
      setRejectDialogOpen(false);
      setRejectingId(null);
    }
  }, [user, rejectingId, rejectionReason, matches, pending, tid, operatorAmount, queryClient, pickedId, loadPending]);

  const reset = () => {
    setTid('');
    setOperatorAmount('');
    setMatches([]);
    setResultState('idle');
    setApprovedIds(new Set());
    setRejectedIds(new Set());
  };

  const pendingMatches = matches.filter(m => m.status === 'matched' && !approvedIds.has(m.id) && !rejectedIds.has(m.id));

  // Tiny presentational helper — circular numbered badge + heading row.
  // Kept inline to avoid yet another file; semantic tokens only so it
  // theme-flips cleanly in dark mode.
  const StepHeader = ({
    n,
    title,
    subtitle,
  }: { n: number; title: string; subtitle?: string }) => (
    <div className="flex items-start gap-3">
      <div
        aria-hidden="true"
        className="h-7 w-7 sm:h-8 sm:w-8 shrink-0 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm sm:text-base font-bold"
      >
        {n}
      </div>
      <div className="min-w-0 pt-0.5">
        <p className="font-semibold text-sm sm:text-base leading-tight">{title}</p>
        {subtitle && (
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{subtitle}</p>
        )}
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-3 px-4 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Verify a user deposit
        </CardTitle>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Pick who paid, type their Transaction ID, then tap Approve. The row stays for a few seconds so you can Undo.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 px-4 sm:px-6 pb-24 sm:pb-5">
        {/* Toasts when an operational-float request is moved back to the
            pending queue (reopened) — so Fin Ops verifying in this screen
            knows a new item just appeared without waiting for a refresh. */}
        <OpFloatReopenNotifier />
        {/* Operator quality self-view — shows how many provider-mismatch
            attempts the current operator has triggered today. Helps build
            self-awareness without waiting for a CFO review. */}
        <OperatorMismatchTodayBadge />
        {/* ── Step 1 ───────────────────────────────────────────────────── */}
        <StepHeader
          n={1}
          title="Pick who paid"
          subtitle="Tap who is paying so the amount auto-fills."
        />
        {/* Pending depositors for the selected provider — operator can pick
            a row to prefill the expected amount, then just type the
            TID/receipt/bank reference from their statement. */}
        <div className="rounded-md border bg-muted/20">
          {/* Screen-reader-only live region announces highlighted/picked
              depositor as the operator arrow-keys through the list. */}
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {pendingLiveMessage}
          </div>
          {/* Auto-pick confirmation banner — shows briefly when filters
              narrow the list to one row and we auto-select it, with an
              Undo link that restores the prior form snapshot. */}
          {autoPicked && (
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-primary/10 border-b border-primary/20 text-[11px]">
              <div className="flex items-center gap-1.5 min-w-0">
                <Zap className="h-3 w-3 text-primary shrink-0" />
                <span className="truncate">
                  Auto-picked{' '}
                  <span className="font-semibold">{autoPicked.name}</span>{' '}
                  <span className="text-muted-foreground">({formatUGX(autoPicked.amount)})</span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPickedId(autoPicked.prev.pickedId);
                  setPickedProvider(autoPicked.prev.pickedProvider);
                  setOperatorAmount(autoPicked.prev.operatorAmount);
                  setProvider(autoPicked.prev.provider);
                  setAutoPicked(null);
                }}
                className="text-primary hover:underline font-medium shrink-0"
              >
                Undo
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/60">
            <div className="flex items-center gap-2 min-w-0">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Pending {pendingProviderFilter === 'all' ? 'all' : pendingProviderFilter.replace('_', ' ')} deposits
                {pending.length > 0 && (
                  <span className="ml-1 text-muted-foreground/80">
                    ({pendingSearch.trim() ? `${pendingFiltered.length}/${pending.length}` : pending.length})
                  </span>
                )}
              </Label>
              {pending.length > 0 && (
                <span className="hidden sm:inline text-[10px] text-muted-foreground/70">
                  ↑↓ navigate · Enter pick · Esc clear search
                </span>
              )}
            </div>
            {pickedId && (
              <button
                type="button"
                onClick={() => { setPickedId(null); setPickedProvider(null); setOperatorAmount(''); }}
                className="text-[10px] text-muted-foreground hover:text-foreground underline"
              >
                Clear pick
              </button>
            )}
          </div>
          {/* Search by name, phone, or amount — purely client-side over the
              already-loaded pending rows. */}
          {pending.length > 0 && (
            <div className="px-2.5 py-2 border-b border-border/60 space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  ref={pendingSearchInputRef}
                  value={pendingSearch}
                  onChange={(e) => setPendingSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc while typing clears the search box.
                    if (e.key === 'Escape' && pendingSearch) {
                      e.preventDefault();
                      setPendingSearch('');
                    }
                    // ↓ from the search box jumps focus into the list so
                    // the operator can keep flowing without reaching for
                    // the mouse.
                    if (e.key === 'ArrowDown' && pendingSorted.length > 0) {
                      e.preventDefault();
                      setHighlightedIndex(0);
                      pendingItemRefs.current[0]?.focus();
                    }
                  }}
                  placeholder={
                    matchField === 'name' ? 'Search depositor name…'
                    : matchField === 'phone' ? 'Search phone number…'
                    : matchField === 'amount' ? 'Search amount (digits)…'
                    : 'Search name, phone, or amount…'
                  }
                  className="h-8 pl-7 pr-7 text-xs"
                />
                {pendingSearch && (
                  <button
                    type="button"
                    onClick={() => setPendingSearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Quick filter chips — three rows, each scoped to a different
                  facet so operators can carve down the list without typing.
                  All chips compose with the search box and with each other. */}
              <div className="space-y-1.5">
                <FilterChipRow
                  label="Provider"
                  value={pendingProviderFilter}
                  onChange={(v) => setPendingProviderFilter(v)}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'mtn', label: 'MTN' },
                    { value: 'airtel', label: 'Airtel' },
                    { value: 'bank_transfer', label: 'Bank' },
                    { value: 'agent_cash', label: 'Agent Cash' },
                  ]}
                />
                <FilterChipRow
                  label="Match"
                  value={matchField}
                  onChange={(v) => setMatchField(v as MatchField)}
                  options={[
                    { value: 'any', label: 'Any' },
                    { value: 'name', label: 'Name' },
                    { value: 'phone', label: 'Phone' },
                    { value: 'amount', label: 'Amount' },
                  ]}
                />
                <FilterChipRow
                  label="Amount"
                  value={amountRange}
                  onChange={(v) => setAmountRange(v as AmountRange)}
                  options={[
                    { value: 'any', label: 'Any' },
                    { value: 'low', label: '< 50K' },
                    { value: 'mid', label: '50K–200K' },
                    { value: 'high', label: '> 200K' },
                  ]}
                />
                <FilterChipRow
                  label="Profile"
                  value={verification}
                  onChange={(v) => setVerification(v as Verification)}
                  options={[
                    { value: 'any', label: 'Any' },
                    { value: 'verified', label: 'Verified' },
                    { value: 'unverified', label: 'Unverified' },
                  ]}
                />
                <FilterChipRow
                  label="Float"
                  value={opFloatFilter}
                  onChange={(v) => setOpFloatFilter(v as OpFloatFilter)}
                  options={[
                    { value: 'any', label: 'Any' },
                    { value: 'non_op_float', label: 'Not Op. Float' },
                  ]}
                />
                {filtersActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setMatchField('any');
                      setAmountRange('any');
                      setVerification('any');
                      setOpFloatFilter('any');
                    }}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            </div>
          )}
          {pendingLoading ? (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading pending deposits…
            </div>
          ) : pending.length === 0 ? (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground italic">
              No pending {provider.replace('_', ' ')} deposits — switch provider above to see other channels.
            </div>
          ) : pendingFiltered.length === 0 ? (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground italic">
              No depositors match “{pendingSearch}”.
            </div>
          ) : (
            <>
              {/* Sortable column header — three buttons matching the row
                  layout (name+phone on the left, amount on the right). Click
                  cycles asc → desc → off. */}
              <div
                role="row"
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/60 bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => toggleSort('name')}
                    aria-label="Sort by depositor name"
                    aria-sort={sortColumn === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="flex items-center gap-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1"
                  >
                    Name
                    {sortColumn === 'name'
                      ? (sortDir === 'asc'
                          ? <ArrowUp className="h-2.5 w-2.5 text-primary" />
                          : <ArrowDown className="h-2.5 w-2.5 text-primary" />)
                      : <ArrowUpDown className="h-2.5 w-2.5 opacity-50" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleSort('phone')}
                    aria-label="Sort by phone number"
                    aria-sort={sortColumn === 'phone' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="flex items-center gap-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1"
                  >
                    Phone
                    {sortColumn === 'phone'
                      ? (sortDir === 'asc'
                          ? <ArrowUp className="h-2.5 w-2.5 text-primary" />
                          : <ArrowDown className="h-2.5 w-2.5 text-primary" />)
                      : <ArrowUpDown className="h-2.5 w-2.5 opacity-50" />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => toggleSort('amount')}
                  aria-label="Sort by amount"
                  aria-sort={sortColumn === 'amount' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="flex items-center gap-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1"
                >
                  Amount
                  {sortColumn === 'amount'
                    ? (sortDir === 'asc'
                        ? <ArrowUp className="h-2.5 w-2.5 text-primary" />
                        : <ArrowDown className="h-2.5 w-2.5 text-primary" />)
                    : <ArrowUpDown className="h-2.5 w-2.5 opacity-50" />}
                </button>
              </div>
              <ScrollArea className="h-[28rem] max-h-[60vh]">
                <ul
                ref={pendingListRef}
                role="listbox"
                aria-label="Pending depositors"
                tabIndex={0}
                onKeyDown={handlePendingKeyDown}
                className="divide-y divide-border/60 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
              >
                {pendingSorted.map((p, idx) => {
                   const active = p.id === pickedId;
                   const highlighted = idx === highlightedIndex;
                   const isApprovingRow = pendingUndoIds.has(p.id);
                   const isRejectedRow = rejectedIds.has(p.id);
                   const secondsLeft = undoCountdown.get(p.id);
                   return (
                     <li key={p.id} role="option" aria-selected={active}>
                       <div
                         className={`group relative flex items-stretch transition-colors ${
                           active ? 'bg-primary/10' : ''
                         } ${highlighted && !active ? 'bg-accent/40 ring-2 ring-inset ring-primary/60' : ''} ${
                           isApprovingRow ? 'bg-emerald-50 dark:bg-emerald-950/30 opacity-90' : ''
                         } ${isRejectedRow ? 'opacity-50' : ''} hover:bg-accent/40`}
                       >
                         <button
                           ref={(el) => { pendingItemRefs.current[idx] = el; }}
                           type="button"
                           onClick={() => {
                             if (isApprovingRow || isRejectedRow) return;
                             pickPending(p);
                             setHighlightedIndex(idx);
                           }}
                           onFocus={() => setHighlightedIndex(idx)}
                           disabled={isApprovingRow || isRejectedRow}
                           className={`flex-1 min-w-0 text-left px-2.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                             isApprovingRow ? 'cursor-progress' : ''
                           }`}
                         >
                           <div className="flex items-center justify-between gap-2">
                             <div className="min-w-0">
                               <p className="text-xs font-medium truncate">
                                 {p.depositorName}
                               </p>
                               {isApprovingRow ? (
                                 <p className="text-[10px] text-emerald-700 dark:text-emerald-400 font-medium truncate flex items-center gap-1">
                                   <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                   Approving in {secondsLeft ?? 0}…
                                 </p>
                               ) : (
                                  <>
                                    <p className="text-[10px] text-muted-foreground truncate">
                                      {p.depositorPhone || '—'} · {format(new Date(p.created_at), 'MMM d, HH:mm')}
                                    </p>
                                    {p.transaction_id ? (
                                      <p
                                        className="text-[10px] font-mono text-muted-foreground/90 truncate"
                                        title={`TID: ${p.transaction_id}`}
                                      >
                                        TID: <span className="text-foreground">{p.transaction_id}</span>
                                      </p>
                                    ) : (
                                      <p className="text-[10px] italic text-muted-foreground/60 truncate">
                                        No TID submitted yet
                                      </p>
                                    )}
                                  </>
                               )}
                             </div>
                             <div className="flex items-center gap-1.5 shrink-0">
                               <span className="text-xs font-semibold">{formatUGX(p.amount)}</span>
                               {active && !isApprovingRow && (
                                 <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                               )}
                               {isApprovingRow && (
                                 <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                               )}
                             </div>
                           </div>
                         </button>
                         {/* Per-row Reject — opens reason dialog. Hidden while
                             a pre-approval countdown is running on this row. */}
                         {!isApprovingRow && !isRejectedRow && (
                           <button
                             type="button"
                             title="Reject this deposit"
                             aria-label={`Reject deposit from ${p.depositorName}`}
                             onClick={(e) => {
                               e.stopPropagation();
                               openRejectDialog(p.id);
                             }}
                             className="shrink-0 px-2 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive border-l border-border/60"
                           >
                             <XCircle className="h-3.5 w-3.5" />
                           </button>
                         )}
                       </div>
                     </li>
                   );
                 })}
              </ul>
              {/* Infinite scroll sentinel + soft loading indicator. */}
              {pendingHasMore && !pendingSearch.trim() && (
                <div
                  ref={pendingSentinelRef}
                  className="flex items-center justify-center py-2 text-[11px] text-muted-foreground"
                  aria-hidden="true"
                >
                  {pendingLoadingMore ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading more…
                    </span>
                  ) : (
                    <span>Scroll for more</span>
                  )}
                </div>
              )}
              {pendingHasMore && (() => {
                // Pagination is keyset-based on the unfiltered list; once a
                // search filter is active, "Load more" can't meaningfully
                // extend the filtered view. Keep the button visible but
                // disabled (with a hint) so the affordance doesn't vanish
                // mid-interaction — operators can clear the search to
                // resume paging.
                const searchActive = !!pendingSearch.trim();
                return (
                  <div className="px-2.5 py-1.5 border-t border-border/60 space-y-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full h-7 text-[11px]"
                      onClick={loadMorePending}
                      disabled={pendingLoadingMore || searchActive}
                    >
                      {pendingLoadingMore ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                          Loading…
                        </>
                      ) : (
                        <>Load more (+{PENDING_PAGE_SIZE})</>
                      )}
                    </Button>
                    {searchActive && (
                      <p className="text-[10px] text-muted-foreground text-center leading-tight">
                        Clear the search to load more pending deposits.
                      </p>
                    )}
                  </div>
                );
              })()}
              </ScrollArea>
            </>
          )}
        </div>

        {/* ── Step 2 ───────────────────────────────────────────────────── */}
        <StepHeader
          n={2}
          title="Type the Transaction ID"
          subtitle="Copy it from the bank or MoMo statement. Confirm the amount and provider match."
        />
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Transaction ID / Receipt No. <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={tid}
                onChange={(e) => setTid(e.target.value.toUpperCase())}
                placeholder="e.g. MP241231... or WEL-00001"
                className="pl-9 h-12 font-mono text-base tracking-wide"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  if (providerMismatch) {
                    void logMismatchAttempt();
                    toast.error('Provider mismatch — restore the original provider or clear the pick.');
                    return;
                  }
                  handleVerify();
                }}
              />
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 space-y-1.5">
              <Label className="text-sm font-medium">
                Amount (UGX) <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                value={operatorAmount}
                onChange={(e) => setOperatorAmount(e.target.value)}
                placeholder="e.g. 50000"
                className="h-12 text-base"
              />
            </div>
            <div className="space-y-1.5 sm:min-w-[140px]">
              <Label className="text-sm font-medium">Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="h-12 text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtn">MTN</SelectItem>
                  <SelectItem value="airtel">Airtel</SelectItem>
                  <SelectItem value="bank_transfer">Bank</SelectItem>
                  <SelectItem value="agent_cash">Agent Cash</SelectItem>
                  <SelectItem value="agent_cash">Cash/Rcpt</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Step 3 ─────────────────────────────────────────────────── */}
          <StepHeader
            n={3}
            title="Verify & approve"
            subtitle="We'll search the pending queue and let you approve the match."
          />
          {pickedId && (() => {
            // Pre-submission recap so the operator can eyeball every key
            // field — including the picked deposit's *original* provider —
            // before clicking Verify & Match.
            const pickedRow = pending.find((p) => p.id === pickedId);
            if (!pickedRow) return null;
            const originalProvider = (pickedRow.provider ?? pickedProvider ?? '—')
              .replace('_', ' ')
              .toUpperCase();
            // Pull the picked row's REAL transaction_id so the recap shows
            // the source-of-truth TID — not whatever the operator typed.
            // The pick-list query doesn't fetch transaction_id, so fall back
            // to the typed value when it's missing on the row object.
            const pickedTid = pickedRow.transaction_id ?? undefined;
            const typedTid = tid.trim();
            const norm = (s: string) => s.replace(/[^0-9A-Z]/gi, '').toUpperCase();
            const tidsAgree = !!typedTid && !!pickedTid && norm(typedTid) === norm(pickedTid);
            const tidsConflict = !!typedTid && !!pickedTid && !tidsAgree;
            return (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 space-y-1.5 text-xs">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  About to verify
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-muted-foreground">Depositor</span>
                    <span className="font-medium truncate">{pickedRow.depositorName}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-muted-foreground">Amount</span>
                    <span className="font-semibold">{formatUGX(pickedRow.amount)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-muted-foreground">Original provider</span>
                    <Badge variant="secondary" className="text-[10px] uppercase">
                      {originalProvider}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-muted-foreground">TID on file</span>
                    <span className="font-mono text-[11px] truncate">
                      {pickedTid || <span className="text-muted-foreground italic">— (use typed)</span>}
                    </span>
                  </div>
                </div>
                {tidsConflict && (
                  <div className="mt-1.5 rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-destructive flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> TID does not match the picked deposit
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      You typed <span className="font-mono">{typedTid}</span> but this depositor's pending
                      record has <span className="font-mono">{pickedTid}</span>. Verify which is correct
                      before approving.
                    </p>
                    <div className="flex gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => setTid(pickedTid!)}
                        className="text-[10px] font-medium text-primary underline underline-offset-2 hover:no-underline"
                      >
                        Use TID on file
                      </button>
                      <span className="text-muted-foreground">·</span>
                      <button
                        type="button"
                        onClick={() => { setTid(''); }}
                        className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        Clear typed
                      </button>
                    </div>
                  </div>
                )}
                {tidsAgree && (
                  <p className="text-[10px] text-success flex items-center gap-1 pt-0.5">
                    <CheckCircle2 className="h-3 w-3" /> TID matches the deposit on file.
                  </p>
                )}
              </div>
            );
          })()}
          <Button
            onClick={() => {
              if (providerMismatch) {
                void logMismatchAttempt();
                toast.error('Provider mismatch — restore the original provider or clear the pick.');
                return;
              }
              handleVerify();
            }}
            // Keep the button enabled while mismatched so we can capture the
            // attempted click (and surface a clear toast). Visually it still
            // reads as a warning state via the variant change below.
            disabled={
              resultState === 'searching' ||
              !tid.trim() ||
              !operatorAmount
            }
            variant={providerMismatch ? 'outline' : 'default'}
            className="w-full h-12 sm:h-12 text-base font-semibold"
          >
            {resultState === 'searching' ? (
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
            ) : (
              <Search className="h-5 w-5 mr-2" />
            )}
            Verify &amp; Match
          </Button>
          {providerMismatch && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-warning-foreground">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
              <div className="space-y-1.5 min-w-0">
                <p>
                  You picked a deposit submitted as{' '}
                  <span className="font-semibold uppercase">
                    {(pickedProvider ?? '').replace('_', ' ')}
                  </span>{' '}
                  but the form is set to{' '}
                  <span className="font-semibold uppercase">{provider.replace('_', ' ')}</span>.
                  Verify on the original channel or clear the pick.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => pickedProvider && setProvider(pickedProvider)}
                    className="underline hover:text-foreground"
                  >
                    Restore {(pickedProvider ?? '').replace('_', ' ')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPickedId(null); setPickedProvider(null); setOperatorAmount(''); }}
                    className="underline hover:text-foreground"
                  >
                    Clear pick
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        <AnimatePresence mode="wait">
          {/* No matching pending deposit */}
          {resultState === 'not_found' && (
            <motion.div
              key="notfound"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center py-5 text-center rounded-lg border border-destructive/20 bg-destructive/5"
            >
              <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                <XCircle className="h-6 w-6 text-destructive" />
              </div>
              <p className="text-sm font-semibold">No Matching Deposit Found</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[280px]">
                No pending deposit matches this TID. The user must first submit a deposit through the app before it can be verified here.
              </p>
              <div className="flex items-center gap-1.5 mt-2">
                <Badge variant="outline" className="font-mono text-[10px]">{tid.trim()}</Badge>
                <Badge variant="secondary" className="text-[10px]">{formatUGX(parseFloat(operatorAmount))}</Badge>
              </div>
              <Button variant="outline" size="sm" className="mt-3" onClick={reset}>
                Try Another
              </Button>
            </motion.div>
          )}

          {/* Matches found */}
          {resultState === 'found' && matches.length > 0 && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/50 rounded-lg p-2">
                <div className="flex items-center gap-1.5 text-xs flex-wrap">
                  <Badge variant="outline" className="gap-1 text-[10px]">{matches.length} found</Badge>
                  {pendingMatches.length > 0 && (
                    <Badge className="gap-1 bg-emerald-600 text-[10px]">
                      <Zap className="h-2.5 w-2.5" /> {pendingMatches.length} ready
                    </Badge>
                  )}
                </div>
                {pendingMatches.length > 1 && (
                  <Button
                    size="sm"
                    className="h-9 text-sm gap-1.5"
                    onClick={handleAutoApproveAll}
                    disabled={!!approving}
                  >
                    <CheckCircle2 className="h-4 w-4" /> Approve all
                  </Button>
                )}
              </div>

              <ScrollArea className="max-h-[50vh]">
                <div className="space-y-2">
                  {matches.map((m) => {
                    const isApproved = approvedIds.has(m.id);
                    const isRejected = rejectedIds.has(m.id);
                    const isProcessing = approving === m.id;
                    const isUndoable = pendingUndoIds.has(m.id);
                    const isDone = isApproved || isRejected;
                    return (
                      <div
                        key={m.id}
                        className={`rounded-lg border p-2.5 transition-colors ${
                          isApproved
                            ? 'border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20'
                            : isRejected
                            ? 'border-destructive/30 bg-destructive/5'
                            : isUndoable
                            ? 'border-primary/40 bg-primary/5'
                            : m.status === 'matched'
                            ? 'border-emerald-200 bg-background'
                            : 'border-amber-200 bg-amber-50/30 dark:bg-amber-950/10'
                        }`}
                      >
                        <div className="space-y-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs sm:text-sm font-semibold truncate">{m.userName}</span>
                            <span className="text-xs sm:text-sm font-bold text-foreground shrink-0 tabular-nums">
                              {formatUGX(m.amount)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] text-muted-foreground">{m.userPhone}</span>
                            {m.transaction_id && (
                              <Badge variant="outline" className="font-mono text-[9px] h-4 px-1 gap-0.5 border-primary/30 text-primary">
                                <Hash className="h-2.5 w-2.5" /> ••••{m.transaction_id.slice(-2)}
                              </Badge>
                            )}
                            {m.deposit_purpose === 'operational_float' && (
                              <Badge className="bg-primary/15 text-primary text-[9px] h-4 gap-0.5 px-1 border border-primary/30">
                                <Users className="h-2.5 w-2.5" />
                                Op-Float · {m.allocations?.length ?? 0} tenants
                              </Badge>
                            )}
                            {m.deposit_purpose === 'personal_deposit' && (() => {
                              const audit = (m.purpose_audit ?? {}) as Record<string, unknown>;
                              const isAgentRow = audit.is_agent === true;
                              const confirmedAt = audit.agent_personal_confirmed_at;
                              if (isAgentRow && confirmedAt) {
                                return (
                                  <Badge className="bg-emerald-600/15 text-emerald-700 text-[9px] h-4 gap-0.5 px-1 border border-emerald-600/30">
                                    💰 Personal — confirmed
                                  </Badge>
                                );
                              }
                              if (isAgentRow && !confirmedAt) {
                                return (
                                  <Badge className="bg-amber-500/15 text-amber-700 text-[9px] h-4 gap-0.5 px-1 border border-amber-500/40">
                                    ⚠️ Personal — no confirm
                                  </Badge>
                                );
                              }
                              return (
                                <Badge variant="outline" className="text-[9px] h-4 gap-0.5 px-1 text-muted-foreground">
                                  💰 Personal
                                </Badge>
                              );
                            })()}
                            {m.matchedVia === 'notes' && (
                              <Badge variant="outline" className="text-[9px] h-4 gap-0.5 px-1 border-primary/30 text-primary">
                                <Receipt className="h-2.5 w-2.5" />
                                Matched via receipt
                              </Badge>
                            )}
                            {m.status === 'matched' ? (
                              <Badge className="bg-emerald-600 text-[9px] h-4 gap-0.5 px-1">
                                <CheckCircle2 className="h-2.5 w-2.5" /> Match
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-amber-600 border-amber-300 text-[9px] h-4 gap-0.5 px-1">
                                <AlertTriangle className="h-2.5 w-2.5" /> Amount Mismatch
                              </Badge>
                            )}
                            {isApproved && (
                              <Badge className="bg-emerald-700 text-[9px] h-4 px-1">Approved ✓</Badge>
                            )}
                            {isRejected && (
                              <Badge variant="destructive" className="text-[9px] h-4 px-1">Rejected ✗</Badge>
                            )}
                            {isUndoable && (
                              <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5 border-primary/40 text-primary">
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                Approving — undoable
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                            <span>{m.provider || 'MoMo'}</span>
                            <span>{format(new Date(m.created_at), 'dd MMM HH:mm')}</span>
                          </div>
                          {(() => {
                            const purpose = m.deposit_purpose ?? null;
                            const isOpFloat = purpose === 'operational_float';
                            const hasAgent = !!m.agent_id;
                            const allocCount = m.allocations?.length ?? 0;
                            const purposeLabel =
                              purpose === 'operational_float' ? 'Operational Float'
                              : purpose === 'personal_deposit' ? 'Personal Deposit'
                              : purpose === 'partnership_deposit' ? 'Partnership Deposit'
                              : purpose === 'personal_rent_repayment' ? 'Personal Rent Repayment'
                              : purpose === 'other' ? 'Other'
                              : purpose ?? '— (not set)';
                            // Build a short human-readable reason for why this
                            // row is / isn't categorised as Operational Float.
                            const reasons: string[] = [];
                            if (isOpFloat) {
                              reasons.push(`Purpose = "operational_float" → credits agent float bucket on approve.`);
                              if (hasAgent) reasons.push(`Linked agent set ✓ — float will land on that agent's wallet.`);
                              else reasons.push(`⚠️ No linked agent on the row — float will credit the depositor themselves.`);
                              if (allocCount > 0) reasons.push(`${allocCount} tenant allocation(s) attached for the post-approve loop.`);
                              else reasons.push(`No tenant breakdown — surplus will sit in float.`);
                            } else {
                              reasons.push(`Purpose = "${purpose ?? 'unset'}" — NOT operational_float, so nothing will hit any float bucket.`);
                              if (purpose === 'personal_deposit') {
                                reasons.push(`Goes straight to depositor's own withdrawable wallet.`);
                              } else if (purpose === 'personal_rent_repayment') {
                                reasons.push(`Goes against depositor's outstanding rent / advance.`);
                              } else if (purpose === 'partnership_deposit') {
                                reasons.push(`Routed to the linked partner — not the agent's float.`);
                              } else if (purpose === 'other' || !purpose) {
                                reasons.push(`Defaulted to depositor's withdrawable — agent (if any) gets no float credit.`);
                              }
                              if (hasAgent) reasons.push(`Has a linked agent_id, but agent linkage alone does NOT trigger float — purpose must be operational_float.`);
                              else reasons.push(`No linked agent (self-deposit).`);
                            }
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    className={`mt-1.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                                      isOpFloat
                                        ? 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'
                                        : 'border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10 text-amber-700 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-900/20'
                                    }`}
                                    aria-label={`Categorisation explanation: ${isOpFloat ? 'is' : 'is not'} operational float`}
                                  >
                                    {isOpFloat ? (
                                      <><Users className="h-2.5 w-2.5" /> Op-Float · {hasAgent ? 'linked' : 'unlinked'}</>
                                    ) : (
                                      <><Info className="h-2.5 w-2.5" /> Not float · {purposeLabel}</>
                                    )}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" align="start" className="max-w-xs p-2.5 text-[11px] leading-snug space-y-1">
                                  <p className="font-semibold">
                                    {isOpFloat ? 'Why this is Operational Float' : 'Why this is NOT Operational Float'}
                                  </p>
                                  <p className="text-muted-foreground">
                                    Purpose: <span className="font-mono text-foreground">{purposeLabel}</span>
                                    {' · '}Agent link: <span className="font-mono text-foreground">{hasAgent ? 'set' : 'none'}</span>
                                  </p>
                                  <ul className="list-disc pl-3.5 space-y-0.5">
                                    {reasons.map((r, i) => <li key={i}>{r}</li>)}
                                  </ul>
                                </TooltipContent>
                              </Tooltip>
                            );
                          })()}
                          {m.deposit_purpose === 'operational_float' && m.allocations && m.allocations.length > 0 && (
                            <div className="mt-1.5 rounded-md border border-border bg-muted/40 p-1.5 space-y-0.5">
                              <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
                                <Users className="h-2.5 w-2.5" />
                                Tenant breakdown — verify before approving
                              </p>
                              <div className="max-h-28 overflow-y-auto divide-y divide-border/60">
                                {m.allocations.map((a) => (
                                  <div key={a.tenant_id} className="flex items-center justify-between text-[10px] py-0.5">
                                    <span className="truncate text-foreground">{a.tenant_name}</span>
                                    <span className="font-mono tabular-nums shrink-0 ml-2">
                                      {formatUGX(a.amount)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <div className="flex items-center justify-between text-[10px] pt-0.5 border-t border-border/60">
                                <span className="text-muted-foreground">Allocated total</span>
                                <span className="font-mono font-semibold tabular-nums">
                                  {formatUGX(m.allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0))}
                                </span>
                              </div>
                            </div>
                          )}
                          {!isDone && isUndoable && (
                            <div className="flex flex-col sm:flex-row gap-2 mt-2">
                              <Button
                                variant="outline"
                                className="h-11 text-sm gap-1.5 flex-1 border-primary/40 text-primary hover:bg-primary/5"
                                onClick={() => cancelPendingApprove(m.id)}
                              >
                                <ArrowLeft className="h-4 w-4" />
                                Undo approval
                              </Button>
                            </div>
                          )}
                          {!isDone && !isUndoable && (
                            <div className="flex flex-col sm:flex-row gap-2 mt-2">
                              {m.status === 'matched' && (
                                <Button
                                  className="h-11 text-sm gap-1.5 flex-1"
                                  disabled={isProcessing}
                                  onClick={() => handleAutoApprove(m)}
                                >
                                  {isProcessing ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <ArrowRight className="h-4 w-4" />
                                  )}
                                  Approve & remove from list
                                </Button>
                              )}
                              <Button
                                variant="destructive"
                                className="h-11 text-sm gap-1.5 flex-1"
                                onClick={() => openRejectDialog(m.id)}
                              >
                                <Ban className="h-4 w-4" /> Reject
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>

              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={reset} className="text-xs">Clear & Verify Another</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Reject Confirmation Dialog */}
        <AlertDialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reject Deposit</AlertDialogTitle>
              <AlertDialogDescription>
                A clear rejection reason is <span className="font-semibold text-foreground">required</span>.
                It will be sent to the depositor, stored on the deposit record, and written to the audit log
                for later reconciliation.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1">
              <label className="text-xs font-medium flex items-center gap-1">
                Rejection reason <span className="text-destructive">*</span>
              </label>
              <Textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="e.g. Transaction ID does not match any MTN statement entry for this date"
                className="min-h-[80px]"
                aria-required="true"
              />
              <div className="flex items-center justify-between text-[11px]">
                <span
                  className={
                    rejectionReason.trim().length < 10
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {rejectionReason.trim().length < 10
                    ? `Need at least ${10 - rejectionReason.trim().length} more character${10 - rejectionReason.trim().length === 1 ? '' : 's'}`
                    : 'Looks good'}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {rejectionReason.trim().length}/1000
                </span>
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={rejecting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleReject}
                disabled={rejecting || rejectionReason.trim().length < 10}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {rejecting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Ban className="h-3 w-3 mr-1" />}
                Confirm Reject
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ── Sticky mobile action bar ────────────────────────────────────
         * Pins the contextually-primary action to the bottom of the
         * viewport on small screens so operators can finish a step
         * (Verify, Approve, Approve all) without scrolling back to the
         * inline button. Hidden on `sm` and up — desktop already shows
         * everything above the fold.
         *
         * Action picked by current state:
         *   • matches found + ≥2 ready  → "Approve all (n)"
         *   • matches found + 1 ready   → "Approve {amount}"
         *   • otherwise                 → "Verify & Match" (mirrors the
         *     inline Verify button, including provider-mismatch capture).
         */}
        {(() => {
          const inFoundState = resultState === 'found' && matches.length > 0;
          const readyCount = pendingMatches.length;
          const onlyReady = readyCount === 1 ? pendingMatches[0] : null;

          // Don't render when there's nothing meaningful to do (e.g. before
          // the operator has typed anything and no matches are showing).
          const verifyDisabled =
            resultState === 'searching' || !tid.trim() || !operatorAmount;
          if (!inFoundState && verifyDisabled && !providerMismatch) return null;

          /**
           * Real-time progress for the sticky bar.
           *
           *   verifying   – `handleVerify` is searching the deposits table
           *   approving   – at least one match is in its 5s undoable window
           *                 OR the backend `approve-deposit` call is live
           *   done        – every visible match is already approved/rejected
           *
           * The bar shows a `Progress` driven by these phases so the operator
           * can see something is happening even before the row UI updates.
           */
          const totalActionable = inFoundState
            ? matches.filter(m => m.status === 'matched').length
            : 0;
          const settledCount = inFoundState
            ? matches.filter(m => m.status === 'matched' && (approvedIds.has(m.id) || rejectedIds.has(m.id))).length
            : 0;
          const inFlightCount = inFoundState
            ? matches.filter(
                m => m.status === 'matched' &&
                     !approvedIds.has(m.id) &&
                     !rejectedIds.has(m.id) &&
                     (pendingUndoIds.has(m.id) || approving === m.id),
              ).length
            : 0;

          let phase: 'idle' | 'verifying' | 'approving' | 'done' = 'idle';
          let phaseLabel = '';
          let phaseValue = 0;
          let phaseVariant: 'default' | 'success' = 'default';

          if (resultState === 'searching') {
            phase = 'verifying';
            phaseLabel = 'Verifying transaction…';
            phaseValue = 35;
          } else if (inFoundState && totalActionable > 0 && settledCount === totalActionable) {
            phase = 'done';
            phaseLabel = `All ${totalActionable} approved`;
            phaseValue = 100;
            phaseVariant = 'success';
          } else if (inFlightCount > 0) {
            phase = 'approving';
            // Count an in-flight item as 50% so progress visibly advances even
            // before the row settles into approved.
            const progressed = settledCount + inFlightCount * 0.5;
            phaseValue = totalActionable > 0
              ? Math.min(99, Math.round((progressed / totalActionable) * 100))
              : 60;
            phaseLabel = approving
              ? `Approving ${settledCount + 1}/${totalActionable || 1}…`
              : `Approving ${inFlightCount > 1 ? `${inFlightCount} matches` : '1 match'} — undoable`;
          }

          return (
            <div
              className="sm:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_-4px_hsl(var(--foreground)/0.08)]"
              role="region"
              aria-label="Primary action"
            >
              {phase !== 'idle' && (
                <div className="mb-2" aria-live="polite">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] font-medium text-muted-foreground inline-flex items-center gap-1.5">
                      {phase !== 'done' && <Loader2 className="h-3 w-3 animate-spin" />}
                      {phase === 'done' && <CheckCircle2 className="h-3 w-3 text-success" />}
                      {phaseLabel}
                    </span>
                    {totalActionable > 0 && (
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {settledCount}/{totalActionable}
                      </span>
                    )}
                  </div>
                  <Progress value={phaseValue} size="sm" variant={phaseVariant} />
                </div>
              )}
              {inFoundState && readyCount >= 2 ? (
                <>
                  <Button
                    size="lg"
                    className="w-full h-12 text-base font-semibold gap-2"
                    onClick={handleAutoApproveAll}
                    disabled={!!approving}
                  >
                    <CheckCircle2 className="h-5 w-5" />
                    Approve all ({readyCount})
                  </Button>
                  <p className="text-[10px] text-center text-muted-foreground mt-1.5">
                    Stays here for {Math.ceil(UNDO_DELAY_MS / 1000)} seconds in case you tapped the wrong one — tap Undo to cancel.
                  </p>
                </>
              ) : inFoundState && onlyReady ? (
                <>
                  <Button
                    size="lg"
                    className="w-full h-12 text-base font-semibold gap-2"
                    onClick={() => handleAutoApprove(onlyReady)}
                    disabled={!!approving}
                  >
                    {approving === onlyReady.id ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-5 w-5" />
                    )}
                    Approve {formatUGX(onlyReady.amount)} & remove from list
                  </Button>
                  <p className="text-[10px] text-center text-muted-foreground mt-1.5">
                    Stays here for {Math.ceil(UNDO_DELAY_MS / 1000)} seconds in case you tapped the wrong one — tap Undo to cancel.
                  </p>
                </>
              ) : (
                <Button
                  size="lg"
                  variant={providerMismatch ? 'outline' : 'default'}
                  className="w-full h-12 text-base font-semibold gap-2"
                  onClick={() => {
                    if (providerMismatch) {
                      void logMismatchAttempt();
                      toast.error('Provider mismatch — restore the original provider or clear the pick.');
                      return;
                    }
                    handleVerify();
                  }}
                  disabled={verifyDisabled}
                >
                  {resultState === 'searching' ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Search className="h-5 w-5" />
                  )}
                  Verify &amp; Match
                </Button>
              )}
            </div>
          );
        })()}

      </CardContent>
    </Card>
  );
}
