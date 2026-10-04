import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import {
  AlertTriangle, CalendarIcon, CheckCircle2, ChevronDown, ChevronUp, Inbox, Loader2, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';

interface GmailTx {
  id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  amount: number | null;
  transaction_id: string | null;
  counterparty: string | null;
  internal_date: string | null;
  parsed: boolean;
  direction: string | null;
  linked_deposit_request_id: string | null;
}

interface PendingDeposit {
  id: string;
  amount: number;
  transaction_id: string | null;
  created_at: string;
  user_id: string;
  full_name?: string | null;
  phone?: string | null;
}

const fmtUgx = (n: number | null | undefined) =>
  n == null ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

/**
 * "Needs Review" queue — surfaces inbound parsed Gmail rows that the
 * auto-match engine could not safely link, split into:
 *   • Unmatched   — no candidate pending deposit could be found
 *   • Conflicting — multiple pending deposits share the same amount in window
 *
 * Operators filter by date range and by a specific deposit request
 * (ID, Transaction ID, depositor name, or phone) to triage faster.
 */
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
const DEFAULT_PAGE_SIZE: PageSize = 10;

const STORAGE_KEY = 'welile.emailNeedsReview.uiState.v1';

type PersistedState = {
  unmatchedOpen: boolean;
  conflictingOpen: boolean;
  unmatchedPage: number;
  conflictingPage: number;
  unmatchedSearch: string;
  unmatchedPageSize: PageSize;
  conflictingPageSize: PageSize;
};

const DEFAULT_STATE: PersistedState = {
  unmatchedOpen: true,
  conflictingOpen: true,
  unmatchedPage: 1,
  conflictingPage: 1,
  unmatchedSearch: '',
  unmatchedPageSize: DEFAULT_PAGE_SIZE,
  conflictingPageSize: DEFAULT_PAGE_SIZE,
};

function loadPersistedState(): PersistedState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return DEFAULT_STATE;
  }
}

