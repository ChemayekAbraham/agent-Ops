import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { normalizeMomoTid } from '@/lib/momoTid';
import type { PrefilledUser } from '@/components/financial-ops/RouteEmailDepositDialog';
import type { UserResult } from '@/components/cfo/UserSearchPicker';
import {
  normalizeUgPhone,
  extractPhones,
  extractFromPhones,
  extractToPhones,
  extractReferences,
  extractToNames,
  extractFromNames,
} from '@/components/financial-ops/emailExtraction';
import {
  type GmailTx,
  type PollState,
  type MatchedUser,
  type ChannelResult,
  type ChannelCacheEntry,
  type StoredUserRule,
  readChannelCache,
  writeChannelCache,
  readStoredUserRules,
  writeStoredUserRules,
  refreshUserRules,
  zonedWallClockToUtcMs,
  dateKeyInTz,
  extractCashReceiptCode,
  isWelileOutboundEcho,
  isUnparsedRow,
  validateGmailTx,
  deriveChannel,
  EXPANDED_ROWS_KEY,
} from '@/lib/emailTransactionsLogic';
import { AlertOctagon, ArrowDownLeft, ArrowUpRight, CheckCircle2, Inbox, Send } from 'lucide-react';

/** Plain-language mapping of a Gmail polling error, used for the toast copy. */
function friendlyPollError(raw: string | null | undefined): { title: string; description: string } {
  const m = (raw || '').toLowerCase();
  if (m.includes('google_mail_api_key') || m.includes('not connected') || m.includes('not configured')) {
    return { title: "Gmail isn't connected", description: 'Connect a Gmail account before polling.' };
  }
  if (m.includes('invalid credentials') || m.includes('unauthenticated') || m.includes('[401]') || m.includes(' 401')) {
    return { title: 'Gmail session expired', description: 'Click Reconnect Gmail to re-authenticate.' };
  }
  if (m.includes('insufficient') || m.includes('scope') || m.includes('[403]') || m.includes(' 403')) {
    return { title: 'Missing Gmail permission', description: 'Reconnect Gmail and approve all requested permissions.' };
  }
  if (m.includes('429') || m.includes('rate') || m.includes('quota')) {
    return { title: 'Gmail rate limit hit', description: 'Wait a minute, then click Retry.' };
  }
  if (m.includes('502') || m.includes('503') || m.includes('504') || m.includes('timeout') || m.includes('fetch')) {
    return { title: 'Network or gateway hiccup', description: 'A transient error occurred. Click Retry to try again.' };
  }
  return { title: 'Polling failed', description: raw?.slice(0, 200) || 'Unknown error. Click Retry to try again.' };
}


export type PaginationMode = 'paged' | 'infinite';
export type SortMode = 'newest' | 'oldest' | 'amount_high' | 'amount_low' | 'status';

/**
 * A single re-routing action against an email (forward credit + any reversal
 * legs against an earlier auto-credited user).
 */
export interface RoutingHistoryEntry {
  id: string;
  created_at: string;
  route: string;
  reason: string;
  target_user_id: string;
  target_user_name: string | null;
  target_user_phone: string | null;
  routed_by_name: string | null;
  amount: number;
  sms_sent: boolean;
}

/**
 * All state, data-fetching and business logic for the Financial Ops "Email
 * Transactions" panel (`EmailTransactionsPanel.tsx`). Relocated verbatim out
 * of the component — same state shapes, same effects, same handlers, zero
 * behavior change — so the panel's JSX/layout can be rebuilt without
 * touching business logic. See docs/HANDOVER for the refactor note.
 *
 * The returned object's keys match the original component's local variable
 * names 1:1; the component destructures this hook's return value and its
 * JSX is otherwise unchanged.
 */