export function EmailNeedsReviewPanel() {
  const { toast } = useToast();
  const [emails, setEmails] = useState<GmailTx[]>([]);
  const [pending, setPending] = useState<PendingDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fromDate, setFromDate] = useState<Date | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [toDate, setToDate] = useState<Date | undefined>(undefined);
  const [depositFilter, setDepositFilter] = useState('');
  // Persisted UI state — collapse open/closed, page positions, in-section search.
  // Survives filter changes, refresh, and tab close (localStorage).
  const initial = useMemo(loadPersistedState, []);
  const [unmatchedOpen, setUnmatchedOpen] = useState(initial.unmatchedOpen);
  const [conflictingOpen, setConflictingOpen] = useState(initial.conflictingOpen);
  const [unmatchedPage, setUnmatchedPage] = useState(initial.unmatchedPage);
  const [conflictingPage, setConflictingPage] = useState(initial.conflictingPage);
  const [unmatchedSearch, setUnmatchedSearch] = useState(initial.unmatchedSearch);
  const [unmatchedPageSize, setUnmatchedPageSize] = useState<PageSize>(
    PAGE_SIZE_OPTIONS.includes(initial.unmatchedPageSize) ? initial.unmatchedPageSize : DEFAULT_PAGE_SIZE,
  );
  const [conflictingPageSize, setConflictingPageSize] = useState<PageSize>(
    PAGE_SIZE_OPTIONS.includes(initial.conflictingPageSize) ? initial.conflictingPageSize : DEFAULT_PAGE_SIZE,
  );

  // Bulk selection (Unmatched section only). Not persisted — page-local.
  const [selectedUnmatched, setSelectedUnmatched] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Persist whenever any of the tracked UI bits change.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          unmatchedOpen,
          conflictingOpen,
          unmatchedPage,
          conflictingPage,
          unmatchedSearch,
          unmatchedPageSize,
          conflictingPageSize,
        } satisfies PersistedState),
      );
    } catch { /* ignore quota / privacy-mode errors */ }
  }, [unmatchedOpen, conflictingOpen, unmatchedPage, conflictingPage, unmatchedSearch, unmatchedPageSize, conflictingPageSize]);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const fromIso = fromDate ? fromDate.toISOString() : null;
      const toIso = toDate
        ? new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59).toISOString()
        : null;

      let emailQ: any = (supabase.from('gmail_transactions') as any)
        .select('id,from_email,from_name,subject,snippet,amount,transaction_id,counterparty,internal_date,parsed,direction,linked_deposit_request_id')
        .is('linked_deposit_request_id', null)
        .eq('parsed', true)
        .order('internal_date', { ascending: false, nullsFirst: false })
        .limit(300);
      if (fromIso) emailQ = emailQ.gte('internal_date', fromIso);
      if (toIso) emailQ = emailQ.lte('internal_date', toIso);

      let pendingQ: any = (supabase.from('deposit_requests') as any)
        .select('id,amount,transaction_id,created_at,user_id,profiles!deposit_requests_user_id_fkey(full_name,phone)')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(500);
      if (fromIso) pendingQ = pendingQ.gte('created_at', fromIso);
      if (toIso) pendingQ = pendingQ.lte('created_at', toIso);

      const [{ data: e, error: eErr }, { data: p, error: pErr }] = await Promise.all([emailQ, pendingQ]);
      if (eErr) throw eErr;
      if (pErr) {
        // FK relationship name may differ; fall back to plain select.
        const { data: p2 } = await supabase.from('deposit_requests')
          .select('id,amount,transaction_id,created_at,user_id')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(500);
        const userIds = Array.from(new Set((p2 ?? []).map((x: any) => x.user_id)));
        const { data: profs } = userIds.length
          ? await supabase.from('profiles').select('id,full_name,phone').in('id', userIds)
          : { data: [] as any[] };
        const pmap = new Map<string, any>();
        (profs ?? []).forEach((x: any) => pmap.set(x.id, x));
        setPending((p2 ?? []).map((x: any) => ({
          ...x,
          full_name: pmap.get(x.user_id)?.full_name ?? null,
          phone: pmap.get(x.user_id)?.phone ?? null,
        })));
      } else {
        setPending((p ?? []).map((x: any) => ({
          id: x.id,
          amount: Number(x.amount),
          transaction_id: x.transaction_id,
          created_at: x.created_at,
          user_id: x.user_id,
          full_name: x.profiles?.full_name ?? null,
          phone: x.profiles?.phone ?? null,
        })));
      }
      setEmails((e as GmailTx[]) ?? []);
    } catch (err: any) {
      if (!silent) toast({ title: 'Failed to load review queue', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fromDate, toDate, toast]);

  useEffect(() => { load(); }, [load]);

  // Bucket emails into unmatched vs conflicting + filter by deposit search.
  const { unmatched, conflicting } = useMemo(() => {
    const q = depositFilter.trim().toLowerCase();
    const matchesDepositFilter = (e: GmailTx, candidates: PendingDeposit[]) => {
      if (!q) return true;
      // Match the email if any candidate pending deposit matches the search,
      // or the email's own TID / counterparty contains the query.
      if (e.transaction_id?.toLowerCase().includes(q)) return true;
      if (e.counterparty?.toLowerCase().includes(q)) return true;
      if (e.from_email?.toLowerCase().includes(q)) return true;
      return candidates.some((d) =>
        d.id.toLowerCase().includes(q)
        || d.transaction_id?.toLowerCase().includes(q)
        || d.full_name?.toLowerCase().includes(q)
        || d.phone?.toLowerCase().includes(q)
      );
    };

    const u: Array<{ email: GmailTx; candidates: PendingDeposit[] }> = [];
    const c: Array<{ email: GmailTx; candidates: PendingDeposit[] }> = [];

    for (const e of emails) {
      if (e.amount == null) continue;
      const cands = pending.filter((d) => Math.abs(d.amount - (e.amount ?? 0)) < 0.5);
      if (!matchesDepositFilter(e, cands)) continue;
      if (cands.length >= 2) c.push({ email: e, candidates: cands });
      else u.push({ email: e, candidates: cands });
    }
    return { unmatched: u, conflicting: c };
  }, [emails, pending, depositFilter]);

  // Per-section search within Unmatched — filters before pagination.
  const unmatchedFiltered = useMemo(() => {
    const q = unmatchedSearch.trim().toLowerCase();
    if (!q) return unmatched;
    return unmatched.filter(({ email: e, candidates }) => {
      if (e.transaction_id?.toLowerCase().includes(q)) return true;
      if (e.counterparty?.toLowerCase().includes(q)) return true;
      if (e.from_email?.toLowerCase().includes(q)) return true;
      if (e.from_name?.toLowerCase().includes(q)) return true;
      return candidates.some((d) =>
        d.id.toLowerCase().includes(q)
        || d.transaction_id?.toLowerCase().includes(q)
        || d.full_name?.toLowerCase().includes(q)
        || d.phone?.toLowerCase().includes(q)
      );
    });
  }, [unmatched, unmatchedSearch]);

  // Clamp persisted page if filtered list has shrunk since last visit.
  useEffect(() => {
    const max = Math.max(1, Math.ceil(unmatchedFiltered.length / unmatchedPageSize));
    if (unmatchedPage > max) setUnmatchedPage(max);
  }, [unmatchedFiltered.length, unmatchedPage, unmatchedPageSize]);
  useEffect(() => {
    const max = Math.max(1, Math.ceil(conflicting.length / conflictingPageSize));
    if (conflictingPage > max) setConflictingPage(max);
  }, [conflicting.length, conflictingPage, conflictingPageSize]);

  // Drop selections that are no longer present (after refresh / filter change).
  useEffect(() => {
    setSelectedUnmatched((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(unmatchedFiltered.map((x) => x.email.id));
      let changed = false;
      const next = new Set<string>();
      cur.forEach((id) => { if (live.has(id)) next.add(id); else changed = true; });
      return changed ? next : cur;
    });
  }, [unmatchedFiltered]);

  const linkEmail = async (emailId: string, depositId: string) => {
    const { error } = await (supabase.from('gmail_transactions') as any)
      .update({
        linked_deposit_request_id: depositId,
        auto_matched_at: new Date().toISOString(),
        auto_match_method: 'amount_strong',
      })
      .eq('id', emailId);
    if (error) {
      toast({ title: 'Link failed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Linked', description: 'Email is now paired with the deposit request and ready to approve in the auto-match panel above.' });
    setEmails((cur) => cur.filter((x) => x.id !== emailId));
  };

  // ── Bulk actions (current Unmatched page only) ─────────────────────
  const unmatchedPageItems = useMemo(
    () => paginate(unmatchedFiltered, unmatchedPage, unmatchedPageSize),
    [unmatchedFiltered, unmatchedPage, unmatchedPageSize],
  );
  const pageIds = useMemo(() => unmatchedPageItems.map((x) => x.email.id), [unmatchedPageItems]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedUnmatched.has(id));
  const somePageSelected = pageIds.some((id) => selectedUnmatched.has(id));

  const togglePageSelection = () => {
    setSelectedUnmatched((cur) => {
      const next = new Set(cur);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  // Items selected on the current page that have exactly one candidate (safe to auto-link).
  const selectedAcceptable = useMemo(
    () => unmatchedPageItems.filter((x) => selectedUnmatched.has(x.email.id) && x.candidates.length === 1),
    [unmatchedPageItems, selectedUnmatched],
  );
  const selectedCount = useMemo(
    () => unmatchedPageItems.filter((x) => selectedUnmatched.has(x.email.id)).length,
    [unmatchedPageItems, selectedUnmatched],
  );

  const bulkAccept = async () => {
    if (selectedAcceptable.length === 0) return;
    setBulkBusy(true);
    const now = new Date().toISOString();
    let ok = 0, fail = 0;
    for (const item of selectedAcceptable) {
      const { error } = await (supabase.from('gmail_transactions') as any)
        .update({
          linked_deposit_request_id: item.candidates[0].id,
          auto_matched_at: now,
          auto_match_method: 'bulk_amount_strong',
        })
        .eq('id', item.email.id);
      if (error) fail++; else ok++;
    }
    const okIds = new Set(selectedAcceptable.slice(0, ok).map((x) => x.email.id));
    setEmails((cur) => cur.filter((x) => !okIds.has(x.id)));
    setSelectedUnmatched((cur) => {
      const next = new Set(cur);
      okIds.forEach((id) => next.delete(id));
      return next;
    });
    setBulkBusy(false);
    toast({
      title: `Linked ${ok} email${ok === 1 ? '' : 's'}`,
      description: fail > 0 ? `${fail} failed — refresh and retry.` : 'Now visible in the auto-match panel for approval.',
      variant: fail > 0 ? 'destructive' : undefined,
    });
  };

  const bulkReject = async () => {
    const ids = unmatchedPageItems
      .filter((x) => selectedUnmatched.has(x.email.id))
      .map((x) => x.email.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    // "Reject" = mark parsed=false so the load query excludes them.
    // They remain in gmail_transactions for audit but drop from the review queue.
    const { error } = await (supabase.from('gmail_transactions') as any)
      .update({ parsed: false })
      .in('id', ids);
    setBulkBusy(false);
    if (error) {
      toast({ title: 'Reject failed', description: error.message, variant: 'destructive' });
      return;
    }
    const idSet = new Set(ids);
    setEmails((cur) => cur.filter((x) => !idSet.has(x.id)));
    setSelectedUnmatched((cur) => {
      const next = new Set(cur);
      idSet.forEach((id) => next.delete(id));
      return next;
    });
    toast({ title: `Rejected ${ids.length} email${ids.length === 1 ? '' : 's'}`, description: 'Removed from the review queue.' });
  };

  const toggleSelect = (id: string) => {
    setSelectedUnmatched((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderRow = (
    item: { email: GmailTx; candidates: PendingDeposit[] },
    conflict: boolean,
    selectable = false,
  ) => {
    const e = item.email;
    const checked = selectable && selectedUnmatched.has(e.id);
    return (
      <li key={e.id} className="p-3 sm:p-4 space-y-2">
        <div className="flex items-start gap-3 flex-wrap">
          {selectable && (
            <Checkbox
              checked={checked}
              onCheckedChange={() => toggleSelect(e.id)}
              className="mt-1"
              aria-label="Select email for bulk action"
            />
          )}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={conflict ? 'destructive' : 'secondary'} className="text-[10px]">
                {conflict ? <><AlertTriangle className="h-3 w-3 mr-1" /> Conflicting</> : <><Inbox className="h-3 w-3 mr-1" /> Unmatched</>}
              </Badge>
              <span className="font-semibold text-sm">{fmtUgx(e.amount)}</span>
              {e.transaction_id && (
                <span className="text-[11px] text-muted-foreground font-mono">TID {e.transaction_id}</span>
              )}
              {e.internal_date && (
                <span className="text-[11px] text-muted-foreground">{format(new Date(e.internal_date), 'dd MMM HH:mm')}</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {e.from_name ?? e.from_email ?? 'Unknown sender'}
              {e.counterparty && <> · from {e.counterparty}</>}
            </div>
            {e.subject && <div className="text-xs text-foreground truncate">{e.subject}</div>}
            {e.snippet && <div className="text-[11px] text-muted-foreground line-clamp-2 italic">"{e.snippet}"</div>}
          </div>
        </div>

        {item.candidates.length > 0 ? (
          <div className="rounded-md border bg-muted/30 p-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              {conflict ? `${item.candidates.length} pending deposits share this amount` : 'Possible pending deposit'}
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {conflict
                ? 'Pick the depositor whose name or phone matches the email, then tap Link. The others stay pending.'
                : 'If this is the right depositor, tap Link to credit their wallet. If not, leave it — the next scan will try again.'}
            </p>
            <ul className="divide-y">
              {item.candidates.map((d) => (
                <li key={d.id} className="py-1.5 flex items-center gap-2 justify-between text-xs">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{d.full_name ?? 'Unknown depositor'}</div>
                    <div className="text-[11px] text-muted-foreground truncate font-mono">
                      {d.phone ?? '—'} · TID {d.transaction_id ?? '—'} · {format(new Date(d.created_at), 'dd MMM HH:mm')}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => linkEmail(e.id, d.id)}
                    title={`Credit this email's amount to ${d.full_name ?? 'this depositor'} and mark the deposit approved.`}
                  >
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground italic">
            No pending deposit matches this amount in the selected window. Likely a legacy email or an unrequested deposit — safe to leave alone.
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b bg-gradient-to-r from-amber-500/5 to-transparent flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-sm sm:text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Needs Review
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Parsed inbox emails the auto-matcher couldn't safely link — either no candidate or multiple candidates share the same amount.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="gap-2">
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <DateField label="From" value={fromDate} onChange={setFromDate} />
          <DateField label="To" value={toDate} onChange={setToDate} />
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={depositFilter}
              onChange={(ev) => setDepositFilter(ev.target.value)}
              placeholder="Filter by deposit ID, TID, depositor name or phone…"
              className="pl-7 h-9 text-xs"
            />
            {depositFilter && (
              <button
                type="button"
                onClick={() => setDepositFilter('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Loading review queue…
        </div>
      ) : (
        <div className="divide-y">
          {/* ── Unmatched ── */}
          <Collapsible open={unmatchedOpen} onOpenChange={setUnmatchedOpen}>
            <CollapsibleTrigger asChild>
              <button className="w-full flex items-center justify-between p-4 text-left hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-2.5">
                  <Inbox className="h-4 w-4 text-muted-foreground" />
                  <span className="font-semibold text-sm">Unmatched</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{unmatched.length}</Badge>
                </div>
                {unmatchedOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {unmatched.length === 0 ? (
                <EmptyState text="Nothing to review — every parsed email is linked or has no candidate." />
              ) : (
                <>
                  <div className="p-3 border-b bg-muted/10">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={unmatchedSearch}
                        onChange={(ev) => setUnmatchedSearch(ev.target.value)}
                        placeholder="Search reference ID, TID, depositor name or phone…"
                        className="pl-7 pr-7 h-9 text-xs"
                      />
                      {unmatchedSearch && (
                        <button
                          type="button"
                          onClick={() => setUnmatchedSearch('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          aria-label="Clear search"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {unmatchedSearch && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {unmatchedFiltered.length} of {unmatched.length} match “{unmatchedSearch}”
                      </p>
                    )}
                  </div>
                  {unmatchedFiltered.length === 0 ? (
                    <EmptyState text={`No unmatched items match “${unmatchedSearch}”.`} />
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/20 text-xs flex-wrap">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={allPageSelected ? true : somePageSelected ? 'indeterminate' : false}
                            onCheckedChange={togglePageSelection}
                            aria-label="Select all on page"
                          />
                          <span className="text-muted-foreground">
                            {selectedCount > 0
                              ? `${selectedCount} selected on this page`
                              : 'Select all on page'}
                          </span>
                        </label>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs gap-1.5"
                            disabled={bulkBusy || selectedAcceptable.length === 0}
                            onClick={bulkAccept}
                            title="Auto-link selected emails that have exactly one pending deposit candidate."
                          >
                            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            Accept match{selectedAcceptable.length > 0 ? ` (${selectedAcceptable.length})` : ''}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs gap-1.5 text-destructive hover:text-destructive"
                            disabled={bulkBusy || selectedCount === 0}
                            onClick={bulkReject}
                            title="Remove selected emails from the review queue (kept for audit)."
                          >
                            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            Reject{selectedCount > 0 ? ` (${selectedCount})` : ''}
                          </Button>
                        </div>
                      </div>
                      {selectedCount > 0 && selectedAcceptable.length < selectedCount && (
                        <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-amber-500/5 border-b">
                          {selectedCount - selectedAcceptable.length} selected item{selectedCount - selectedAcceptable.length === 1 ? '' : 's'} can't be auto-accepted (no candidate or multiple candidates) — use Link inline or Reject.
                        </div>
                      )}
                      <ul className="divide-y">{unmatchedPageItems.map((x) => renderRow(x, false, true))}</ul>
                      <PaginationBar
                        page={unmatchedPage}
                        total={unmatchedFiltered.length}
                        onChange={setUnmatchedPage}
                        pageSize={unmatchedPageSize}
                        onPageSizeChange={(s) => { setUnmatchedPageSize(s); setUnmatchedPage(1); }}
                      />
                    </>
                  )}
                </>
              )}
            </CollapsibleContent>
          </Collapsible>

          {/* ── Conflicting ── */}
          <Collapsible open={conflictingOpen} onOpenChange={setConflictingOpen}>
            <CollapsibleTrigger asChild>
              <button className="w-full flex items-center justify-between p-4 text-left hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <span className="font-semibold text-sm">Conflicting</span>
                  <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{conflicting.length}</Badge>
                </div>
                {conflictingOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {conflicting.length === 0 ? (
                <EmptyState text="No conflicting emails — no two pending deposits share an amount in this window." />
              ) : (
                <>
                  <ul className="divide-y">{paginate(conflicting, conflictingPage, conflictingPageSize).map((x) => renderRow(x, true))}</ul>
                  <PaginationBar
                    page={conflictingPage}
                    total={conflicting.length}
                    onChange={setConflictingPage}
                    pageSize={conflictingPageSize}
                    onPageSizeChange={(s) => { setConflictingPageSize(s); setConflictingPage(1); }}
                  />
                </>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

function paginate<T>(arr: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return arr.slice(start, start + pageSize);
}

function PaginationBar({
  page, total, onChange, pageSize, onPageSizeChange,
}: {
  page: number;
  total: number;
  onChange: (p: number) => void;
  pageSize: PageSize;
  onPageSizeChange: (s: PageSize) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const fromCount = (page - 1) * pageSize + 1;
  const toCount = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-t bg-muted/20 text-xs flex-wrap">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-muted-foreground">
          {total === 0 ? 'No items' : `Showing ${fromCount}–${toCount} of ${total}`}
        </span>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <span>Rows</span>
          <select
            value={pageSize}
            onChange={(ev) => onPageSizeChange(Number(ev.target.value) as PageSize)}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Rows per page"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </Button>
        <span className="font-medium tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: Date | undefined; onChange: (d: Date | undefined) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 text-xs gap-2 justify-start min-w-[150px]', !value && 'text-muted-foreground')}
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {label}: {value ? format(value, 'dd MMM yyyy') : 'Any'}
          {value && (
            <X
              className="h-3 w-3 ml-auto hover:text-destructive"
              onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); onChange(undefined); }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          initialFocus
          className={cn('p-3 pointer-events-auto')}
        />
      </PopoverContent>
    </Popover>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="p-8 text-center text-sm text-muted-foreground">
      <Inbox className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
      {text}
    </div>
  );
}