export function useEmailTransactionsPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<GmailTx[]>([]);
  const [state, setState] = useState<PollState | null>(null);
  /**
   * Why the list is empty. A read blocked by row-level security used to look
   * identical to "no emails captured yet" because the loader swallowed the
   * PostgREST error — so staff who can open the page but can't read the table
   * saw a friendly (and wrong) empty state.
   */
  const [loadError, setLoadError] = useState<{ message: string; denied: boolean } | null>(null);

  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(
    () => (typeof window !== 'undefined' ? localStorage.getItem('gmail_last_success_at') : null)
  );
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  // Date-range filter (inclusive). Defaults to "today" in the operator's
  // timezone so the report opens scoped to today; users can pick any other
  // period (yesterday, 7d, etc.) and the selection is persisted across reloads.
  const initialTz = (() => {
    if (typeof window === 'undefined') return 'Africa/Kampala';
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return localStorage.getItem('gmail_filter_tz') || browserTz || 'Africa/Kampala';
  })();
  const todayKeyInitial = typeof window === 'undefined' ? '' : dateKeyInTz(new Date(), initialTz);
  const [fromDate, setFromDate] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const saved = localStorage.getItem('gmail_filter_from');
    return saved === null ? todayKeyInitial : saved;
  });
  const [toDate, setToDate] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const saved = localStorage.getItem('gmail_filter_to');
    return saved === null ? todayKeyInitial : saved;
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_from', fromDate); } catch {} }, [fromDate]);
  useEffect(() => { try { localStorage.setItem('gmail_filter_to', toDate); } catch {} }, [toDate]);
  // Timezone in which `fromDate`/`toDate` are interpreted and daily buckets are grouped.
  const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const [tz, setTz] = useState<string>(() => {
    if (typeof window === 'undefined') return browserTz || 'Africa/Kampala';
    return localStorage.getItem('gmail_filter_tz') || browserTz || 'Africa/Kampala';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_tz', tz); } catch {} }, [tz]);
  // Configurable warning threshold for |net|. Persisted in localStorage. Default 1,000,000 UGX.
  const [netThreshold, setNetThreshold] = useState<number>(() => {
    if (typeof window === 'undefined') return 1_000_000;
    const raw = localStorage.getItem('gmail_net_threshold');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
  });
  useEffect(() => {
    try { localStorage.setItem('gmail_net_threshold', String(netThreshold)); } catch {}
  }, [netThreshold]);

  // Free-text search across transaction id, bank reference number, receipt
  // number, subject, snippet and counterparty. Persisted in localStorage so
  // the filter survives a page refresh. Whitespace-separated tokens are
  // AND-matched; each token is matched case-insensitively as a substring.
  const [searchQuery, setSearchQuery] = useState<string>(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('gmail_filter_search') || '')
  );
  useEffect(() => { try { localStorage.setItem('gmail_filter_search', searchQuery); } catch {} }, [searchQuery]);
  // Gmail's "Show search options" panel — collapsed by default, holds the
  // advanced refinements (From, date window, sort) exactly like Gmail does.
  const [searchOptionsOpen, setSearchOptionsOpen] = useState(false);
  // Dedicated depositor-phone filter — narrows the list to a single phone
  // number in any printed format (0…, 256…, +256…, 7…). Matched against the
  // email counterparty / sender / body and the resolved depositing user's
  // phone. Persisted so the filter survives a refresh.
  const [phoneQuery, setPhoneQuery] = useState<string>(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('gmail_filter_phone') || '')
  );
  useEffect(() => { try { localStorage.setItem('gmail_filter_phone', phoneQuery); } catch {} }, [phoneQuery]);
  // Pagination for the Recent emails list. Page size is user-selectable and
  // persisted; current page resets to 1 whenever any filter changes.
  const [pageSize, setPageSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 50;
    const v = Number(localStorage.getItem('gmail_filter_page_size') || '50');
    return [25, 50, 100, 200, 500].includes(v) ? v : 50;
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_page_size', String(pageSize)); } catch {} }, [pageSize]);
  const [currentPage, setCurrentPage] = useState<number>(1);
  // Rendering mode for the Recent emails list. 'paged' keeps the classic
  // first/prev/next/last controls; 'infinite' grows the visible window as the
  // operator scrolls (sentinel + IntersectionObserver). Persisted so the
  // preference survives reload. The expanded drilldown state is keyed by row
  // id (see `expandedRows`), so it is preserved across page changes AND while
  // more rows stream in during infinite scroll.
  const [paginationMode, setPaginationMode] = useState<PaginationMode>(() => {
    if (typeof window === 'undefined') return 'paged';
    const v = localStorage.getItem('gmail_pagination_mode');
    if (v === 'infinite' || v === 'paged') return v;
    // First run: phones default to smooth infinite scroll (no tiny pager taps),
    // desktop keeps the classic pager.
    return window.matchMedia?.('(max-width: 639px)').matches ? 'infinite' : 'paged';
  });
  useEffect(() => { try { localStorage.setItem('gmail_pagination_mode', paginationMode); } catch {} }, [paginationMode]);
  // How many rows are currently rendered in infinite-scroll mode. Starts at one
  // page worth and grows by `pageSize` each time the sentinel scrolls into view.
  const [infiniteCount, setInfiniteCount] = useState<number>(pageSize);
  const infiniteSentinelRef = useRef<HTMLDivElement | null>(null);
  // Match-type filter for the Recent emails list. Persisted so it survives reload.
  //   all       → no match filter
  //   confident → at least one reference OR from-phone match
  //   reference → at least one reference / TID match
  //   from      → at least one phone-after-"from" match
  type MatchFilter = 'all' | 'confident' | 'reference' | 'from';
  const [matchFilter, setMatchFilter] = useState<MatchFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_match') as MatchFilter | null;
    return v && ['all', 'confident', 'reference', 'from'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_match', matchFilter); } catch {} }, [matchFilter]);

  // Top-level workspace tab to separate inbox, review queues, analytics and diagnostics.
  type EmailWorkspaceTab = 'inbox' | 'needs_review' | 'settled' | 'analytics' | 'diagnostics';
  const [workspaceTab, setWorkspaceTab] = useState<EmailWorkspaceTab>('inbox');

  // Direction filter for the Recent emails list — lets Financial Ops slice
  // the captured Gmail traffic into money-in vs money-out (sends + charges)
  // without leaving the panel. Persisted so it survives reload.
  //   all → no direction filter
  //   in  → only credits (direction = 'in')
  //   out → debits + fees (direction = 'out' or 'charge')
  type DirectionFilter = 'all' | 'in' | 'out';
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_direction') as DirectionFilter | null;
    return v && ['all', 'in', 'out'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_direction', directionFilter); } catch {} }, [directionFilter]);

  // Focused money-in / money-out view. Tapping one of the two entry tiles opens
  // a dedicated page-style view that shows ONLY those emails: every other
  // narrowing filter is reset so nothing is silently hidden, and a banner with
  // a Back action replaces the tiles.
  const [focusDirection, setFocusDirection] = useState<'in' | 'out' | null>(null);
  // Inside a money-in / money-out focused view, emails render Gmail-style by
  // default; operators can flip to the detailed ops rows for routing actions.
  const [focusView, setFocusView] = useState<'gmail' | 'ops'>('gmail');
  // Gmail-style label rail: collapsed by default on phones, always visible on
  // desktop (mirrors Gmail's hamburger behaviour).
  const [gmailNavOpen, setGmailNavOpen] = useState(false);
  // Keep the focused view honest: if the operator changes the direction chips
  // lower down (or restores a preset), the banner follows or closes.
  useEffect(() => {
    setFocusDirection((cur) => {
      if (directionFilter === 'all') return null;
      return cur === null ? null : directionFilter;
    });
  }, [directionFilter]);

  // "Needs Routing" filter — when on, show only incoming deposits whose money
  // never landed in a wallet (not credited and not routed). Persisted so the
  // operator's triage view survives a refresh.
  const [needsRoutingOnly, setNeedsRoutingOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('gmail_filter_needs_routing') === '1';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_needs_routing', needsRoutingOnly ? '1' : '0'); } catch {} }, [needsRoutingOnly]);

  // Debit-breakdown filter — narrows the list by who was charged for an
  // outgoing email (user wallet, proxy agent wallet, or not yet debited).
  // Persisted so the operator's view survives a refresh.
  type DebitFilter = 'all' | 'user_debit' | 'proxy_debit' | 'none';
  const [debitFilter, setDebitFilter] = useState<DebitFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_debit') as DebitFilter | null;
    return v && ['all', 'user_debit', 'proxy_debit', 'none'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_debit', debitFilter); } catch {} }, [debitFilter]);

  // Debit-breakdown sort — lets Financial Ops order the visible list by debit
  // metadata (type, amount, or charged name). None = preserve chronological.
  type DebitSort = 'none' | 'debitType' | 'debitAmount' | 'debitName';
  const [debitSort, setDebitSort] = useState<DebitSort>(() => {
    if (typeof window === 'undefined') return 'none';
    const v = localStorage.getItem('gmail_sort_debit') as DebitSort | null;
    return v && ['none', 'debitType', 'debitAmount', 'debitName'].includes(v) ? v : 'none';
  });
  useEffect(() => { try { localStorage.setItem('gmail_sort_debit', debitSort); } catch {} }, [debitSort]);

  // Status filter for the Recent emails list — lets Financial Ops slice the
  // captured traffic by settlement state without reading each row. Persisted.
  //   all          → no status filter
  //   credited     → incoming money already credited or routed to a wallet
  //   needs_routing→ incoming money not yet credited / routed (triage)
  //   unparsed     → rows the parser could not read (no amount / not parsed)
  // 'needs_routing'     → Needs routing 1: money IN that was not auto-credited
  // 'needs_routing_out' → Needs routing 2: money OUT that was not auto-deducted
  //                        from the wallet of the number that was paid out
  type StatusFilter = 'all' | 'credited' | 'needs_routing' | 'needs_routing_out' | 'unparsed';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_status') as StatusFilter | null;
    return v && ['all', 'credited', 'needs_routing', 'needs_routing_out', 'unparsed'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_status', statusFilter); } catch {} }, [statusFilter]);

  // Primary sort for the Recent emails list — lets Financial Ops reorder
  // results without touching the filters. Persisted so it survives reload.
  //   newest / oldest      → by email date
  //   amount_high / amount_low → by parsed amount
  //   status               → group by settlement state (needs routing first)
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    if (typeof window === 'undefined') return 'newest';
    const v = localStorage.getItem('gmail_sort_mode') as SortMode | null;
    return v && ['newest', 'oldest', 'amount_high', 'amount_low', 'status'].includes(v) ? v : 'newest';
  });
  useEffect(() => { try { localStorage.setItem('gmail_sort_mode', sortMode); } catch {} }, [sortMode]);

  // ---- Filter presets -------------------------------------------------------
  // Operators triage the same handful of views all day (e.g. "Needs routing
  // today", "Big money out"). A preset snapshots every filter/sort control so a
  // single tap on mobile restores the whole view. Stored in localStorage.
  type FilterPreset = {
    id: string;
    name: string;
    searchQuery: string;
    phoneQuery: string;
    directionFilter: DirectionFilter;
    matchFilter: MatchFilter;
    needsRoutingOnly: boolean;
    debitFilter: DebitFilter;
    debitSort: DebitSort;
    statusFilter: StatusFilter;
    sortMode: SortMode;
  };
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('gmail_filter_presets');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as FilterPreset[]) : [];
    } catch { return []; }
  });
  const [activePresetId, setActivePresetId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : localStorage.getItem('gmail_filter_preset_active')
  );
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem('gmail_filter_presets', JSON.stringify(filterPresets)); } catch {}
  }, [filterPresets]);
  useEffect(() => {
    try {
      if (activePresetId) localStorage.setItem('gmail_filter_preset_active', activePresetId);
      else localStorage.removeItem('gmail_filter_preset_active');
    } catch {}
  }, [activePresetId]);

  const currentPresetSnapshot = useCallback((): Omit<FilterPreset, 'id' | 'name'> => ({
    searchQuery, phoneQuery, directionFilter, matchFilter, needsRoutingOnly,
    debitFilter, debitSort, statusFilter, sortMode,
  }), [searchQuery, phoneQuery, directionFilter, matchFilter, needsRoutingOnly, debitFilter, debitSort, statusFilter, sortMode]);

  const savePreset = useCallback(() => {
    const name = presetNameDraft.trim();
    if (!name) return;
    const snap = currentPresetSnapshot();
    setFilterPresets((prev) => {
      const existing = prev.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        setActivePresetId(existing.id);
        return prev.map((p) => (p.id === existing.id ? { ...p, ...snap, name } : p));
      }
      const id = `p_${Date.now().toString(36)}`;
      setActivePresetId(id);
      return [...prev, { id, name, ...snap }].slice(-12);
    });
    setPresetNameDraft('');
    setPresetSaveOpen(false);
    sonnerToast.success(`Preset "${name}" saved`);
  }, [presetNameDraft, currentPresetSnapshot]);

  const applyPreset = useCallback((p: FilterPreset) => {
    setSearchQuery(p.searchQuery ?? '');
    setPhoneQuery(p.phoneQuery ?? '');
    setDirectionFilter(p.directionFilter ?? 'all');
    setMatchFilter(p.matchFilter ?? 'all');
    setNeedsRoutingOnly(Boolean(p.needsRoutingOnly));
    setDebitFilter(p.debitFilter ?? 'all');
    setDebitSort(p.debitSort ?? 'none');
    setStatusFilter(p.statusFilter ?? 'all');
    setSortMode(p.sortMode ?? 'newest');
    setActivePresetId(p.id);
    try { (navigator as any).vibrate?.(10); } catch {}
  }, []);

  const deletePreset = useCallback((id: string) => {
    setFilterPresets((prev) => prev.filter((p) => p.id !== id));
    setActivePresetId((cur) => (cur === id ? null : cur));
  }, []);

  // A preset stops being "active" as soon as the operator tweaks a control.
  useEffect(() => {
    if (!activePresetId) return;
    const p = filterPresets.find((x) => x.id === activePresetId);
    if (!p) return;
    const snap = currentPresetSnapshot();
    const same = (Object.keys(snap) as Array<keyof typeof snap>).every((k) => (p as any)[k] === snap[k]);
    if (!same) setActivePresetId(null);
  }, [activePresetId, filterPresets, currentPresetSnapshot]);

  // Reset pagination whenever any filter that affects the visible list changes.
  useEffect(() => {
    setCurrentPage(1);
    setInfiniteCount(pageSize);
  }, [searchQuery, phoneQuery, fromDate, toDate, tz, pageSize, directionFilter, matchFilter, needsRoutingOnly, debitFilter, debitSort, statusFilter, sortMode]);
  // Reset the infinite window back to one page whenever the operator switches
  // into infinite mode, so it never starts mid-list.
  useEffect(() => {
    if (paginationMode === 'infinite') setInfiniteCount(pageSize);
  }, [paginationMode, pageSize]);

  // Persisted cache of derived channel classifications keyed by transaction id
  // / receipt number (with gmail_message_id as fallback). Loaded once on mount
  // and flushed back to localStorage whenever the heuristic learns a new key,
  // so the same id always resolves to the same channel across reloads and
  // future poll inserts.
  const channelCacheRef = useRef<Record<string, ChannelCacheEntry>>(readChannelCache());
  const flushChannelCache = () => writeChannelCache(channelCacheRef.current);

  // Map of row.id → matched user(s) inferred from phone numbers / refs in
  // the email. Resolved in a background effect against the `profiles` table
  // so the operator can see which app user likely made each deposit.
  const [userMatches, setUserMatches] = useState<Record<string, MatchedUser[]>>({});

  // Routing history for visible rows. Keyed by `row.id`. Each entry is a
  // single re-routing action (forward credit + any reversal legs against an
  // earlier auto-credited user). Loaded in a background effect so routed
  // rows render with a distinct violet marker and a compact inline history.
  const [routingHistory, setRoutingHistory] = useState<Record<string, RoutingHistoryEntry[]>>({});
  // Optimistic set of rows routed/charged in this session. A routed row must
  // leave the "needs routing" queue immediately, even before the routing
  // history refetch (or realtime feed) confirms the insert.
  const [justRoutedIds, setJustRoutedIds] = useState<Set<string>>(new Set());

  // Live wallet balances (strict, ledger-derived) for every possible user
  // and every routing-history target shown in the list. Lets Financial Ops
  // see the recipient's current wallet position at a glance before/after
  // routing or reversing a transaction.
  const [userBalances, setUserBalances] = useState<Record<string, number>>({});
  // Managed proxy agent resolved for each possible-user (partner) id, when one
  // exists (active + approved + is_managed_account assignment). Lets the
  // possible-recipient list show whose proxy wallet would be charged when the
  // user can't cover the payout, and opens a per-user proxy debit breakdown.
  interface ManagedProxy { agentId: string; agentName: string | null }
  const [userProxies, setUserProxies] = useState<Record<string, ManagedProxy>>({});
  // Latest 3 wallet ledger entries per possible-user, shown in the tooltip
  // so Financial Ops can see recent activity at a glance before routing.
  interface RecentTx {
    id: string;
    amount: number;
    direction: string;
    category: string;
    description: string | null;
    created_at: string;
  }
  const [userRecentTx, setUserRecentTx] = useState<Record<string, RecentTx[]>>({});
  // Timestamp of the last forced wallet-balance refresh (set after an
  // auto-debit run completes). Drives the visible "Balance refreshed"
  // indicator so Financial Ops knows the figures on screen are post-debit.
  const [balanceRefreshedAt, setBalanceRefreshedAt] = useState<number | null>(null);
  // Per-history-entry busy flag for the Reverse action so the button can
  // show a spinner without blocking other entries.
  const [reverseBusy, setReverseBusy] = useState<Record<string, boolean>>({});
  // Click-to-expand drilldown per email row. When a row id is present in this
  // set its drilldown panel is open, surfacing the linked proxy agent wallet
  // change, the debit reason, and the transaction references in one place.
  // Persisted to localStorage so the drilldown state survives refreshes.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(EXPANDED_ROWS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed as string[]);
    } catch {}
    return new Set();
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(EXPANDED_ROWS_KEY, JSON.stringify(Array.from(expandedRows)));
    } catch {}
  }, [expandedRows]);
  const toggleRowExpanded = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /**
   * Already-credited deposits for the currently visible *incoming* emails.
   * The poller (`gmail-poll-transactions`) auto-credits matched recipients
   * and stamps either `gmail_transactions.linked_deposit_request_id` (fast
   * path) or `deposit_requests.auto_match_audit->>gmail_message_id`
   * (fallback). When an email is already linked to a non-terminal
   * deposit_request we MUST NOT credit it again — surfacing this in the
   * list prevents double-credits and tells Financial Ops exactly which
   * user already received the money.
   */
  interface CreditedDeposit {
    deposit_id: string;
    user_id: string | null;
    user_name: string;
    user_phone: string;
    amount: number;
    status: string;
    auto_approved: boolean | null;
    deposit_purpose: string | null;
    credited_at: string | null;
    /** True when this deposit was matched to the email by its transaction
     *  reference (TID) rather than an explicit gmail link / auto_match_audit. */
    matched_by_tid?: boolean;
    /** The normalized transaction reference that matched, for display. */
    matched_tid?: string | null;
    /** Auto-credit provenance from deposit_requests.auto_match_audit — lets the
     *  row show HOW the wallet was resolved and how confident the matcher was.
     *  phone_source='body' + confidence='medium' is the "possible user ≈60%"
     *  body-phone signal. */
    auto_match_method?: string | null;
    auto_phone_source?: 'counterparty' | 'body' | null;
    auto_confidence?: 'high' | 'medium' | 'low' | null;
    auto_confidence_score?: number | null;
    /** PR A: unmatched MoMo parked pending OTP claim — NOT wallet-credited. */
    pending_claim?: boolean;
    claim_state?: string | null;
    payer_name?: string | null;
    needs_finops_confirm_before_invite?: boolean;
    unclaimed_expires_at?: string | null;
  }
  const [creditedDeposits, setCreditedDeposits] = useState<Record<string, CreditedDeposit[]>>({});

  /**
   * Ledger-only credits. Some incoming money never produces a
   * `deposit_requests` row at all — agent float deposits, CFO direct credits
   * and other ops postings land straight in `general_ledger` while quoting the
   * MoMo / Airtel reference in the description or idempotency key. Those
   * emails were previously stuck under "Needs routing" even though the wallet
   * was already credited, so they never showed up under Credited. Resolved
   * through the ops-only `match_email_ledger_credits` RPC.
   */
  interface LedgerCredit {
    ledger_id: string;
    amount: number;
    category: string | null;
    user_id: string | null;
    user_name: string | null;
    user_phone: string | null;
    created_at: string | null;
  }
  const [ledgerCredits, setLedgerCredits] = useState<Record<string, LedgerCredit[]>>({});

  /**
   * Manual "mark credited / uncredited" audit log loaded from
   * `email_credit_manual_marks`. Bulk actions append immutable rows there;
   * the LATEST mark per gmail_transaction_id is the operative state and
   * overrides the auto-detected `creditedDeposits` mapping so reviewers can
   * force a row to be treated as credited (e.g. settled out-of-band) or
   * uncredited (e.g. reversed manually) without losing history.
   */
  interface ManualMark {
    mark: 'credited' | 'uncredited';
    marked_by: string;
    marked_by_name: string | null;
    reason: string | null;
    created_at: string;
  }
  const [manualMarks, setManualMarks] = useState<Record<string, ManualMark>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  /**
   * Auto-payout matcher: for outgoing money-out emails (MoMo payouts / bank
   * disbursements), look up the pending `withdrawal_requests` row that the
   * email is *settling*. Match is by normalized TID (strongest) or by
   * counterparty/recipient phone + exact amount (fallback). One-click
   * "Auto-approve withdrawal" calls the same `approve-withdrawal` edge
   * function FinOps uses manually, with the email's TID as the
   * `fin_ops_reference`.
   */
  interface WithdrawalMatch {
    id: string;
    user_id: string;
    amount: number;
    status: string;
    mobile_money_number: string | null;
    mobile_money_provider: string | null;
    bank_name: string | null;
    bank_account_number: string | null;
    payout_method: string;
    matched_on: 'reference' | 'phone+amount';
    user_name?: string | null;
  }
  const [withdrawalMatches, setWithdrawalMatches] = useState<Record<string, WithdrawalMatch[]>>({});
  const [autoApproving, setAutoApproving] = useState<Record<string, boolean>>({});

  // ── Invite / login SMS delivery status ────────────────────────────────
  // The gmail poller texts every depositor's phone a link back to the
  // platform (a "sign up" invite for new numbers, a "log in" nudge for
  // existing users) and logs each attempt to `sms_delivery_log` with
  // source='momo_deposit_invite'. We surface that per-row so Financial Ops
  // can see whether the invite/login SMS was sent or failed for each
  // extracted deposit. Keyed by gmail_transactions.id.
  interface InviteSms {
    status: string;
    created_at: string;
    phone: string;
    message: string | null;
    error: string | null;
  }
  const [inviteSms, setInviteSms] = useState<Record<string, InviteSms>>({});

  // Manual channel correction UI. `editingRow` controls the dialog; bumping
  // `rulesVersion` re-renders the list so newly-saved rules / cache overrides
  // take effect immediately on every visible row.
  const [editingRow, setEditingRow] = useState<GmailTx | null>(null);
  const [routingRow, setRoutingRow] = useState<GmailTx | null>(null);
  const [routingSuggestedUser, setRoutingSuggestedUser] = useState<PrefilledUser | null>(null);
  const [routingMode, setRoutingMode] = useState<'credit' | 'debit'>('credit');
  // Per-row user selected via the inline search bar inside an expanded email.
  // Keyed by gmail_transactions.id so multiple rows can keep independent picks.
  const [inlineRouteUsers, setInlineRouteUsers] = useState<Record<string, UserResult>>({});
  // Row whose full status-history drawer is open (null = closed).
  const [historyDrawerRow, setHistoryDrawerRow] = useState<GmailTx | null>(null);
  // Search + route-type filter for the status-history drawer.
  const [historyDrawerQuery, setHistoryDrawerQuery] = useState('');
  const [historyDrawerType, setHistoryDrawerType] = useState<'all' | 'routed' | 'charged' | 'reversed'>('all');
  // Reset drawer filters whenever a different row's history is opened.
  useEffect(() => {
    setHistoryDrawerQuery('');
    setHistoryDrawerType('all');
  }, [historyDrawerRow?.id]);
  // A swipe queues a confirmation step before actually opening the
  // routing/charging dialog, so an accidental swipe can't fire the action.
  // Swipe confirmation gate. `mode` covers the money actions (credit/debit) and
  // the resolve action, so no swipe can process anything without a review step.
  const [pendingSwipe, setPendingSwipe] = useState<{ row: GmailTx; mode: 'credit' | 'debit' | 'resolve' } | null>(null);
  // High-impact actions (wallet charge) additionally require an explicit tick.
  const [swipeAck, setSwipeAck] = useState(false);
  // Batch auto-debit state. `autoDebitBusy` disables the banner button while
  // a batch run is in flight; `autoDebitProgress` drives the inline counter.
  const [autoDebitBusy, setAutoDebitBusy] = useState(false);
  const [autoDebitProgress, setAutoDebitProgress] = useState<{ done: number; total: number; ok: number; failed: number } | null>(null);
  // Per-row auto-debit outcome captured at run time so the row can show the
  // live impact on the matched user's wallet (amount taken + balance left).
  // Keyed by gmail transaction row id.
  const [autoDebitResults, setAutoDebitResults] = useState<
    Record<string, { amount: number; newAvail: number | null; userName: string }>
  >({});
  const [rulesVersion, setRulesVersion] = useState(0);
  const [storedUserRules, setStoredUserRules] = useState<StoredUserRule[]>(() => readStoredUserRules());
  // Mobile-only collapsibles: keep filters & stats hidden by default on small screens
  // so the actual email list lands above the fold. On sm+ they're always expanded.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Mobile-only collapse for the status / debit / sort chip groups. Keeps the
  // email list within reach on a phone instead of six wrapped chip rows.
  const [mobileStatsOpen, setMobileStatsOpen] = useState(false);
  // Selected zoom window on the In-vs-Out daily chart (Brush start/end indices).
  // null = full range. Drives the summary card above the chart.
  const [chartBrush, setChartBrush] = useState<{ start: number; end: number } | null>(null);
  // User-preferred tooltip placement for the stat-card info bubbles. Persisted
  // in localStorage. 'auto' lets Radix pick/flip via avoidCollisions.
  const [tooltipPlacement, setTooltipPlacement] = useState<'auto' | 'top' | 'bottom' | 'left' | 'right'>(() => {
    if (typeof window === 'undefined') return 'auto';
    const v = localStorage.getItem('gmail_tooltip_placement');
    return v === 'top' || v === 'bottom' || v === 'left' || v === 'right' || v === 'auto' ? v : 'auto';
  });
  useEffect(() => {
    try { localStorage.setItem('gmail_tooltip_placement', tooltipPlacement); } catch { /* ignore */ }
  }, [tooltipPlacement]);
  // Radix needs a concrete side; 'auto' falls back to bottom + collision flipping.
  const statTooltipSide = tooltipPlacement === 'auto' ? 'bottom' : tooltipPlacement;
  // Unparsed-email queue: collapsed by default so it never pushes the main
  // list below the fold, but one click surfaces every skipped Gmail row.
  const [unparsedOpen, setUnparsedOpen] = useState(false);
  const persistUserRules = (next: StoredUserRule[]) => {
    writeStoredUserRules(next);
    refreshUserRules();
    setStoredUserRules(next);
    setRulesVersion((v) => v + 1);
  };
  const deleteUserRule = (id: string) => {
    persistUserRules(storedUserRules.filter((r) => r.id !== id));
    toast({ title: 'Rule removed', description: 'Future emails will no longer use this override.' });
  };

  const load = async () => {
    // Build a server-side query that honors the date range and free-text
    // search box so the Recent emails list can reach the FULL history
    // (not just the most-recent 200). When neither a date range nor a
    // search is active we still default to a generous recent window so
    // the page opens fast.
    const fromTsLoad = fromDate ? zonedWallClockToUtcMs(fromDate, '00:00:00', tz) : null;
    const toTsLoad = toDate ? zonedWallClockToUtcMs(toDate, '23:59:59', tz) : null;
    const tokens = searchQuery.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const probe = tokens.length
      ? tokens.slice().sort((a, b) => b.length - a.length)[0]
      : null;
    // Phone-shaped probes must be narrowed to their trailing 9 digits before
    // they hit the server. MTN/Airtel bodies print numbers in international
    // form ("256783673998"), so a literal ilike on "0783673998" matches
    // nothing and the operator sees an empty Recent emails list even though
    // the email was captured. Last-9 matching covers 0…, 256…, +256… and
    // bare 7… formats in one probe.
    const probeDigits = probe ? probe.replace(/\D/g, '') : '';
    const phoneShapedProbe =
      probe && probeDigits.length >= 9 && probeDigits.length >= probe.length - 2
        ? probeDigits.slice(-9)
        : null;
    // An explicit "TID …" (Airtel) or "Transaction ID: …" (MTN) label pasted
    // straight out of an SMS is an unambiguous transaction-id search — pull
    // the FULL digit run out and use it verbatim instead of the generic
    // longest-token guess above. Using the full id (not the last-9-digit
    // phone heuristic) matters here: gmail_transactions.transaction_id is
    // stored inconsistently across templates (sometimes pure digits like
    // "154796826011", sometimes the label baked in like "TID154796672772"),
    // so truncating to last-9 risks a false match against an unrelated
    // transaction that happens to share those same trailing digits.
    const tidLabelMatch = searchQuery.match(/\b(?:TID|Trans(?:action)?\s*ID)[:.\s-]*(\d{4,18})/i);
    const rawProbe = tidLabelMatch ? tidLabelMatch[1] : (phoneShapedProbe ?? probe);
    const esc = rawProbe ? rawProbe.replace(/[%_,()]/g, (m) => '\\' + m) : null;

    // Each page must be built from a FRESH query builder — reusing the
    // same builder across awaits can stack modifiers in PostgREST.
    const buildQuery = () => {
      let q: any = (supabase.from('gmail_transactions') as any)
        .select('id,gmail_message_id,from_email,from_name,subject,snippet,amount,transaction_id,parsed,internal_date,direction,channel,counterparty,counterparty_name,fee,balance,linked_deposit_request_id,auto_matched_at')
        .order('internal_date', { ascending: false, nullsFirst: false });
      // When the operator has typed a search query, IGNORE the date range
      // entirely so the search reaches the full email history. This makes the
      // search box behave like a global "find any email" tool, independent of
      // whatever date filter happens to be set above.
      const searchActiveLoad = tokens.length > 0;
      if (!searchActiveLoad) {
        if (fromTsLoad) q = q.gte('internal_date', new Date(fromTsLoad).toISOString());
        if (toTsLoad) q = q.lte('internal_date', new Date(toTsLoad).toISOString());
      }
      if (esc) {
        q = q.or(
          [
            `transaction_id.ilike.%${esc}%`,
            `subject.ilike.%${esc}%`,
            `snippet.ilike.%${esc}%`,
            `counterparty.ilike.%${esc}%`,
            `from_email.ilike.%${esc}%`,
            `from_name.ilike.%${esc}%`,
          ].join(',')
        );
      }
      return q;
    };

    // Pagination strategy — Supabase enforces a 1000-row hard cap per
    // request, so to reach the FULL history (well beyond 5000) we walk
    // the result set with `.range()` in pages of 1000 until the table
    // is exhausted. Without a filter we stop at one page (1000) to keep
    // the initial paint fast; with any filter/search we keep paging up
    // to a generous safety ceiling so memory can't run away.
    const hasFilter = !!(fromTsLoad || toTsLoad || tokens.length > 0);
    const PAGE = 1000;
    const MAX_ROWS = hasFilter ? 100_000 : PAGE;

    const psPromise = supabase
      .from('gmail_poll_state')
      .select('last_polled_at,last_status,last_error')
      .eq('id', 1)
      .maybeSingle();

    const all: GmailTx[] = [];
    let offset = 0;
    let readError: { message: string; denied: boolean } | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const end = offset + PAGE - 1;
      const { data: page, error } = await buildQuery().range(offset, end);
      if (error) {
        // Distinguish "you cannot read this" from "there is nothing to read".
        const code = (error as any)?.code as string | undefined;
        const msg = error.message || 'Unknown error';
        const denied = code === '42501' || /permission denied|row-level security|not authoriz/i.test(msg);
        readError = { message: msg, denied };
        console.error('[EmailTransactionsPanel] gmail_transactions read failed:', code, msg);
        break;
      }
      if (!page || page.length === 0) break;
      all.push(...(page as unknown as GmailTx[]));
      if (page.length < PAGE) break;          // last page
      if (all.length >= MAX_ROWS) break;       // safety ceiling
      offset += PAGE;
    }
    const { data: ps } = await psPromise;
    setLoadError(readError);
    setRows(all);
    setState((ps as PollState) ?? null);

    const psTyped = ps as PollState | null;
    if (psTyped?.last_status === 'ok' && psTyped.last_polled_at) {
      setLastSuccessAt(psTyped.last_polled_at);
      try { localStorage.setItem('gmail_last_success_at', psTyped.last_polled_at); } catch {}
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('gmail_transactions_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gmail_transactions' }, (payload) => {
        setRows((cur) => [payload.new as GmailTx, ...cur].slice(0, 5000));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Re-run the server-side load whenever the date range or search query
  // changes so the Recent emails list can reach the FULL history (not
  // just the latest 200 rows). Debounced for the search box so each
  // keystroke doesn't fire a query.
  useEffect(() => {
    const handle = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, searchQuery, tz]);

  // Background load of routing history for the currently visible rows.
  // Also subscribes to inserts so a fresh re-route shows up instantly
  // without requiring a refresh.
  useEffect(() => {
    if (!rows.length) { setRoutingHistory({}); return; }
    let cancelled = false;
    const rowIds = rows.map((r) => r.id);
    const msgIds = rows.map((r) => r.gmail_message_id).filter(Boolean) as string[];
    (async () => {
      const { data, error } = await (supabase.from('email_routing_history') as any)
        .select('id,created_at,route,reason,target_user_id,target_user_name,target_user_phone,routed_by_name,amount,sms_sent,gmail_transaction_id,gmail_message_id')
        .or(
          msgIds.length
            ? `gmail_transaction_id.in.(${rowIds.join(',')}),gmail_message_id.in.(${msgIds.join(',')})`
            : `gmail_transaction_id.in.(${rowIds.join(',')})`
        )
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled || error) return;
      const byMsg = new Map<string, string>(); // gmail_message_id → row.id
      for (const r of rows) if (r.gmail_message_id) byMsg.set(r.gmail_message_id, r.id);
      const next: Record<string, RoutingHistoryEntry[]> = {};
      for (const h of (data ?? []) as Array<RoutingHistoryEntry & { gmail_transaction_id: string | null; gmail_message_id: string | null }>) {
        const rid = h.gmail_transaction_id || (h.gmail_message_id ? byMsg.get(h.gmail_message_id) : null);
        if (!rid) continue;
        (next[rid] = next[rid] || []).push(h);
      }
      setRoutingHistory(next);
    })();
    const sub = supabase
      .channel('email_routing_history_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'email_routing_history' }, (payload) => {
        const h = payload.new as RoutingHistoryEntry & { gmail_transaction_id: string | null; gmail_message_id: string | null };
        const rid = h.gmail_transaction_id || rows.find((r) => r.gmail_message_id === h.gmail_message_id)?.id;
        if (!rid) return;
        setRoutingHistory((cur) => ({ ...cur, [rid]: [h, ...(cur[rid] ?? [])] }));
      })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(sub); };
  }, [rows]);

  // Background load of invite/login SMS delivery status for the currently
  // visible incoming rows. The poller logs each depositor invite to
  // sms_delivery_log (source='momo_deposit_invite') with reference_id set to
  // the email's transaction reference and recipient_phone in international
  // format. We match back to a row by (1) transaction reference, then
  // (2) sender phone last-9. Realtime inserts keep the badge fresh.
  useEffect(() => {
    const incoming = rows.filter((r) => r.direction === 'in');
    if (!incoming.length) { setInviteSms({}); return; }
    let cancelled = false;
    const last9 = (s: string | null | undefined): string | null => {
      const d = (s ?? '').replace(/[^0-9]/g, '');
      return d.length >= 9 ? d.slice(-9) : null;
    };
    const applyLogs = (
      logs: Array<{ status: string; created_at: string; recipient_phone: string; message: string | null; error: string | null; reference_id: string | null }>,
    ) => {
      const byTid = new Map<string, GmailTx>();
      const byPhone = new Map<string, GmailTx>();
      for (const r of incoming) {
        if (r.transaction_id) byTid.set(r.transaction_id, r);
        const p = last9(r.counterparty);
        if (p && !byPhone.has(p)) byPhone.set(p, r);
      }
      const next: Record<string, InviteSms> = {};
      for (const log of logs) {
        let row: GmailTx | undefined;
        if (log.reference_id && byTid.has(log.reference_id)) row = byTid.get(log.reference_id);
        if (!row) {
          const p = last9(log.recipient_phone);
          if (p && byPhone.has(p)) row = byPhone.get(p);
        }
        if (!row) continue;
        // Keep only the most recent attempt per row (logs are newest-first).
        if (!next[row.id]) {
          next[row.id] = {
            status: log.status,
            created_at: log.created_at,
            phone: log.recipient_phone,
            message: log.message,
            error: log.error,
          };
        }
      }
      return next;
    };
    (async () => {
      const { data, error } = await (supabase.from('sms_delivery_log') as any)
        .select('status,created_at,recipient_phone,message,error,reference_id')
        .eq('source', 'momo_deposit_invite')
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled || error) return;
      setInviteSms(applyLogs((data ?? []) as any));
    })();
    const sub = supabase
      .channel('momo_deposit_invite_sms_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sms_delivery_log', filter: 'source=eq.momo_deposit_invite' },
        (payload) => {
          const log = payload.new as any;
          setInviteSms((cur) => ({ ...cur, ...applyLogs([log]) }));
        },
      )
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(sub); };
  }, [rows]);

  // Persist a one-time, regulator-safe audit entry whenever an email is
  // detected as already credited purely via its transaction reference (TID).
  // Idempotent: skips any (gmail_transaction, deposit) pair already logged so
  // the recurring credited-detection effect doesn't spam duplicate rows.
  const recordTidAutoCreditAudit = async (
    pairs: Array<{
      gmail_transaction_id: string;
      deposit_request_id: string;
      amount: number;
      tid: string | null;
      user_name: string;
      status: string;
    }>,
  ): Promise<void> => {
    if (!pairs.length) return;
    try {
      const gtxIds = Array.from(new Set(pairs.map((p) => p.gmail_transaction_id)));
      const { data: existing } = await (supabase.from('email_match_audit_log') as any)
        .select('gmail_transaction_id, deposit_request_id')
        .eq('action', 'tid_auto_credited')
        .in('gmail_transaction_id', gtxIds);
      const seen = new Set<string>(
        ((existing ?? []) as Array<{ gmail_transaction_id: string | null; deposit_request_id: string | null }>)
          .map((e) => `${e.gmail_transaction_id}|${e.deposit_request_id}`),
      );
      const fresh = pairs.filter((p) => !seen.has(`${p.gmail_transaction_id}|${p.deposit_request_id}`));
      if (!fresh.length) return;
      const { data: auth } = await supabase.auth.getUser();
      const actorId = auth?.user?.id ?? null;
      const actorEmail = auth?.user?.email ?? null;
      const insertRows = fresh.map((p) => ({
        gmail_transaction_id: p.gmail_transaction_id,
        deposit_request_id: p.deposit_request_id,
        action: 'tid_auto_credited',
        matcher_type: 'tid',
        match_score: 100,
        amount: p.amount,
        actor_id: actorId,
        actor_email: actorEmail,
        notes: 'Already Credited — No Routing Needed (matched by transaction reference / TID).',
        signals: {
          normalized_tid: p.tid,
          recipient: p.user_name,
          deposit_status: p.status,
          detection: 'tid_reference_match',
        },
      }));
      await (supabase.from('email_match_audit_log') as any).insert(insertRows);
    } catch {
      // Best-effort audit; never block the UI on a logging failure.
    }
  };

  // Background load of "already-credited" deposit links for visible incoming
  // rows. Uses the same two-step resolution the RouteEmailDepositDialog
  // uses: (1) gmail_transactions.linked_deposit_request_id fast path,
  // (2) deposit_requests.auto_match_audit->>gmail_message_id fallback.
  // Terminal statuses (rejected/cancelled/failed/reversed) are treated as
  // "not credited" so reversed auto-credits can be re-routed without the
  // double-credit warning.
  useEffect(() => {
    if (!rows.length) { setCreditedDeposits({}); return; }
    const incoming = rows.filter((r) => r.direction === 'in');
    if (!incoming.length) { setCreditedDeposits({}); return; }
    let cancelled = false;
    const rowIds = incoming.map((r) => r.id);
    const msgIds = incoming.map((r) => r.gmail_message_id).filter(Boolean) as string[];
    (async () => {
      try {
        // 1) Fast path via gmail_transactions.linked_deposit_request_id
        const { data: gmailLinks } = await (supabase.from('gmail_transactions') as any)
          .select('id, linked_deposit_request_id')
          .in('id', rowIds);
        const linkByRow = new Map<string, string[]>();
        const depIds = new Set<string>();
        for (const g of (gmailLinks ?? []) as Array<{ id: string; linked_deposit_request_id: string | null }>) {
          if (g.linked_deposit_request_id) {
            const arr = linkByRow.get(g.id) ?? [];
            arr.push(g.linked_deposit_request_id);
            linkByRow.set(g.id, arr);
            depIds.add(g.linked_deposit_request_id);
          }
        }
        // 2) Fallback via deposit_requests.auto_match_audit->>gmail_message_id
        const linkByMsg = new Map<string, string[]>();
        if (msgIds.length) {
          const { data: audits } = await (supabase.from('deposit_requests') as any)
            .select('id, status, auto_match_audit')
            .in('auto_match_audit->>gmail_message_id', msgIds);
          for (const a of (audits ?? []) as Array<{ id: string; status: string; auto_match_audit: any }>) {
            const mid = a?.auto_match_audit?.gmail_message_id as string | undefined;
            if (!mid) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(a.status)) continue;
            const arr = linkByMsg.get(mid) ?? [];
            if (!arr.includes(a.id)) {
              arr.push(a.id);
              linkByMsg.set(mid, arr);
              depIds.add(a.id);
            }
          }
        }
        // 3) Reference (TID) fallback. Cash deposits verified via finance are
        //    auto-approved and credited to the wallet, but the matching
        //    deposit_request often never gets stamped with the gmail link or
        //    auto_match_audit. Match the email's normalized transaction
        //    reference against deposit_requests.transaction_id so these
        //    already-landed deposits still surface as "credited — do not
        //    route again".
        const linkByTid = new Map<string, string[]>(); // normalized TID -> deposit ids
        const tidByRow = new Map<string, string>();     // row id -> normalized TID
        const rawTids = new Set<string>();
        for (const r of incoming) {
          const raw = (r.transaction_id ?? '').trim();
          if (!raw) continue;
          const norm = normalizeMomoTid(raw);
          if (norm.length < 6) continue; // avoid spurious short-tail collisions
          tidByRow.set(r.id, norm);
          rawTids.add(raw);
          rawTids.add(norm);
        }
        if (rawTids.size) {
          const { data: tidDeps } = await (supabase.from('deposit_requests') as any)
            .select('id, status, transaction_id')
            .in('transaction_id', Array.from(rawTids));
          for (const d of (tidDeps ?? []) as Array<{ id: string; status: string; transaction_id: string | null }>) {
            if (!d.transaction_id) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(d.status)) continue;
            const norm = normalizeMomoTid(d.transaction_id);
            if (norm.length < 6) continue;
            const arr = linkByTid.get(norm) ?? [];
            if (!arr.includes(d.id)) {
              arr.push(d.id);
              linkByTid.set(norm, arr);
              depIds.add(d.id);
            }
          }
        }
        // 3b) Cash-deposit RECEIPT-CODE fallback. "Cash deposit code 8829 —
        //     UGX 9,999 from …" emails credit the wallet the instant the agent
        //     reads the code back, but the email itself never carries a MoMo
        //     TID. The short receipt code IS the deposit_request.transaction_id,
        //     so match it EXACTLY (no normalization / length guard) — these
        //     codes are issued per-deposit and never collide.
        const linkByReceipt = new Map<string, string[]>(); // receipt code -> deposit ids
        const receiptByRow = new Map<string, string>();     // row id -> receipt code
        const receiptCodes = new Set<string>();
        for (const r of incoming) {
          const code = extractCashReceiptCode(r);
          if (!code) continue;
          receiptByRow.set(r.id, code);
          receiptCodes.add(code);
        }
        if (receiptCodes.size) {
          const { data: rcDeps } = await (supabase.from('deposit_requests') as any)
            .select('id, status, transaction_id')
            .in('transaction_id', Array.from(receiptCodes));
          for (const d of (rcDeps ?? []) as Array<{ id: string; status: string; transaction_id: string | null }>) {
            if (!d.transaction_id) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(d.status)) continue;
            const code = d.transaction_id.trim();
            const arr = linkByReceipt.get(code) ?? [];
            if (!arr.includes(d.id)) {
              arr.push(d.id);
              linkByReceipt.set(code, arr);
              depIds.add(d.id);
            }
          }
        }
        if (!depIds.size) { if (!cancelled) setCreditedDeposits({}); return; }
        const { data: deps } = await (supabase.from('deposit_requests') as any)
          .select('id, user_id, amount, status, auto_approved, deposit_purpose, created_at, updated_at, auto_match_audit')
          .in('id', Array.from(depIds));
        const depById = new Map<string, any>();
        const userIds = new Set<string>();
        for (const d of (deps ?? []) as Array<any>) {
          depById.set(d.id, d);
          if (d.user_id) userIds.add(d.user_id);
        }
        let profById = new Map<string, any>();
        if (userIds.size) {
          const { data: profs } = await (supabase.from('profiles') as any)
            .select('id, full_name, phone')
            .in('id', Array.from(userIds));
          profById = new Map(((profs ?? []) as Array<any>).map((p) => [p.id, p]));
        }
        const next: Record<string, CreditedDeposit[]> = {};
        for (const r of incoming) {
          const ids = new Set<string>();
          (linkByRow.get(r.id) ?? []).forEach((id) => ids.add(id));
          if (r.gmail_message_id) (linkByMsg.get(r.gmail_message_id) ?? []).forEach((id) => ids.add(id));
          const normTid = tidByRow.get(r.id);
          const tidDepIds = new Set<string>();
          if (normTid) (linkByTid.get(normTid) ?? []).forEach((id) => { ids.add(id); tidDepIds.add(id); });
          // Cash receipt-code matches are treated like TID matches for the
          // "Already Credited — No Routing Needed" status.
          const receiptCode = receiptByRow.get(r.id);
          if (receiptCode) (linkByReceipt.get(receiptCode) ?? []).forEach((id) => { ids.add(id); tidDepIds.add(id); });
          // Deposits matched ONLY by reference (not by explicit gmail link /
          // auto_match_audit) are flagged so the row can show the clear
          // "Already Credited — No Routing Needed" status.
          const explicitDepIds = new Set<string>([
            ...(linkByRow.get(r.id) ?? []),
            ...(r.gmail_message_id ? (linkByMsg.get(r.gmail_message_id) ?? []) : []),
          ]);
          if (!ids.size) continue;
          const list: CreditedDeposit[] = [];
          for (const depId of ids) {
            const d = depById.get(depId);
            if (!d) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(d.status)) continue;
            const p = profById.get(d.user_id);
            const audit = (d.auto_match_audit ?? {}) as {
              match_method?: string | null;
              phone_source?: string | null;
              confidence?: string | null;
              confidence_score?: number | null;
              pending_claim?: boolean;
              claim_state?: string | null;
              payer_name?: string | null;
              needs_finops_confirm_before_invite?: boolean;
              unclaimed_expires_at?: string | null;
            };
            const isPendingClaim = audit.pending_claim === true && audit.claim_state !== 'claimed';
            list.push({
              deposit_id: d.id,
              user_id: d.user_id ?? null,
              user_name: (p?.full_name as string)
                ?? (isPendingClaim ? 'Pending claim (unmatched MoMo)' : 'Unknown user'),
              user_phone: (p?.phone as string) ?? '',
              amount: Number(d.amount) || 0,
              status: d.status,
              auto_approved: d.auto_approved ?? null,
              deposit_purpose: d.deposit_purpose ?? null,
              credited_at: (d.updated_at as string) ?? (d.created_at as string) ?? null,
              matched_by_tid: tidDepIds.has(depId) && !explicitDepIds.has(depId),
              matched_tid: tidDepIds.has(depId) ? (normTid ?? receiptCode ?? null) : null,
              auto_match_method: audit.match_method ?? null,
              auto_phone_source: (audit.phone_source as 'counterparty' | 'body' | null) ?? null,
              auto_confidence: (audit.confidence as 'high' | 'medium' | 'low' | null) ?? null,
              auto_confidence_score: typeof audit.confidence_score === 'number' ? audit.confidence_score : null,
              pending_claim: isPendingClaim,
              claim_state: audit.claim_state ?? null,
              payer_name: audit.payer_name ?? null,
              needs_finops_confirm_before_invite: !!audit.needs_finops_confirm_before_invite,
              unclaimed_expires_at: audit.unclaimed_expires_at ?? null,
            });
          }
          if (list.length) next[r.id] = list;
        }
        if (!cancelled) setCreditedDeposits(next);
        // Audit every TID-only "Already Credited — No Routing Needed" match
        // (idempotent; recordTidAutoCreditAudit skips already-logged pairs).
        const tidPairs = Object.entries(next).flatMap(([rowId, list]) =>
          list
            .filter((c) => c.matched_by_tid)
            .map((c) => ({
              gmail_transaction_id: rowId,
              deposit_request_id: c.deposit_id,
              amount: c.amount,
              tid: c.matched_tid ?? null,
              user_name: c.user_name,
              status: c.status,
            })),
        );
        if (tidPairs.length) void recordTidAutoCreditAudit(tidPairs);
      } catch {
        if (!cancelled) setCreditedDeposits({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Ledger-reference credits: match every visible incoming email's reference
  // (MoMo TID / Airtel TID / cash receipt code) against wallet credits already
  // posted in general_ledger. Batched so the reference array stays small.
  useEffect(() => {
    const incoming = rows.filter((r) => r.direction === 'in');
    if (!incoming.length) { setLedgerCredits({}); return; }
    let cancelled = false;
    const refByRow = new Map<string, string>();
    for (const r of incoming) {
      const raw = (r.transaction_id ?? '').trim() || extractCashReceiptCode(r) || '';
      if (raw.replace(/\D/g, '').length < 6) continue;
      refByRow.set(r.id, raw);
    }
    if (!refByRow.size) { setLedgerCredits({}); return; }
    (async () => {
      const refs = Array.from(new Set(refByRow.values()));
      const byRef = new Map<string, LedgerCredit[]>();
      try {
        // Small batches keep each trigram lookup well inside the statement
        // timeout even on a large ledger.
        for (let i = 0; i < refs.length; i += 40) {
          const batch = refs.slice(i, i + 40);
          const { data, error } = await (supabase.rpc as any)('match_email_ledger_credits', { p_refs: batch });
          if (error) throw error;
          for (const m of (data ?? []) as Array<any>) {
            const arr = byRef.get(m.ref) ?? [];
            arr.push({
              ledger_id: m.ledger_id,
              amount: Number(m.amount) || 0,
              category: m.category ?? null,
              user_id: m.user_id ?? null,
              user_name: m.user_name ?? null,
              user_phone: m.user_phone ?? null,
              created_at: m.created_at ?? null,
            });
            byRef.set(m.ref, arr);
          }
        }
        const next: Record<string, LedgerCredit[]> = {};
        for (const [rowId, ref] of refByRow) {
          const hits = byRef.get(ref);
          if (hits?.length) next[rowId] = hits;
        }
        if (!cancelled) setLedgerCredits(next);
      } catch {
        if (!cancelled) setLedgerCredits({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Load the LATEST manual credit-mark per visible gmail transaction so the
  // list can honor operator overrides immediately. Re-runs whenever the row
  // set changes (e.g. after bulk actions or new polls).
  useEffect(() => {
    if (!rows.length) { setManualMarks({}); return; }
    let cancelled = false;
    const rowIds = rows.map((r) => r.id);
    (async () => {
      try {
        // Pull ALL marks for visible ids (newest first), then keep the first
        // (latest) per gmail_transaction_id. Cheap enough at typical page sizes.
        const { data: marks } = await (supabase.from('email_credit_manual_marks') as any)
          .select('gmail_transaction_id, mark, reason, marked_by, created_at')
          .in('gmail_transaction_id', rowIds)
          .order('created_at', { ascending: false });
        const arr = (marks ?? []) as Array<{ gmail_transaction_id: string; mark: 'credited'|'uncredited'; reason: string | null; marked_by: string; created_at: string }>;
        const operatorIds = Array.from(new Set(arr.map((m) => m.marked_by)));
        let nameById = new Map<string, string>();
        if (operatorIds.length) {
          const { data: profs } = await (supabase.from('profiles') as any)
            .select('id, full_name')
            .in('id', operatorIds);
          nameById = new Map(((profs ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name ?? '']));
        }
        const next: Record<string, ManualMark> = {};
        for (const m of arr) {
          if (next[m.gmail_transaction_id]) continue; // keep newest only
          next[m.gmail_transaction_id] = {
            mark: m.mark,
            marked_by: m.marked_by,
            marked_by_name: nameById.get(m.marked_by) ?? null,
            reason: m.reason,
            created_at: m.created_at,
          };
        }
        if (!cancelled) setManualMarks(next);
      } catch {
        if (!cancelled) setManualMarks({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  /**
   * Bulk mark every currently-selected email as credited or uncredited.
   * Inserts one append-only row per selection into
   * `email_credit_manual_marks` (operator = auth.uid, server-stamped
   * timestamp). RLS restricts inserts to Financial Ops roles. After the
   * batch lands we refresh the marks map and clear the selection.
   */
  const applyBulkMark = async (
    mark: 'credited' | 'uncredited',
    idsOverride?: string[],
    presetReason?: string,
  ) => {
    const ids = idsOverride ?? Array.from(selectedIds);
    if (!ids.length) return;
    const reason =
      presetReason !== undefined
        ? presetReason
        : window.prompt(
            `Reason for marking ${ids.length} email(s) as ${mark} (logged in audit trail, optional):`,
            ''
          );
    // null = cancelled, '' = proceed without reason
    if (reason === null) return;
    setBulkBusy(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error('Not signed in');
      const byId = new Map(rows.map((r) => [r.id, r]));
      const payload = ids.map((id) => {
        const r = byId.get(id);
        return {
          gmail_transaction_id: id,
          gmail_message_id: r?.gmail_message_id ?? null,
          email_tid: r?.transaction_id ?? null,
          mark,
          reason: reason.trim() || null,
          marked_by: uid,
        };
      });
      const { error } = await (supabase.from('email_credit_manual_marks') as any).insert(payload);
      if (error) throw new Error(error.message);
      toast({
        title: `Marked ${ids.length} email(s) as ${mark}`,
        description: 'Audit trail updated. The list will refresh.',
      });
      // Refresh marks for these rows
      const { data: fresh } = await (supabase.from('email_credit_manual_marks') as any)
        .select('gmail_transaction_id, mark, reason, marked_by, created_at')
        .in('gmail_transaction_id', ids)
        .order('created_at', { ascending: false });
      const arr = (fresh ?? []) as Array<any>;
      setManualMarks((prev) => {
        const next = { ...prev };
        for (const m of arr) {
          if (next[m.gmail_transaction_id] && next[m.gmail_transaction_id].created_at >= m.created_at) continue;
          next[m.gmail_transaction_id] = {
            mark: m.mark,
            marked_by: m.marked_by,
            marked_by_name: prev[m.gmail_transaction_id]?.marked_by_name ?? null,
            reason: m.reason,
            created_at: m.created_at,
          };
        }
        return next;
      });
      setSelectedIds(new Set());
    } catch (e: any) {
      toast({
        title: 'Bulk mark failed',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * Single-row equivalent of `applyBulkMark` — used by the mobile right-swipe
   * "Mark resolved" gesture. Appends one immutable row to
   * `email_credit_manual_marks` and updates the local marks map so the row's
   * status pill flips immediately.
   */
  const markRowResolved = async (r: GmailTx, mark: 'credited' | 'uncredited' = 'credited') => {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error('Not signed in');
      const prevMark = manualMarks[r.id] ?? null;
      const { data: inserted, error } = await (supabase.from('email_credit_manual_marks') as any).insert({
        gmail_transaction_id: r.id,
        gmail_message_id: r.gmail_message_id ?? null,
        email_tid: r.transaction_id ?? null,
        mark,
        reason: 'Marked resolved from mobile swipe',
        marked_by: uid,
      }).select('id').maybeSingle();
      if (error) throw new Error(error.message);
      setManualMarks((prev) => ({
        ...prev,
        [r.id]: {
          mark,
          marked_by: uid,
          marked_by_name: prev[r.id]?.marked_by_name ?? null,
          reason: 'Marked resolved from mobile swipe',
          created_at: new Date().toISOString(),
        },
      }));
      // Undo snackbar: swipes are easy to trigger by accident on mobile, so the
      // mark stays reversible for a few seconds (deletes the audit row again).
      sonnerToast(mark === 'credited' ? 'Marked as resolved' : 'Marked as not paid in', {
        description: 'Swiped by mistake? Undo within a few seconds.',
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              if (inserted?.id) {
                const { error: delErr } = await (supabase.from('email_credit_manual_marks') as any)
                  .delete()
                  .eq('id', inserted.id);
                if (delErr) throw new Error(delErr.message);
              }
              setManualMarks((prev) => {
                const next = { ...prev };
                if (prevMark) next[r.id] = prevMark;
                else delete next[r.id];
                return next;
              });
              sonnerToast.success('Mark reverted');
            } catch (e: any) {
              sonnerToast.error('Could not undo', { description: e?.message || String(e) });
            }
          },
        },
      });
    } catch (e: any) {
      toast({ title: 'Mark failed', description: e?.message || String(e), variant: 'destructive' });
    }
  };

  // Background fetch of strict ledger-derived withdrawable balances for
  // every possible-user candidate AND every routed target currently shown.
  // Uses the operator-safe `get_user_wallet_view` RPC so the figure matches
  // what the user themselves would see in their wallet. Re-runs whenever
  // the set of relevant user ids changes (e.g. after a re-route or a new
  // possible-user resolution).
  useEffect(() => {
    const ids = new Set<string>();
    for (const list of Object.values(userMatches)) {
      for (const u of list) ids.add(u.id);
    }
    for (const list of Object.values(routingHistory)) {
      for (const h of list) if (h.target_user_id) ids.add(h.target_user_id);
    }
    // Also fetch wallet positions for any resolved managed proxy agents so the
    // possible-recipient list and breakdown can show the proxy wallet balance.
    for (const p of Object.values(userProxies)) if (p.agentId) ids.add(p.agentId);
    const missing = Array.from(ids).filter((id) => userBalances[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        missing.map(async (id) => {
          try {
            const [viewRes, txRes] = await Promise.all([
              supabase.rpc('get_user_wallet_view', { p_user_id: id }),
              supabase
                .from('general_ledger')
                .select('id, amount, direction, category, description, created_at')
                .eq('user_id', id)
                .eq('ledger_scope', 'wallet')
                .neq('classification', 'admin_correction')
                .neq('category', 'system_balance_correction')
                .order('created_at', { ascending: false })
                .limit(3),
            ]);
            if (viewRes.error) return [id, null as number | null, [] as RecentTx[]] as const;
            const r = (viewRes.data ?? {}) as Record<string, unknown>;
            const withdrawable = Number((r.withdrawable as number | string | undefined) ?? 0);
            const floatBal = Number((r.float_balance as number | string | undefined) ?? 0);
            const tx = (txRes.data ?? []) as RecentTx[];
            return [id, (withdrawable + floatBal) as number | null, tx] as const;
          } catch {
            return [id, null as number | null, [] as RecentTx[]] as const;
          }
        }),
      );
      if (cancelled) return;
      setUserBalances((cur) => {
        const next = { ...cur };
        for (const [id, bal] of results) {
          if (bal !== null) next[id] = bal;
        }
        return next;
      });
      setUserRecentTx((cur) => {
        const next = { ...cur };
        for (const [id, , tx] of results) {
          if (tx && tx.length) next[id] = tx;
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [userMatches, routingHistory, userBalances, userProxies]);

  // Resolve the managed proxy agent (if any) for every possible-user candidate.
  // Mirrors the server-side `resolveManagedProxy`: an active, approved,
  // is_managed_account assignment where the candidate is the beneficiary.
  useEffect(() => {
    const ids = new Set<string>();
    for (const list of Object.values(userMatches)) {
      for (const u of list) ids.add(u.id);
    }
    const missing = Array.from(ids).filter((id) => userProxies[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data: assigns, error } = await (supabase.from('proxy_agent_assignments') as any)
        .select('beneficiary_id, agent_id')
        .in('beneficiary_id', missing)
        .eq('is_active', true)
        .eq('is_managed_account', true)
        .eq('approval_status', 'approved');
      if (cancelled || error || !assigns?.length) return;
      const agentIds = Array.from(new Set(assigns.map((a: any) => a.agent_id).filter(Boolean)));
      const nameById: Record<string, string | null> = {};
      if (agentIds.length) {
        const { data: profs } = await (supabase.from('profiles') as any)
          .select('id, full_name')
          .in('id', agentIds);
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
          nameById[p.id] = p.full_name ?? null;
        }
      }
      if (cancelled) return;
      setUserProxies((cur) => {
        const next = { ...cur };
        for (const a of assigns as Array<{ beneficiary_id: string; agent_id: string }>) {
          if (a.beneficiary_id && a.agent_id && next[a.beneficiary_id] === undefined) {
            next[a.beneficiary_id] = { agentId: a.agent_id, agentName: nameById[a.agent_id] ?? null };
          }
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [userMatches, userProxies]);

  // Reverse a single routing-history entry. Posts the opposite leg through
  // `cfo-direct-credit` against the same target user/bucket, then writes a
  // new history row tagged "Reversed" so the UI marks the entry reversed.
  const reverseRoutingEntry = async (rowForEntry: GmailTx, entry: RoutingHistoryEntry) => {
    const isDebitEntry = entry.route.endsWith('_debit');
    const opposite: 'credit' | 'debit' = isDebitEntry ? 'credit' : 'debit';
    const isFloat =
      entry.route === 'operational_float' || entry.route === 'landlord_float_debit';
    const isProxyAgentRoute = entry.route === 'proxy_agent_wallet_debit';
    const opLabel = opposite === 'credit' ? 'Credit back' : 'Debit back';
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `${opLabel} UGX ${Math.round(entry.amount).toLocaleString()} ` +
        `${opposite === 'credit' ? 'to' : 'from'} ${entry.target_user_name || 'this user'}?\n\n` +
        `This will post an offsetting ledger leg through CFO Direct ${opposite === 'credit' ? 'Credit' : 'Debit'} ` +
        `and mark the original routing entry as reversed.`,
      );
      if (!ok) return;
    }
    setReverseBusy((cur) => ({ ...cur, [entry.id]: true }));
    try {
      const body = {
        target_user_id: entry.target_user_id,
        amount: Number(entry.amount),
        reason:
          `Reversed routing entry ${entry.id.slice(0, 8)}… ` +
          `(${entry.route}) — Financial Ops correction.`,
        operation: opposite,
        wallet_category: isFloat ? 'agent_float_deposit' : 'wallet_transfer',
        platform_category: isFloat ? 'agent_float_deposit' : 'wallet_transfer',
        financial_impact: 'neutral' as const,
        category_label: `Reverse ${entry.route.replace(/_/g, ' ')}`,
        recipient_type: isFloat ? 'operational_wallet' : 'user',
        sub_category: rowForEntry.transaction_id ?? null,
      };
      const { data, error } = await supabase.functions.invoke('cfo-direct-credit', { body });
      if (error) throw new Error((error as any)?.message || 'Reversal failed');
      if ((data as any)?.error) throw new Error((data as any).error);
      const referenceId = (data as any)?.reference_id ?? null;

      // Best-effort history insert so the UI shows the reversal immediately.
      try {
        const { data: me } = await supabase.auth.getUser();
        if (me?.user?.id) {
          let routedByName: string | null = null;
          try {
            const { data: rp } = await (supabase.from('profiles') as any)
              .select('full_name').eq('id', me.user.id).maybeSingle();
            routedByName = rp?.full_name ?? null;
          } catch { /* ignore */ }
          await (supabase.from('email_routing_history') as any).insert({
            gmail_transaction_id: rowForEntry.id,
            gmail_message_id: rowForEntry.gmail_message_id ?? null,
            transaction_id: rowForEntry.transaction_id,
            from_email: rowForEntry.from_email,
            from_name: rowForEntry.from_name,
            subject: rowForEntry.subject,
            amount: Number(entry.amount),
            route: entry.route,
            target_user_id: entry.target_user_id,
            target_user_name: entry.target_user_name,
            target_user_phone: entry.target_user_phone,
            reason: `Reversed ${isDebitEntry ? 'debit' : 'credit'} (was ${entry.route}): manual reversal by Financial Ops.`,
            ledger_reference_id: referenceId,
            routed_by: me.user.id,
            routed_by_name: routedByName,
            sms_sent: false,
            sms_error: null,
          });
        }
      } catch (e) { console.warn('[EmailTransactionsPanel] reversal history insert failed', e); }

      // Invalidate the cached balance for this user so the next render
      // re-fetches the post-reversal position.
      setUserBalances((cur) => {
        const next = { ...cur };
        delete next[entry.target_user_id];
        return next;
      });
      setUserRecentTx((cur) => {
        const next = { ...cur };
        delete next[entry.target_user_id];
        return next;
      });
      toast({
        title: 'Routing reversed',
        description: `${opLabel} UGX ${Math.round(entry.amount).toLocaleString()} ${opposite === 'credit' ? 'to' : 'from'} ${entry.target_user_name || 'user'}.`,
      });
    } catch (e: any) {
      const raw = e?.message || String(e);
      let title = 'Reverse failed';
      let description = raw;
      if (/NEGATIVE_WALLET_BLOCKED/i.test(raw)) {
        const m = raw.match(/cannot debit\s+(\d+).*strict available balance is\s+(\d+)/i);
        const amt = m?.[1] ? `UGX ${Number(m[1]).toLocaleString()}` : 'the requested amount';
        const bal = m?.[2] ? `UGX ${Number(m[2]).toLocaleString()}` : '0';
        title = 'Cannot reverse — insufficient funds';
        description = `This user’s strict available balance is ${bal}, but the reversal requires ${amt}. The money may have already been swept to another wallet (e.g., via system balance correction). To reverse the original deposit, debit the wallet that currently holds the funds instead.`;
      }
      toast({ title, description, variant: 'destructive' });
    } finally {
      setReverseBusy((cur) => {
        const { [entry.id]: _, ...rest } = cur;
        return rest;
      });
    }
  };

  // ── Auto-payout matcher ─────────────────────────────────────────────
  // For every visible outgoing email (MoMo payout / bank disbursement),
  // look up open `withdrawal_requests` rows that this email plausibly
  // settles. Strongest signal is a normalized-TID hit; phone+amount is
  // a fallback when the cashier didn't include the exact reference yet.
  useEffect(() => {
    const outRows = rows.filter(
      (r) => (r.direction === 'out' || r.direction === 'charge') && r.amount && r.amount > 0,
    );
    if (outRows.length === 0) { setWithdrawalMatches({}); return; }

    let cancelled = false;
    (async () => {
      // Collect normalized TIDs + (phone, amount) pairs from outgoing rows.
      const normTids = new Set<string>();
      const phones = new Set<string>();
      for (const r of outRows) {
        const n = normalizeMomoTid(r.transaction_id);
        if (n.length >= 6) normTids.add(n);
        for (const p of extractPhones(r)) phones.add(p);
      }

      // Pull all open withdrawals once and match in-memory — production
      // queue depth is small enough that this is cheaper than building
      // per-TID OR clauses.
      const openStatuses = ['pending', 'requested', 'manager_approved', 'rejected'];
      const { data, error } = await (supabase.from('withdrawal_requests') as any)
        .select(
          'id,user_id,amount,status,mobile_money_number,mobile_money_provider,bank_name,bank_account_number,payout_method,transaction_id,fin_ops_reference',
        )
        .in('status', openStatuses)
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled || error || !data) return;

      type WR = {
        id: string;
        user_id: string;
        amount: number;
        status: string;
        mobile_money_number: string | null;
        mobile_money_provider: string | null;
        bank_name: string | null;
        bank_account_number: string | null;
        payout_method: string;
        transaction_id: string | null;
        fin_ops_reference: string | null;
      };
      const wrs = data as WR[];

      // Index for fast lookup.
      const byTid = new Map<string, WR[]>();
      for (const w of wrs) {
        for (const t of [w.transaction_id, w.fin_ops_reference]) {
          const n = normalizeMomoTid(t);
          if (n.length >= 6) {
            const list = byTid.get(n) ?? [];
            list.push(w);
            byTid.set(n, list);
          }
        }
      }
      const byPhone = new Map<string, WR[]>();
      for (const w of wrs) {
        const n = normalizeUgPhone(w.mobile_money_number ?? '');
        if (!n) continue;
        const list = byPhone.get(n) ?? [];
        list.push(w);
        byPhone.set(n, list);
      }

      // Resolve user names in one round-trip.
      const userIds = Array.from(new Set(wrs.map((w) => w.user_id)));
      let names: Record<string, string> = {};
      if (userIds.length) {
        const { data: profs } = await (supabase.from('profiles') as any)
          .select('id, full_name')
          .in('id', userIds);
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
          names[p.id] = p.full_name ?? '';
        }
      }

      const matches: Record<string, WithdrawalMatch[]> = {};
      const seen = new Set<string>(); // wr.id already attached to some row
      for (const r of outRows) {
        const list: WithdrawalMatch[] = [];
        // 1. TID match — authoritative.
        const n = normalizeMomoTid(r.transaction_id);
        if (n.length >= 6) {
          for (const w of byTid.get(n) ?? []) {
            if (seen.has(w.id)) continue;
            list.push({
              id: w.id, user_id: w.user_id, amount: Number(w.amount), status: w.status,
              mobile_money_number: w.mobile_money_number, mobile_money_provider: w.mobile_money_provider,
              bank_name: w.bank_name, bank_account_number: w.bank_account_number,
              payout_method: w.payout_method, matched_on: 'reference',
              user_name: names[w.user_id] ?? null,
            });
          }
        }
        // 2. Fallback: phone + exact amount.
        if (list.length === 0 && r.amount) {
          const targetAmt = Math.round(r.amount);
          for (const ph of extractPhones(r)) {
            for (const w of byPhone.get(ph) ?? []) {
              if (seen.has(w.id)) continue;
              if (Math.round(Number(w.amount)) !== targetAmt) continue;
              list.push({
                id: w.id, user_id: w.user_id, amount: Number(w.amount), status: w.status,
                mobile_money_number: w.mobile_money_number, mobile_money_provider: w.mobile_money_provider,
                bank_name: w.bank_name, bank_account_number: w.bank_account_number,
                payout_method: w.payout_method, matched_on: 'phone+amount',
                user_name: names[w.user_id] ?? null,
              });
            }
          }
        }
        if (list.length === 1) seen.add(list[0].id); // only single-match rows are auto-approvable
        matches[r.id] = list;
      }
      if (!cancelled) setWithdrawalMatches(matches);
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Map an extracted channel to the approve-withdrawal `payment_method`
  // payload value (mobile_money | bank_transfer | cash).
  const channelToPaymentMethod = (channel: string | null, fallback: string): string => {
    if (channel === 'mtn_momo' || channel === 'airtel_money') return 'mobile_money';
    if (channel === 'bank_transfer') return 'bank_transfer';
    if (channel === 'cash_receipt') return 'cash';
    return fallback || 'mobile_money';
  };

  const autoApproveWithdrawal = async (row: GmailTx, match: WithdrawalMatch) => {
    const ref = (row.transaction_id ?? '').trim();
    if (!ref || ref.length < 3) {
      toast({
        title: 'Cannot auto-approve',
        description: 'Email is missing a usable TID / bank reference.',
        variant: 'destructive',
      });
      return;
    }
    setAutoApproving((cur) => ({ ...cur, [row.id]: true }));
    const paymentMethod = channelToPaymentMethod(row.channel, match.payout_method);
    const { data, error } = await invokeEdgeFunction<{ success?: boolean; error?: string }>(
      'approve-withdrawal',
      {
        body: {
          withdrawal_id: match.id,
          reference: ref,
          payment_method: paymentMethod,
        },
        errorTitle: 'Auto-approve failed',
      },
    );
    setAutoApproving((cur) => {
      const { [row.id]: _, ...rest } = cur;
      return rest;
    });
    if (error || !data || data.error) return;
    toast({
      title: 'Withdrawal auto-approved',
      description: `Matched email TID ${ref} → withdrawal ${match.id.slice(0, 8)}… (${match.mobile_money_number ?? match.bank_account_number ?? 'beneficiary'}). Wallet debited.`,
    });
    // Drop this match locally so the button disappears immediately.
    setWithdrawalMatches((cur) => ({ ...cur, [row.id]: [] }));
  };

  // Resolve phone numbers (and transaction ids) found in each email row to
  // app users in `profiles`. Runs whenever the visible row set changes;
  // matches are highlighted inline so the operator can confirm at a glance
  // who likely sent the deposit.
  useEffect(() => {
    let cancelled = false;
    const rowPhones = new Map<string, string[]>();
    const rowFromPhones = new Map<string, string[]>();
    const rowToPhones = new Map<string, string[]>();
    const rowRefs = new Map<string, string[]>();
    const rowToNames = new Map<string, string[]>();
    const rowFromNames = new Map<string, string[]>();
    const allPhones = new Set<string>();
    const allRefs = new Set<string>();
    const allNames = new Set<string>();
    for (const r of rows) {
      const phones = extractPhones(r);
      if (phones.length) {
        rowPhones.set(r.id, phones);
        phones.forEach((p) => allPhones.add(p));
      }
      const fromPhones = extractFromPhones(r);
      if (fromPhones.length) {
        rowFromPhones.set(r.id, fromPhones);
        fromPhones.forEach((p) => allPhones.add(p));
      }
      const toPhones = extractToPhones(r);
      if (toPhones.length) {
        rowToPhones.set(r.id, toPhones);
        toPhones.forEach((p) => allPhones.add(p));
      }
      const refs = extractReferences(r);
      if (refs.length) {
        rowRefs.set(r.id, refs);
        refs.forEach((x) => allRefs.add(x));
      }
      const toNames = extractToNames(r);
      if (toNames.length) {
        rowToNames.set(r.id, toNames);
        toNames.forEach((n) => allNames.add(n));
      }
      const fromNames = extractFromNames(r);
      if (fromNames.length) {
        rowFromNames.set(r.id, fromNames);
        fromNames.forEach((n) => allNames.add(n));
      }
    }
    if (allPhones.size === 0 && allRefs.size === 0 && allNames.size === 0) {
      setUserMatches({});
      return;
    }
    const phoneList = Array.from(allPhones);
    const refList = Array.from(allRefs);
    const nameList = Array.from(allNames);
    (async () => {
      // Build the in-list once and query both phone columns.
      const profileQ = phoneList.length
        ? (supabase.from('profiles') as any)
            .select('id, full_name, phone, mobile_money_number, verified')
            .or(`phone.in.(${phoneList.join(',')}),mobile_money_number.in.(${phoneList.join(',')})`)
            .limit(500)
        : Promise.resolve({ data: [], error: null });
      // Authoritative lookup: a Welile deposit_request that already carries
      // this exact transaction id maps the email straight to its user.
      const depQ = refList.length
        ? (supabase.from('deposit_requests') as any)
            .select('transaction_id, user_id')
            .in('transaction_id', refList)
            .limit(500)
        : Promise.resolve({ data: [], error: null });
      // Name-based lookup: match every extracted "to NAME" / "from NAME"
      // against profiles.full_name with case-insensitive substring. Cap the
      // OR-list to avoid PostgREST URL bloat on huge inboxes.
      const cappedNames = nameList.slice(0, 40);
      const nameQ = cappedNames.length
        ? (supabase.from('profiles') as any)
            .select('id, full_name, phone, mobile_money_number, verified')
            .or(cappedNames.map((n) => `full_name.ilike.%${n.replace(/[,()]/g, ' ')}%`).join(','))
            .limit(500)
        : Promise.resolve({ data: [], error: null });
      const [{ data, error }, { data: deps }, { data: nameData }] = await Promise.all([
        profileQ,
        depQ,
        nameQ,
      ]);
      if (cancelled || error) return;
      type P = { id: string; full_name: string; phone: string | null; mobile_money_number: string | null };
      const byPhone = new Map<string, P[]>();
      for (const p of (data ?? []) as P[]) {
        for (const candidate of [p.phone, p.mobile_money_number]) {
          const n = candidate ? normalizeUgPhone(candidate) : null;
          if (!n) continue;
          const list = byPhone.get(n) ?? [];
          if (!list.find((x) => x.id === p.id)) list.push(p);
          byPhone.set(n, list);
        }
      }
      // Build a name → matching profiles index. A profile matches a name when
      // every non-trivial token in the extracted name appears in full_name
      // (case-insensitive). Guards against "JAMES" matching every James in DB.
      const nameProfiles = (nameData ?? []) as P[];
      const byName = new Map<string, P[]>();
      for (const candidate of nameList) {
        const tokens = candidate.split(/\s+/).filter((t) => t.length > 1);
        if (tokens.length < 2) continue;
        const hits: P[] = [];
        for (const p of nameProfiles) {
          const haystack = (p.full_name ?? '').toUpperCase();
          if (tokens.every((t) => haystack.includes(t))) hits.push(p);
        }
        if (hits.length) byName.set(candidate, hits);
      }
      // Resolve deposit_requests.user_id → profile in a second roundtrip so
      // we don't depend on a specific FK alias being declared on the table.
      const depRows = (deps ?? []) as Array<{ transaction_id: string; user_id: string }>;
      const userIds = Array.from(new Set(depRows.map((d) => d.user_id).filter(Boolean)));
      let refProfiles: Record<string, P> = {};
      if (userIds.length) {
        const { data: pps } = await (supabase.from('profiles') as any)
          .select('id, full_name, phone, mobile_money_number')
          .in('id', userIds);
        for (const p of (pps ?? []) as P[]) refProfiles[p.id] = p;
      }
      const byRef = new Map<string, P>();
      for (const d of depRows) {
        const p = refProfiles[d.user_id];
        if (d.transaction_id && p) byRef.set(d.transaction_id.toUpperCase(), p);
      }
      const next: Record<string, MatchedUser[]> = {};
      for (const [rowId, phones] of rowPhones) {
        const seen = new Set<string>();
        const list: MatchedUser[] = [];
        // 1. Reference / TID hit — authoritative, push first.
        for (const ref of rowRefs.get(rowId) ?? []) {
          const p = byRef.get(ref);
          if (p && !seen.has(p.id)) {
            seen.add(p.id);
            list.push({
              id: p.id, full_name: p.full_name,
              phone: p.phone, mobile_money_number: p.mobile_money_number,
              matched_on: `reference ${ref}`,
            });
          }
        }
        // 2. Phone right after the word "from" — strongest heuristic match.
        const fromSet = new Set(rowFromPhones.get(rowId) ?? []);
        // 2b. Phone right after the word "to" — strongest heuristic match
        //     for outgoing payouts (recipient identification).
        const toSet = new Set(rowToPhones.get(rowId) ?? []);
        for (const ph of phones) {
          for (const p of byPhone.get(ph) ?? []) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            list.push({
              id: p.id,
              full_name: p.full_name,
              phone: p.phone,
              mobile_money_number: p.mobile_money_number,
              matched_on: fromSet.has(ph)
                ? `from ${ph}`
                : toSet.has(ph)
                  ? `to ${ph}`
                  : `phone ${ph}`,
            });
          }
        }
        // 3. Name match (recipient/sender by full_name). Lower priority than
        //    phone/reference but surfaces names like "JAMES KATONGOLE" when
        //    the provider email omits a phone number entirely.
        const rowNames = [
          ...(rowToNames.get(rowId) ?? []).map((n) => ({ n, kw: 'to' as const })),
          ...(rowFromNames.get(rowId) ?? []).map((n) => ({ n, kw: 'from' as const })),
        ];
        for (const { n, kw } of rowNames) {
          for (const p of byName.get(n) ?? []) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            list.push({
              id: p.id,
              full_name: p.full_name,
              phone: p.phone,
              mobile_money_number: p.mobile_money_number,
              matched_on: `name-${kw} ${n}`,
            });
          }
        }
        if (list.length) next[rowId] = list;
      }
      // Rows that had no extracted phone but did match by reference id.
      for (const [rowId, refs] of rowRefs) {
        if (next[rowId]) continue;
        const list: MatchedUser[] = [];
        const seen = new Set<string>();
        for (const ref of refs) {
          const p = byRef.get(ref);
          if (p && !seen.has(p.id)) {
            seen.add(p.id);
            list.push({
              id: p.id, full_name: p.full_name,
              phone: p.phone, mobile_money_number: p.mobile_money_number,
              matched_on: `reference ${ref}`,
            });
          }
        }
        if (list.length) next[rowId] = list;
      }
      // Rows whose only signal was a name (no phone, no TID). Critical for
      // money-out emails like Equity Bank that print only the recipient name.
      for (const rowId of new Set([
        ...Array.from(rowToNames.keys()),
        ...Array.from(rowFromNames.keys()),
      ])) {
        if (next[rowId]) continue;
        const list: MatchedUser[] = [];
        const seen = new Set<string>();
        const rowNames = [
          ...(rowToNames.get(rowId) ?? []).map((n) => ({ n, kw: 'to' as const })),
          ...(rowFromNames.get(rowId) ?? []).map((n) => ({ n, kw: 'from' as const })),
        ];
        for (const { n, kw } of rowNames) {
          for (const p of byName.get(n) ?? []) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            list.push({
              id: p.id,
              full_name: p.full_name,
              phone: p.phone,
              mobile_money_number: p.mobile_money_number,
              matched_on: `name-${kw} ${n}`,
            });
          }
        }
        if (list.length) next[rowId] = list;
      }
      setUserMatches(next);
    })();
    return () => { cancelled = true; };
  }, [rows]);

  const pollNow = async () => {
    setPolling(true);
    const { data, error } = await supabase.functions.invoke('gmail-poll-transactions', { body: {} });
    setPolling(false);
    if (error) {
      const friendly = friendlyPollError(error.message);
      toast({ title: friendly.title, description: friendly.description, variant: 'destructive' });
      await load(); // refresh state so banner shows the new error
    } else {
      const inserted = (data as any)?.inserted ?? 0;
      const scanned = (data as any)?.scanned ?? 0;
      toast({ title: `Scanned ${scanned} emails`, description: `Imported ${inserted} new transaction${inserted === 1 ? '' : 's'}.` });
      await load();
    }
  };

  // Apply date-range filter to everything that drives totals / breakdown / exports.
  // Dates are interpreted in the chosen timezone so the user sees stable bucketing
  // regardless of where the browser is running.
  const fromTs = fromDate ? zonedWallClockToUtcMs(fromDate, '00:00:00', tz) : null;
  const toTs = toDate ? zonedWallClockToUtcMs(toDate, '23:59:59', tz) : null;
  const inRange = (r: GmailTx) => {
    if (!fromTs && !toTs) return true;
    if (!r.internal_date) return false;
    const t = new Date(r.internal_date).getTime();
    if (fromTs && t < fromTs) return false;
    if (toTs && t > toTs) return false;
    return true;
  };
  // When a search query is active we DELIBERATELY bypass the date range so
  // ops can find any email regardless of the date filter currently set.
  const searchActiveForRange = searchQuery.trim().length > 0;
  const dateRows = searchActiveForRange ? rows : rows.filter(inRange);
  // Apply the free-text search on top of the date range. Empty query → pass.
  const searchTokens = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  // Expand each token with phone-number variants so a search like "0772123456"
  // matches emails that printed "+256772123456" / "256772 123 456" / etc.
  const expandedSearchTokens: string[][] = searchTokens.map((t) => {
    const variants = new Set<string>([t]);
    const digits = t.replace(/\D/g, '');
    if (digits.length >= 7) {
      variants.add(digits);
      const norm = normalizeUgPhone(t);
      if (norm) {
        variants.add(norm);                 // 256XXXXXXXXX
        variants.add(`0${norm.slice(3)}`);  // 0XXXXXXXXX
        variants.add(norm.slice(3));        // 7XXXXXXXX
      }
    }
    // Amount typed with or without commas (e.g. "150000" vs "150,000")
    if (/^\d{4,}$/.test(digits)) {
      variants.add(Number(digits).toLocaleString().toLowerCase());
    }
    return Array.from(variants);
  });
  const matchesSearch = (r: GmailTx): boolean => {
    if (searchTokens.length === 0) return true;
    const matched = userMatches[r.id] ?? [];
    const matchedHay = matched
      .flatMap((u) => [u.full_name ?? '', u.phone ?? '', u.id ?? ''])
      .join(' ');
    const hay = [
      r.transaction_id ?? '',
      r.subject ?? '',
      r.snippet ?? '',
      r.counterparty ?? '',
      r.from_email ?? '',
      r.from_name ?? '',
      r.direction ?? '',
      r.channel ?? '',
      r.amount != null ? String(Math.round(r.amount)) : '',
      r.amount != null ? Math.round(r.amount).toLocaleString() : '',
      r.fee != null ? String(Math.round(r.fee)) : '',
      r.balance != null ? String(Math.round(r.balance)) : '',
      r.gmail_message_id ?? '',
      r.internal_date ?? '',
      matchedHay,
    ].join(' ').toLowerCase();
    // Each token must match in ANY of its variant forms.
    return expandedSearchTokens.every((variants) =>
      variants.some((v) => hay.includes(v)),
    );
  };
  // Dedicated depositor-phone match. Compares the trailing 9 digits (the part
  // that's stable across 0…, 256…, +256… and bare 7… formats) so a search like
  // "0783673998" also matches "+256783673998" printed in the email body.
  const phoneDigits = phoneQuery.replace(/\D/g, '');
  const phoneNeedle = phoneDigits.length >= 9 ? phoneDigits.slice(-9) : phoneDigits;
  const phoneActive = phoneNeedle.length >= 6;
  const matchesPhone = (r: GmailTx): boolean => {
    if (!phoneActive) return true;
    const matched = userMatches[r.id] ?? [];
    const hay = [
      r.counterparty ?? '',
      r.from_name ?? '',
      r.from_email ?? '',
      r.subject ?? '',
      r.snippet ?? '',
      ...matched.map((u) => u.phone ?? ''),
    ]
      .join(' ')
      .replace(/\D/g, '');
    return hay.includes(phoneNeedle);
  };
  // `filteredRows` reflects BOTH the date range and the search box, so every
  // downstream consumer (stats, breakdown, chart, exports, list) stays in sync.
  const filteredRows = dateRows.filter((r) => matchesSearch(r) && matchesPhone(r));
  const searchActive = searchTokens.length > 0 || phoneActive;
  // Resolve & memoize the channel for every row once per render. Calling
  // deriveChannel with the cache may write back new entries; we flush to
  // localStorage at the end if anything changed.
  const channelCache = channelCacheRef.current;
  const cacheSnapshot = JSON.stringify(channelCache);
  const rowChannel = new Map<string, ChannelResult>();
  for (const r of rows) rowChannel.set(r.id, deriveChannel(r, channelCache));
  if (JSON.stringify(channelCache) !== cacheSnapshot) flushChannelCache();
  const ch = (r: GmailTx): ChannelResult => rowChannel.get(r.id) ?? deriveChannel(r, channelCache);
  const rangeActive = Boolean(fromTs || toTs);
  const parsedCount = filteredRows.filter((r) => r.parsed).length;
  // Skipped rows the parser could not turn into a usable transaction. Newest
  // first so the most recent failures are at the top of the queue.
  const unparsedRows = filteredRows
    .filter(isUnparsedRow)
    .sort((a, b) => {
      const ta = a.internal_date ? new Date(a.internal_date).getTime() : 0;
      const tb = b.internal_date ? new Date(b.internal_date).getTime() : 0;
      return tb - ta;
    });
  // Compute validity once per row so totals, breakdowns and the list agree.
  const validity = new Map<string, { valid: boolean; reason?: string }>();
  for (const r of rows) validity.set(r.id, validateGmailTx(r));
  const flaggedCount = filteredRows.filter((r) => r.parsed && !validity.get(r.id)!.valid).length;
  // Flagged rows are kept in totals (only highlighted in the UI). A row counts
  // toward totals as long as it's parsed and has a usable amount.
  const isCountable = (r: GmailTx) =>
    r.parsed && r.amount !== null && Number.isFinite(r.amount as number) && (r.amount as number) > 0
    && !isWelileOutboundEcho(r);
  const totalAmount = filteredRows.filter(isCountable).reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalIn = filteredRows
    .filter((r) => isCountable(r) && r.direction === 'in')
    .reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalOut = filteredRows
    .filter((r) => isCountable(r) && (r.direction === 'out' || r.direction === 'charge'))
    .reduce((s, r) => s + (r.amount ?? 0), 0);
  const netAmount = totalIn - totalOut;

  // Unmatched email counters — deposit emails with no linked request and
  // payout emails neither routed to a wallet nor matched to an open withdrawal.
  const unmatchedInCount = filteredRows.filter(
    (r) => r.parsed && r.direction === 'in' && !r.linked_deposit_request_id && !r.auto_matched_at
      && !isWelileOutboundEcho(r),
  ).length;
  const unmatchedOutCount = filteredRows.filter(
    (r) =>
      isCountable(r) &&
      (r.direction === 'out' || r.direction === 'charge') &&
      !routingHistory[r.id]?.length &&
      !(withdrawalMatches[r.id]?.length),
  ).length;

  // Per-channel breakdown with counts and totals per direction.
  const channelBreakdown = (() => {
    const map = new Map<
      string,
      { inCount: number; inTotal: number; outCount: number; outTotal: number; feeCount: number; feeTotal: number }
    >();
    for (const r of filteredRows) {
      if (!isCountable(r)) continue;
      const key = ch(r).channel.replace(/_/g, ' ');
      const cur = map.get(key) ?? { inCount: 0, inTotal: 0, outCount: 0, outTotal: 0, feeCount: 0, feeTotal: 0 };
      const amt = r.amount ?? 0;
      if (r.direction === 'in') {
        cur.inCount += 1;
        cur.inTotal += amt;
      } else if (r.direction === 'out' || r.direction === 'charge') {
        cur.outCount += 1;
        cur.outTotal += amt;
      }
      // Provider-deducted fee/charge/tax/excise lives on the row regardless
      // of direction (MTN/Airtel attach it to the same send confirmation;
      // banks send a separate "charge" row). Aggregate whenever present.
      if (r.fee && Number(r.fee) > 0) {
        cur.feeCount += 1;
        cur.feeTotal += Number(r.fee);
      }
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .map(([channel, v]) => ({ channel, ...v, net: v.inTotal - v.outTotal }))
      .sort((a, b) => b.inTotal + b.outTotal - (a.inTotal + a.outTotal));
  })();

  // Total provider fees across every parsed row (any direction).
  const totalFees = filteredRows
    .filter((r) => r.parsed && r.fee && Number(r.fee) > 0)
    .reduce((s, r) => s + Number(r.fee ?? 0), 0);
  const feeCount = filteredRows.filter((r) => r.parsed && r.fee && Number(r.fee) > 0).length;

  // Daily in vs out series for the selected timeframe.
  const dailySeries = (() => {
    const map = new Map<string, { date: string; in: number; out: number; net: number }>();
    for (const r of filteredRows) {
      if (!isCountable(r) || !r.internal_date) continue;
      const key = dateKeyInTz(new Date(r.internal_date), tz);
      const cur = map.get(key) ?? { date: key, in: 0, out: 0, net: 0 };
      const amt = r.amount ?? 0;
      if (r.direction === 'in') cur.in += amt;
      else if (r.direction === 'out' || r.direction === 'charge') cur.out += amt;
      cur.net = cur.in - cur.out;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  // Shared "needs routing" predicate: an incoming deposit whose money has not
  // landed in any wallet yet (not credited and not routed). Mirrors the badge
  // logic used in the row render so the filter and the badge always agree.
  const isNeedsRouting = useCallback((r: GmailTx) => {
    if (r.direction !== 'in') return false;
    if (isWelileOutboundEcho(r)) return false;
    if (justRoutedIds.has(r.id)) return false;
    const isRouted = (routingHistory[r.id] ?? []).length > 0;
    const credited = creditedDeposits[r.id] ?? [];
    const parkedOnly = credited.length > 0 && credited.every((c) => c.pending_claim);
    // Parked pending claims are linked — do not treat as open routing work,
    // but they are also NOT wallet-credited (badge handles that separately).
    if (parkedOnly) return false;
    const manualMark = manualMarks[r.id];
    const ledgerHit = (ledgerCredits[r.id] ?? []).length > 0;
    const walletCredited = credited.filter((c) => !c.pending_claim);
    const isCredited = manualMark ? manualMark.mark === 'credited' : (walletCredited.length > 0 || ledgerHit);
    return !isCredited && !isRouted;
  }, [routingHistory, creditedDeposits, manualMarks, justRoutedIds, ledgerCredits]);

  /**
   * Settlement status for a single row, used by the Status filter chips.
   *   'unparsed'     → the parser could not read the email (no amount / not parsed)
   *   'needs_routing'→ incoming money not yet credited or routed to a wallet
   *   'credited'     → incoming money already credited or routed to a wallet
   *   'other'        → outgoing / charge rows (not a settlement candidate)
   */
  const getRowStatus = useCallback((r: GmailTx): 'unparsed' | 'needs_routing' | 'credited' | 'other' => {
    if (isUnparsedRow(r)) return 'unparsed';
    if (r.direction !== 'in') return 'other';
    if (isWelileOutboundEcho(r)) return 'other';
    if (justRoutedIds.has(r.id)) return 'credited';
    const isRouted = (routingHistory[r.id] ?? []).length > 0;
    const credited = creditedDeposits[r.id] ?? [];
    const parkedOnly = credited.length > 0 && credited.every((c) => c.pending_claim);
    // Keep parked claims out of both "needs_routing" and "credited" chips —
    // FinOps sees them via the violet "Awaiting claim" badge on the row.
    if (parkedOnly && !isRouted) return 'other';
    const manualMark = manualMarks[r.id];
    const ledgerHit = (ledgerCredits[r.id] ?? []).length > 0;
    const walletCredited = credited.filter((c) => !c.pending_claim);
    const isCredited = manualMark ? manualMark.mark === 'credited' : (walletCredited.length > 0 || ledgerHit);
    return isCredited || isRouted ? 'credited' : 'needs_routing';
  }, [routingHistory, creditedDeposits, manualMarks, justRoutedIds, ledgerCredits]);

  /**
   * Unread alert tracking. "Alerts" are rows that need a human: incoming
   * emails still awaiting routing, plus unparsed rows the parser skipped.
   * We remember the timestamp of the last time ops acknowledged the queue
   * (localStorage) and treat any alert row newer than that as unread, so the
   * panel can surface "what needs attention first" at a glance.
   */
  const ALERTS_SEEN_KEY = 'gmail_alerts_last_seen';
  /**
   * Alert notification settings. Ops choose which alert types count toward the
   * unread badges and whether new arrivals raise an in-app toast prompt.
   * Persisted per-browser in localStorage.
   */
  const ALERT_PREFS_KEY = 'gmail_alert_prefs_v1';
  type AlertPrefs = { needsRouting: boolean; unparsed: boolean; toastPrompt: boolean };
  const [alertPrefs, setAlertPrefs] = useState<AlertPrefs>(() => {
    const fallback: AlertPrefs = { needsRouting: true, unparsed: true, toastPrompt: true };
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(ALERT_PREFS_KEY);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch { return fallback; }
  });
  const updateAlertPrefs = useCallback((patch: Partial<AlertPrefs>) => {
    setAlertPrefs((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [alertsSeenTs, setAlertsSeenTs] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const raw = Number(localStorage.getItem(ALERTS_SEEN_KEY));
    return Number.isFinite(raw) ? raw : 0;
  });
  const rowTimeMs = useCallback((r: GmailTx) => {
    const t = r.internal_date ? new Date(r.internal_date).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
  }, []);
  const alertRows = useMemo(
    () => filteredRows.filter((r) => {
      const s = getRowStatus(r);
      if (s === 'needs_routing') return alertPrefs.needsRouting;
      if (s === 'unparsed') return alertPrefs.unparsed;
      return false;
    }),
    [filteredRows, getRowStatus, alertPrefs.needsRouting, alertPrefs.unparsed],
  );
  const unreadAlertRows = useMemo(
    () => alertRows.filter((r) => rowTimeMs(r) > alertsSeenTs),
    [alertRows, alertsSeenTs, rowTimeMs],
  );
  const unreadAlertCount = unreadAlertRows.length;
  /** Human-friendly arrival label for an alert row ("12m ago · 14:05"). */
  const formatAlertArrival = useCallback((r: GmailTx) => {
    const ms = rowTimeMs(r);
    if (!ms) return 'unknown time';
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    const rel =
      mins < 1 ? 'just now'
        : mins < 60 ? `${mins}m ago`
          : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
            : `${Math.floor(mins / 1440)}d ago`;
    const clock = new Date(ms).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `${rel} · ${clock}`;
  }, [rowTimeMs]);
  /** Newest / oldest unread arrivals, for the banner triage summary. */
  const unreadArrivalSpan = useMemo(() => {
    if (unreadAlertRows.length === 0) return null;
    const sorted = [...unreadAlertRows].sort((a, b) => rowTimeMs(b) - rowTimeMs(a));
    return { newest: sorted[0], oldest: sorted[sorted.length - 1], sorted };
  }, [unreadAlertRows, rowTimeMs]);
  const isUnreadAlertRow = useCallback(
    (r: GmailTx) => {
      const s = getRowStatus(r);
      const enabled = s === 'needs_routing' ? alertPrefs.needsRouting
        : s === 'unparsed' ? alertPrefs.unparsed
          : false;
      return enabled && rowTimeMs(r) > alertsSeenTs;
    },
    [getRowStatus, rowTimeMs, alertsSeenTs, alertPrefs.needsRouting, alertPrefs.unparsed],
  );
  const markAlertsSeen = useCallback(() => {
    const now = Date.now();
    setAlertsSeenTs(now);
    try { localStorage.setItem(ALERTS_SEEN_KEY, String(now)); } catch { /* ignore */ }
  }, []);

  /**
   * In-app prompt: when new unread alerts appear (and prompts are enabled in
   * alert settings) raise a single toast with a jump-to-queue action.
   */
  const promptedUnreadRef = useRef<number>(0);
  useEffect(() => {
    if (!alertPrefs.toastPrompt) { promptedUnreadRef.current = unreadAlertCount; return; }
    if (unreadAlertCount > promptedUnreadRef.current && unreadAlertCount > 0) {
      sonnerToast(`${unreadAlertCount} email alert${unreadAlertCount === 1 ? '' : 's'} need attention`, {
        description: 'Emails awaiting routing or unparsed by the reader.',
        action: {
          label: 'Review',
          onClick: () => document
            .getElementById('email-tx-results')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        },
      });
    }
    promptedUnreadRef.current = unreadAlertCount;
  }, [unreadAlertCount, alertPrefs.toastPrompt]);

  /**
   * Bulk triage helpers for unmatched alerts. `selectAllAlertRows` tick-selects
   * every attention-needing row in the current window (needs routing /
   * unparsed) so the existing bulk-mark bar can act on them; `resolveAllAlerts`
   * is the one-tap path that marks them resolved (credited) in a single
   * append-only batch and acknowledges the unread counter.
   */
  const selectAllAlertRows = useCallback(() => {
    setSelectedIds(new Set(alertRows.map((r) => r.id)));
  }, [alertRows]);

  /**
   * Desktop keyboard shortcuts (ignored while typing in inputs):
   *   g — jump to the needs-routing queue
   *   s — mark all alerts as seen
   *   d — open details for the newest unread alert
   *   ? — show the shortcut cheatsheet
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const jump = () => document
        .getElementById('email-tx-results')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      switch (e.key) {
        case 'g':
        case 'G':
          e.preventDefault();
          setStatusFilter('needs_routing');
          jump();
          sonnerToast('Jumped to needs-routing alerts');
          break;
        case 's':
        case 'S':
          e.preventDefault();
          markAlertsSeen();
          sonnerToast('All alerts marked as seen');
          break;
        case 'd':
        case 'D':
          if (!unreadArrivalSpan) return;
          e.preventDefault();
          setAlertDetailsRow(unreadArrivalSpan.newest);
          break;
        case '?':
          e.preventDefault();
          sonnerToast('Keyboard shortcuts', {
            description: 'g — needs-routing queue · s — mark all seen · d — newest alert details',
            duration: 6000,
          });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [markAlertsSeen, unreadArrivalSpan]);

  const resolveAlertRows = useCallback(async (targets: GmailTx[]) => {
    const ids = targets.map((r) => r.id);
    if (!ids.length) return;
    const ok = window.confirm(
      `Mark ${ids.length} unmatched alert${ids.length === 1 ? '' : 's'} as resolved? This is logged in the audit trail.`,
    );
    if (!ok) return;
    await applyBulkMark('credited', ids, 'Bulk resolved unmatched alerts from Email Transactions triage');
    markAlertsSeen();
  }, [applyBulkMark, markAlertsSeen]);

  /**
   * Compute debit metadata for a single row. Reused in filtering, sorting,
   * and rendering so the breakdown logic is defined in one place.
   */
  const getDebitMeta = useCallback((r: GmailTx) => {
    const history = routingHistory[r.id] ?? [];
    const autoDebitEntry = history.find(
      (h) => h.route === 'withdrawable_debit' && /^DEBIT\b/i.test(h.reason || ''),
    );
    const isReversed = history.some((h) => /revers/i.test(h.reason || ''));
    const isAutoDebited = !!autoDebitEntry && !isReversed;
    const autoImpact = autoDebitResults[r.id];
    const isProxyDebit = /via managed proxy/i.test(autoDebitEntry?.reason || '');
    const debitedName = autoDebitEntry?.target_user_name
      || autoImpact?.userName || 'matched user';
    const rawDebitReason = autoDebitEntry?.reason || '';
    const debitReasonText =
      rawDebitReason.includes('):')
        ? rawDebitReason.slice(rawDebitReason.indexOf('):') + 2).trim()
        : rawDebitReason.trim();
    const debitProxyPartner = (() => {
      const m = rawDebitReason.match(/via managed proxy for ([^,):]+)/i);
      return m ? m[1].trim() : null;
    })();
    const debitIsPartial = /partial/i.test(rawDebitReason);
    const debitAmountValue = autoDebitEntry?.amount ?? autoImpact?.amount ?? Number(r.amount ?? 0);
    return {
      isAutoDebited,
      isProxyDebit,
      debitedName,
      debitReasonText,
      debitProxyPartner,
      debitIsPartial,
      debitAmountValue,
      rawDebitReason,
    };
  }, [routingHistory, autoDebitResults]);

  /**
   * Needs routing 2: an outgoing payout email whose money was never taken off
   * the wallet of the number that was paid out — no auto-debit recorded and no
   * manual routing entry either. Defined after getDebitMeta so it can reuse it.
   */
  const isNeedsDebitRouting = useCallback((r: GmailTx) => {
    if (r.direction !== 'out' && r.direction !== 'charge') return false;
    if (isUnparsedRow(r)) return false;
    if (justRoutedIds.has(r.id)) return false;
    if ((routingHistory[r.id] ?? []).length > 0) return false;
    return !getDebitMeta(r).isAutoDebited;
  }, [routingHistory, justRoutedIds, getDebitMeta]);

  // Navigable rows: the same list the operator sees on the Recent emails page.
  // This drives the Prev / Next button bar inside the Route dialog so Financial
  // Ops can walk through emails in order without closing the dialog each time.
  const visibleRows = useMemo(() => {
    let list = filteredRows.filter((r) => {
      if (directionFilter === 'in' && r.direction !== 'in') return false;
      if (directionFilter === 'out' && r.direction !== 'out' && r.direction !== 'charge') return false;
      if (needsRoutingOnly && !isNeedsRouting(r)) return false;
      if (statusFilter === 'needs_routing_out') {
        if (!isNeedsDebitRouting(r)) return false;
      } else if (statusFilter !== 'all' && getRowStatus(r) !== statusFilter) {
        return false;
      }
      if (matchFilter === 'all') return true;
      const matches = userMatches[r.id] ?? [];
      if (matchFilter === 'reference') return matches.some((u) => u.matched_on.startsWith('reference '));
      if (matchFilter === 'from') return matches.some((u) => u.matched_on.startsWith('from '));
      return matches.some((u) => u.matched_on.startsWith('reference ') || u.matched_on.startsWith('from '));
    });
    // Debit-breakdown filter: only meaningful for outgoing emails.
    if (debitFilter !== 'all') {
      list = list.filter((r) => {
        const meta = getDebitMeta(r);
        if (debitFilter === 'none') return !meta.isAutoDebited;
        if (debitFilter === 'user_debit') return meta.isAutoDebited && !meta.isProxyDebit;
        if (debitFilter === 'proxy_debit') return meta.isAutoDebited && meta.isProxyDebit;
        return true;
      });
    }
    // Debit-breakdown sort: only meaningful when a sort is chosen.
    if (debitSort !== 'none') {
      list = [...list].sort((a, b) => {
        const ma = getDebitMeta(a);
        const mb = getDebitMeta(b);
        // Always push non-debited rows to the bottom when sorting by debit metadata.
        if (!ma.isAutoDebited && !mb.isAutoDebited) return 0;
        if (!ma.isAutoDebited) return 1;
        if (!mb.isAutoDebited) return -1;
        if (debitSort === 'debitType') {
          // Proxy first, then user
          return (mb.isProxyDebit ? 1 : 0) - (ma.isProxyDebit ? 1 : 0);
        }
        if (debitSort === 'debitAmount') {
          return mb.debitAmountValue - ma.debitAmountValue;
        }
        if (debitSort === 'debitName') {
          return ma.debitedName.localeCompare(mb.debitedName);
        }
        return 0;
      });
    } else {
      // Primary sort dropdown. 'newest' is now explicitly sorted by internal_date
      // descending so the latest email always appears on top, regardless of whether
      // rows arrived via realtime subscription or DB pagination order.
      const ts = (r: GmailTx) => {
        const v = r.internal_date ? new Date(r.internal_date).getTime() : 0;
        return Number.isFinite(v) ? v : 0;
      };
      const amt = (r: GmailTx) => (r.amount !== null && Number.isFinite(r.amount) ? (r.amount as number) : -1);
      const statusRank = (r: GmailTx) => {
        const s = getRowStatus(r);
        return s === 'needs_routing' ? 0 : s === 'unparsed' ? 1 : s === 'credited' ? 2 : 3;
      };
      list = [...list].sort((a, b) => {
        if (sortMode === 'newest') return ts(b) - ts(a);
        if (sortMode === 'oldest') return ts(a) - ts(b);
        if (sortMode === 'amount_high') return amt(b) - amt(a) || ts(b) - ts(a);
        if (sortMode === 'amount_low') return amt(a) - amt(b) || ts(b) - ts(a);
        if (sortMode === 'status') return statusRank(a) - statusRank(b) || ts(b) - ts(a);
        return 0;
      });
    }
    return list;
  }, [filteredRows, directionFilter, matchFilter, userMatches, needsRoutingOnly, isNeedsRouting, isNeedsDebitRouting, statusFilter, getRowStatus, debitFilter, debitSort, sortMode, getDebitMeta]);

  const navIndex = routingRow ? visibleRows.findIndex((r) => r.id === routingRow.id) : -1;
  const canPrevNav = navIndex > 0;
  const canNextNav = navIndex >= 0 && navIndex < visibleRows.length - 1;

  // Infinite scroll: when in 'infinite' mode, observe a sentinel at the bottom
  // of the list and grow the rendered window by one page each time it scrolls
  // into view, until every filtered row is shown. Expanded drilldowns persist
  // because `expandedRows` is keyed by row id, not by render position.
  const totalVisible = visibleRows.length;
  useEffect(() => {
    if (paginationMode !== 'infinite') return;
    const node = infiniteSentinelRef.current;
    if (!node) return;
    if (infiniteCount >= totalVisible) return;
    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          // Grow inside a rAF so the reveal happens on the next paint instead of
          // mid-scroll — keeps momentum scrolling smooth on phones.
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            setInfiniteCount((c) => Math.min(c + pageSize, totalVisible));
          });
        }
      },
      // Prefetch well ahead of the fold so the next chunk is already rendered
      // before the operator reaches the bottom (no visible "Loading more…" stall).
      { rootMargin: '1200px 0px' },
    );
    observer.observe(node);
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [paginationMode, infiniteCount, totalVisible, pageSize]);

  /**
   * Move to a page (paged mode) and bring the top of the results list into view
   * WITHOUT scrolling under the sticky search / filter bars. The results anchor
   * carries `scroll-mt-*`, so `scrollIntoView` stops just below them.
   */
  const goToPage = useCallback((page: number) => {
    setCurrentPage(page);
    try { navigator.vibrate?.(10); } catch { /* haptics optional */ }
    requestAnimationFrame(() => {
      document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  /** Compute the best suggested user for a given row and routing mode. */
  const computeSuggestedFor = (r: GmailTx, mode: 'credit' | 'debit') => {
    const matches = userMatches[r.id] ?? [];
    const scoreFrom = mode === 'credit'
      ? (u: MatchedUser) => (
          u.matched_on.startsWith('reference ') ? 100
          : u.matched_on.startsWith('from ') ? 90
          : u.matched_on.startsWith('to ') ? 90
          : u.matched_on.startsWith('name-') ? 75
          : 60
        )
      : (u: MatchedUser) => (
          u.matched_on.startsWith('reference ') ? 100
          : u.matched_on.startsWith('to ') ? 90
          : u.matched_on.startsWith('from ') ? 90
          : u.matched_on.startsWith('name-') ? 75
          : 60
        );
    const top = matches
      .map((u) => ({ u, s: scoreFrom(u) }))
      .sort((a, b) => b.s - a.s)[0]?.u;
    const prefix = mode === 'credit' ? 'from' : 'to';
    const matchedPhone = top?.matched_on.startsWith(`${prefix} `) || top?.matched_on.startsWith('phone ')
      ? top.matched_on.replace(/^(from|to|phone)\s+/, '')
      : null;
    return top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null;
  };

  const navigateToRow = (nextRow: GmailTx, mode: 'credit' | 'debit', overrideUser?: PrefilledUser | null) => {
    setRoutingSuggestedUser(overrideUser ?? computeSuggestedFor(nextRow, mode));
    setRoutingMode(mode);
    setRoutingRow(nextRow);
  };

  /**
   * ── Multi-select batch queues ─────────────────────────────────────────────
   * Ops often tick several rows and want to work through them without going
   * back to the list. Two queues drive that:
   *  - `routeQueue`   : ids still to be routed/charged. Closing the routing
   *                     dialog automatically opens the next queued row.
   *  - `historyQueue` : rows to audit; the history drawer gets prev/next.
   */
  const [routeQueue, setRouteQueue] = useState<string[]>([]);
  const [historyQueue, setHistoryQueue] = useState<GmailTx[]>([]);
  /**
   * Inline alert details drawer. Opens the full context for one attention-needing
   * email (raw subject/snippet, every parsed field, and the routing/resolve
   * actions) without leaving the panel; prev/next walks the unread queue.
   */
  const [alertDetailsRow, setAlertDetailsRow] = useState<GmailTx | null>(null);
  /** Controlled open state for the alert notification settings dialog. */
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);

  const startRouteQueue = useCallback((batch: GmailTx[]) => {
    if (!batch.length) return;
    const [first, ...rest] = batch;
    setRouteQueue(rest.map((r) => r.id));
    navigateToRow(first, first.direction === 'in' ? 'credit' : 'debit');
    sonnerToast(`Routing 1 of ${batch.length}`, {
      description: 'Finish or close this one and the next selected row opens automatically.',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMatches]);

  const startHistoryQueue = useCallback((batch: GmailTx[]) => {
    if (!batch.length) return;
    setHistoryQueue(batch);
    setHistoryDrawerRow(batch[0]);
  }, []);

  const historyQueueIndex = historyDrawerRow
    ? historyQueue.findIndex((r) => r.id === historyDrawerRow.id)
    : -1;

  // Swipe-triggered routing/charging. Because a swipe can easily be the wrong
  // gesture, we snapshot the routing dialog state *before* opening it and show
  // an "Undo" toast that instantly reverts to the previous state (usually
  // closing the just-opened dialog), so a mistaken swipe can be undone quickly.
  const swipeNavigate = (nextRow: GmailTx, mode: 'credit' | 'debit') => {
    const prev = {
      row: routingRow,
      mode: routingMode,
      suggestedUser: routingSuggestedUser,
    };
    navigateToRow(nextRow, mode);
    sonnerToast(
      mode === 'credit' ? 'Opened deposit routing' : 'Opened wallet charge',
      {
        description: 'Swiped by mistake? Undo to go back.',
        duration: 6000,
        action: {
          label: 'Undo',
          onClick: () => {
            setRoutingRow(prev.row);
            setRoutingMode(prev.mode);
            setRoutingSuggestedUser(prev.suggestedUser);
          },
        },
      },
    );
  };

  // Targeted refetch of a single row's routing history after a routing/charging
  // action completes, so the status pill updates immediately without waiting
  // for the realtime feed (which may be throttled) or a full reload.
  const refreshRowStatus = async (rowId: string) => {
    const target = rows.find((r) => r.id === rowId);
    const msgId = target?.gmail_message_id ?? null;
    const filter = msgId
      ? `gmail_transaction_id.eq.${rowId},gmail_message_id.eq.${msgId}`
      : `gmail_transaction_id.eq.${rowId}`;
    const { data, error } = await (supabase.from('email_routing_history') as any)
      .select('id,created_at,route,reason,target_user_id,target_user_name,target_user_phone,routed_by_name,amount,sms_sent')
      .or(filter)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return;
    setRoutingHistory((cur) => ({
      ...cur,
      [rowId]: (data ?? []) as RoutingHistoryEntry[],
    }));
  };

  // Gmail-style label counts, computed off the same rows the list renders from.
  const gmailLabelCounts = useMemo(() => {
    let inCount = 0, outCount = 0, routing = 0, routingOut = 0, unparsed = 0, credited = 0;
    for (const r of filteredRows) {
      if (r.direction === 'in') inCount += 1;
      else if (r.direction === 'out' || r.direction === 'charge') outCount += 1;
      if (isNeedsDebitRouting(r)) routingOut += 1;
      const s = getRowStatus(r);
      if (s === 'needs_routing') routing += 1;
      else if (s === 'unparsed') unparsed += 1;
      else if (s === 'credited') credited += 1;
    }
    return { all: filteredRows.length, in: inCount, out: outCount, routing, routingOut, unparsed, credited };
  }, [filteredRows, getRowStatus, isNeedsDebitRouting]);

  // Gmail label definitions — each one maps onto the existing filter state so
  // no filtering logic changes, only the arrangement.
  const gmailLabels: Array<{
    key: string;
    label: string;
    Icon: typeof Inbox;
    count: number;
    active: boolean;
    apply: () => void;
  }> = [
    {
      key: 'all', label: 'Inbox', Icon: Inbox, count: gmailLabelCounts.all,
      active: directionFilter === 'all' && statusFilter === 'all' && !needsRoutingOnly,
      apply: () => { setDirectionFilter('all'); setFocusDirection(null); setStatusFilter('all'); setNeedsRoutingOnly(false); },
    },
    {
      key: 'in', label: 'Money in', Icon: ArrowDownLeft, count: gmailLabelCounts.in,
      active: directionFilter === 'in',
      apply: () => { setDirectionFilter('in'); setFocusDirection(focusView === 'ops' ? 'in' : null); setStatusFilter('all'); setNeedsRoutingOnly(false); },
    },
    {
      key: 'out', label: 'Money out', Icon: ArrowUpRight, count: gmailLabelCounts.out,
      active: directionFilter === 'out',
      apply: () => { setDirectionFilter('out'); setFocusDirection(focusView === 'ops' ? 'out' : null); setStatusFilter('all'); setNeedsRoutingOnly(false); },
    },
    {
      key: 'needs_routing', label: 'Needs routing 1 · money in', Icon: Send, count: gmailLabelCounts.routing,
      active: statusFilter === 'needs_routing',
      // Settlement labels are direction-blind: a status only exists on incoming
      // mail, so leaving a "Money out" direction filter active would render an
      // empty view even though the counter shows matches. Always reset it.
      apply: () => { setStatusFilter('needs_routing'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
    {
      key: 'needs_routing_out', label: 'Needs routing 2 · money out', Icon: ArrowUpRight, count: gmailLabelCounts.routingOut,
      active: statusFilter === 'needs_routing_out',
      apply: () => { setStatusFilter('needs_routing_out'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
    {
      key: 'unparsed', label: 'Unparsed', Icon: AlertOctagon, count: gmailLabelCounts.unparsed,
      active: statusFilter === 'unparsed',
      apply: () => { setStatusFilter('unparsed'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
    {
      key: 'credited', label: 'Credited', Icon: CheckCircle2, count: gmailLabelCounts.credited,
      active: statusFilter === 'credited',
      apply: () => { setStatusFilter('credited'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
  ];

  const applyRecentWindow = (days: number) => {
    const todayKey = dateKeyInTz(new Date(), tz);
    const [y, m, d] = todayKey.split('-').map(Number);
    const toUtc = Date.UTC(y, m - 1, d);
    const fromUtc = toUtc - (days - 1) * 86_400_000;
    const fmtKey = (ms: number) => {
      const dt = new Date(ms);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    };
    setFromDate(fmtKey(fromUtc));
    setToDate(fmtKey(toUtc));
  };

  return {
    toast, rows, setRows, state, setState, loadError,
    setLoadError, lastSuccessAt, setLastSuccessAt, loading, setLoading, polling,
    setPolling, initialTz, todayKeyInitial, fromDate, setFromDate, toDate,
    setToDate, browserTz, tz, setTz, netThreshold, setNetThreshold,
    searchQuery, setSearchQuery, searchOptionsOpen, setSearchOptionsOpen, phoneQuery, setPhoneQuery,
    pageSize, setPageSize, currentPage, setCurrentPage, paginationMode, setPaginationMode,
    infiniteCount, setInfiniteCount, infiniteSentinelRef, matchFilter, setMatchFilter, workspaceTab,
    setWorkspaceTab, directionFilter, setDirectionFilter, focusDirection, setFocusDirection, focusView,
    setFocusView, gmailNavOpen, setGmailNavOpen, needsRoutingOnly, setNeedsRoutingOnly, debitFilter,
    setDebitFilter, debitSort, setDebitSort, statusFilter, setStatusFilter, sortMode,
    setSortMode, filterPresets, setFilterPresets, activePresetId, setActivePresetId, presetNameDraft,
    setPresetNameDraft, presetSaveOpen, setPresetSaveOpen, currentPresetSnapshot, savePreset, applyPreset,
    deletePreset, channelCacheRef, flushChannelCache, userMatches, setUserMatches, routingHistory,
    setRoutingHistory, justRoutedIds, setJustRoutedIds, userBalances, setUserBalances, userProxies,
    setUserProxies, userRecentTx, setUserRecentTx, balanceRefreshedAt, setBalanceRefreshedAt, reverseBusy,
    setReverseBusy, expandedRows, setExpandedRows, toggleRowExpanded, creditedDeposits, setCreditedDeposits,
    ledgerCredits, setLedgerCredits, manualMarks, setManualMarks, selectedIds, setSelectedIds,
    bulkBusy, setBulkBusy, withdrawalMatches, setWithdrawalMatches, autoApproving, setAutoApproving,
    inviteSms, setInviteSms, editingRow, setEditingRow, routingRow, setRoutingRow,
    routingSuggestedUser, setRoutingSuggestedUser, routingMode, setRoutingMode, inlineRouteUsers, setInlineRouteUsers,
    historyDrawerRow, setHistoryDrawerRow, historyDrawerQuery, setHistoryDrawerQuery, historyDrawerType, setHistoryDrawerType,
    pendingSwipe, setPendingSwipe, swipeAck, setSwipeAck, autoDebitBusy, setAutoDebitBusy,
    autoDebitProgress, setAutoDebitProgress, autoDebitResults, setAutoDebitResults, rulesVersion, setRulesVersion,
    storedUserRules, setStoredUserRules, mobileFiltersOpen, setMobileFiltersOpen, mobileStatsOpen, setMobileStatsOpen,
    chartBrush, setChartBrush, tooltipPlacement, setTooltipPlacement, statTooltipSide, unparsedOpen,
    setUnparsedOpen, persistUserRules, deleteUserRule, load, recordTidAutoCreditAudit, applyBulkMark,
    markRowResolved, reverseRoutingEntry, channelToPaymentMethod, autoApproveWithdrawal, pollNow, fromTs,
    toTs, inRange, searchActiveForRange, dateRows, searchTokens, expandedSearchTokens,
    matchesSearch, phoneDigits, phoneNeedle, phoneActive, matchesPhone, filteredRows,
    searchActive, channelCache, cacheSnapshot, rowChannel, ch, rangeActive,
    parsedCount, unparsedRows, validity, flaggedCount, isCountable, totalAmount,
    totalIn, totalOut, netAmount, unmatchedInCount, unmatchedOutCount, channelBreakdown,
    totalFees, feeCount, dailySeries, isNeedsRouting, getRowStatus, ALERTS_SEEN_KEY,
    ALERT_PREFS_KEY, alertPrefs, setAlertPrefs, updateAlertPrefs, alertsSeenTs, setAlertsSeenTs,
    rowTimeMs, alertRows, unreadAlertRows, unreadAlertCount, formatAlertArrival, unreadArrivalSpan,
    isUnreadAlertRow, markAlertsSeen, promptedUnreadRef, selectAllAlertRows, resolveAlertRows, getDebitMeta,
    isNeedsDebitRouting, visibleRows, navIndex, canPrevNav, canNextNav, totalVisible,
    goToPage, computeSuggestedFor, navigateToRow, routeQueue, setRouteQueue, historyQueue,
    setHistoryQueue, alertDetailsRow, setAlertDetailsRow, alertSettingsOpen, setAlertSettingsOpen, startRouteQueue,
    startHistoryQueue, historyQueueIndex, swipeNavigate, refreshRowStatus, gmailLabelCounts, gmailLabels,
    applyRecentWindow,
  };
}
