import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDistanceToNow, format as formatDate } from 'date-fns';
import {
  Loader2, WifiOff, Wifi, Search, Trash2,
  CheckCircle2, AlertCircle, RefreshCcw, ChevronLeft, ChevronRight,
  User, Banknote, ClipboardCheck, Home, KeyRound, Sparkles,
  HelpCircle, ChevronDown, Clock, X, Settings2, Cloud, CloudOff, Globe2,
} from 'lucide-react';
import {
  cacheTenants, getCachedTenants, addEntry, deleteEntry, getEntries,
  getQueuedEntries, updateEntry, newClientUuid,
  getCachedNormalizedIndex, saveCachedNormalizedIndex,
  bumpTenantPick, getRecentPicks,
  type CachedTenant, type FieldEntry, type NormalizedTenantEntry, type TenantPickRecord,
} from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { FieldCollectDailyTotals } from '@/components/agent/FieldCollectDailyTotals';
import {
  normalizeName,
  normalizePhone,
  tenantListFingerprint,
  phoneVariants,
  tailMatch,
  tailSharedCounts,
  getFuzzyPhoneResolver,
} from '@/lib/tenantSearch';

interface FieldCollectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 1 | 2 | 3;

type Purpose = 'rent' | 'deposit' | 'other';

const PURPOSES: { id: Purpose; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'rent', label: 'Rent', icon: Home },
  { id: 'deposit', label: 'Deposit', icon: KeyRound },
  { id: 'other', label: 'Other', icon: Sparkles },
];

/**
 * Module-scoped scoring cache. Lives outside the component so it survives
 * dialog close → reopen cycles within a single page session — repeated
 * searches feel instant because we skip rescoring entirely on cache hits.
 *
 * Safety / correctness:
 *   • Keyed by `${agentId}::${cacheKey}` so different agents on the same
 *     device (rare, but possible) never see each other's results.
 *   • Bucketed by `fingerprint` (tenant list hash). Whenever the agent's
 *     tenant list changes — new tenant synced, edits, deletions — the
 *     fingerprint flips and we wipe their bucket atomically.
 *   • LRU-bounded per agent at SEARCH_CACHE_MAX entries. Map iteration
 *     order = insertion order, so dropping `keys().next()` evicts the
 *     oldest entry in O(1).
 *   • Memory: cleared on full page reload (it's a JS Map, not persisted),
 *     which is the right tradeoff — long-lived sessions get the speedup,
 *     reloads get a clean slate.
 */
type FilteredRow = {
  t: CachedTenant;
  score: number;
  matchType: 'phone' | 'name' | 'both' | null;
  ambiguous: boolean;
  bestMatchFallback: boolean;
};
const SEARCH_CACHE_MAX = 50;
type SearchCacheBucket = { fingerprint: string; entries: Map<string, FilteredRow[]> };
const searchCacheByAgent = new Map<string, SearchCacheBucket>();

function getSearchCache(agentId: string, fingerprint: string): Map<string, FilteredRow[]> {
  let bucket = searchCacheByAgent.get(agentId);
  if (!bucket || bucket.fingerprint !== fingerprint) {
    bucket = { fingerprint, entries: new Map() };
    searchCacheByAgent.set(agentId, bucket);
  }
  return bucket.entries;
}

/**
 * Highlight "lanes" — color-code which kind of match was hit so agents can see
 * at a glance *why* a tenant appears.
 *
 *   phone        → success/green       (digit match in phone column)
 *   name-prefix  → primary/blue, bold  (full-string starts with query)
 *   name-word    → primary/blue        (start of any name word, e.g. "Jane S…")
 *   name-sub     → amber/warning       (mid-word substring — weakest signal)
 */
type HighlightKind = 'phone' | 'name-prefix' | 'name-word' | 'name-sub';

const HIGHLIGHT_CLASS: Record<HighlightKind, string> = {
  phone:         'bg-success/20 text-success-foreground rounded px-0.5 font-semibold',
  'name-prefix': 'bg-primary/25 text-foreground rounded px-0.5 font-bold underline decoration-primary/60 underline-offset-2',
  'name-word':   'bg-primary/20 text-foreground rounded px-0.5 font-semibold',
  'name-sub':    'bg-warning/20 text-foreground rounded px-0.5 font-medium',
};

/** Render text with the matched span wrapped in a color-coded <mark>. */
function renderHighlighted(
  text: string,
  start: number,
  end: number,
  kind: HighlightKind = 'name-word',
): React.ReactNode {
  if (start < 0 || end <= start) return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className={HIGHLIGHT_CLASS[kind]}>
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

/**
 * Highlight the matching part of a tenant name. Uses normalized comparison so
 * "obrien" highlights inside "O'Brien" and "jose" inside "José". Falls back
 * to a plain case-insensitive substring search if normalization can't locate
 * the query (e.g. when the query has been split across whitespace).
 */
function highlightName(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;

  // 1. Try normalized match — walk both strings in parallel, mapping each
  //    source character to its normalized form, and find a contiguous span
  //    in the original text whose normalized projection equals the query.
  const qNorm = normalizeName(q);
  if (qNorm) {
    const map: { src: number; norm: string }[] = [];
    let normRun = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const cleaned = ch.replace(/[^a-z0-9\s]+/g, ' ');
      // Collapse runs of whitespace (matches normalizeName) by skipping
      // additional whitespace once the previous emitted char was a space.
      const prev = normRun[normRun.length - 1];
      const emit = cleaned === ' ' && prev === ' ' ? '' : cleaned;
      map.push({ src: i, norm: emit });
      normRun += emit;
    }
    const trimmedNorm = normRun.trim();
    const trimOffset = normRun.indexOf(trimmedNorm);
    const idx = trimmedNorm.indexOf(qNorm);
    if (idx !== -1) {
      // Walk the map to find the source-text positions for [start, end) of the
      // normalized hit.
      const targetStart = trimOffset + idx;
      const targetEnd = targetStart + qNorm.length;
      let cursor = 0;
      let srcStart = -1;
      let srcEnd = -1;
      for (let i = 0; i < map.length; i++) {
        const len = map[i].norm.length;
        if (srcStart === -1 && cursor + len > targetStart) srcStart = map[i].src;
        if (cursor + len >= targetEnd) { srcEnd = map[i].src + 1; break; }
        cursor += len;
      }
      if (srcStart !== -1 && srcEnd !== -1) {
        // Decide which name lane drove the match so we can color-code it.
        // - 'name-prefix' if the normalized hit is at the very start of the trimmed name
        // - 'name-word' if it sits at the start of any word (after a space)
        // - 'name-sub' otherwise (mid-word substring)
        let kind: HighlightKind = 'name-sub';
        if (idx === 0) kind = 'name-prefix';
        else if (trimmedNorm[idx - 1] === ' ') kind = 'name-word';
        return renderHighlighted(text, srcStart, srcEnd, kind);
      }
    }
  }

  // 2. Fallback: plain case-insensitive substring.
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  // Same lane heuristic on the raw string for the fallback path.
  const lower = text.toLowerCase();
  let kind: HighlightKind = 'name-sub';
  if (idx === 0) kind = 'name-prefix';
  else if (lower[idx - 1] === ' ') kind = 'name-word';
  return renderHighlighted(text, idx, idx + q.length, kind);
}

/**
 * Highlight the matching part of a phone number. Compares only digits so
 * "0772" finds "+256 772 123 456" and the highlighted span covers the
 * formatted digits (and intervening spaces/dashes) in the original text.
 */
function highlightPhone(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const qDigits = q.replace(/\D+/g, '');
  if (!qDigits) return text;

  // Map each character in the original text to its digit position.
  const digits: string[] = [];
  const digitToSrc: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i])) {
      digits.push(text[i]);
      digitToSrc.push(i);
    }
  }
  const digitsStr = digits.join('');

  // Try the query as typed first, then with leading "0" stripped, then
  // with leading "256" stripped — covers "0772…", "+256 772…" and "772…".
  const candidates = [qDigits];
  if (qDigits.startsWith('0')) candidates.push(qDigits.slice(1));
  if (qDigits.startsWith('256')) candidates.push(qDigits.slice(3));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const idx = digitsStr.indexOf(candidate);
    if (idx !== -1) {
      const srcStart = digitToSrc[idx];
      const srcEnd = digitToSrc[idx + candidate.length - 1] + 1;
      return renderHighlighted(text, srcStart, srcEnd, 'phone');
    }
  }

  return text;
}

// `normalizeName` / `normalizePhone` live in `@/lib/tenantSearch` so the
// scoring logic can be unit-tested without dragging the dialog into vitest.

export function FieldCollectDialog({ open, onOpenChange }: FieldCollectDialogProps) {
  const { user } = useAuth();
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [tenants, setTenants] = useState<CachedTenant[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [entries, setEntries] = useState<FieldEntry[]>([]);
  const [search, setSearch] = useState('');
  /**
   * Debounced mirror of `search`. The fuzzy scoring memo (`filtered` below)
   * runs against this value instead of `search`, so a fast typist doesn't
   * pay the full O(N) scoring cost on every keystroke when their caseload
   * is in the thousands.
   *
   * Why ~120ms: short enough that the list still feels live (a single
   * character lands well under a normal typing cadence) but long enough to
   * coalesce a burst like "078123" into one scoring pass instead of six.
   * Empty queries skip the debounce entirely so clearing the input snaps
   * back to browse mode immediately — no awkward 120ms ghost-result.
   */
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    // Instant transition for "user cleared the box" so the empty-state
    // (recents + browse pager) appears with zero perceived lag.
    if (search === '') {
      setDebouncedSearch('');
      return;
    }
    const id = window.setTimeout(() => setDebouncedSearch(search), 120);
    return () => window.clearTimeout(id);
  }, [search]);
  const [picked, setPicked] = useState<CachedTenant | null>(null);
  const [walkupName, setWalkupName] = useState('');
  const [walkupPhone, setWalkupPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('rent');
  const [step, setStep] = useState<Step>(1);
  const [saving, setSaving] = useState(false);
  const [, setSyncing] = useState(false);

  /**
   * Keyboard navigation for the tenant picker.
   * activeIdx walks a single virtual list: [...recentTenants, ...filtered].
   * - ArrowDown / ArrowUp move the highlight (wraps).
   * - Enter picks the highlighted tenant.
   * - Escape clears the search box (and highlight) without closing the dialog.
   * Resets whenever the underlying list contents change.
   */
  const [activeIdx, setActiveIdx] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /**
   * Scroll-parent for the virtualized tenant suggestion list. Anchored to the
   * `max-h-72 overflow-y-auto` container that wraps the result rows so
   * `useVirtualizer` measures the right viewport. Without this ref the
   * virtualizer can't compute which rows are visible and the list collapses
   * to a single hidden row.
   */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  // Per-query result cache lives at module scope (see top of file) so it
  // persists across dialog open/close cycles — repeated searches stay
  // instant. Invalidation is handled by the agent + fingerprint key inside
  // `getSearchCache`.
  /**
   * Ref to the tenant search input. Used by the section-level type-to-search
   * handler so a printable key pressed anywhere in Step 1 (e.g. while focus is
   * on a "Recent" chip) routes that character into the search input and
   * snaps the highlight to the first match.
   */
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Browse-mode controls — only used when the search box is empty so the
   * agent can flip through their full caseload of thousands of tenants
   * without having to type. Both pieces of state persist for the dialog
   * session (reset on close via `resetForm`/effect below).
   *
   *  - browseSort:  'recent' (default — last activity desc) or 'name' (A→Z)
   *  - browsePage:  0-indexed page within the sorted list, 100 rows/page
   *
   * Search mode is unchanged: scoring + virtualized list still cap at 200.
   */
  type BrowseSort = 'recent' | 'name';
  /**
   * Browse-mode status filter — narrows the caseload to tenants the agent
   * has worked with vs. ones still pending a first collection. Derived
   * from already-loaded `entries` (queued OR synced count as "active") so
   * we don't add a new business-logic surface or a new fetch.
   *
   *  - 'all'      → no filter (default, preserves prior behaviour)
   *  - 'active'   → tenants with ≥1 captured entry
   *  - 'inactive' → tenants with zero captured entries (new caseload)
   */
  type BrowseStatus = 'all' | 'active' | 'inactive';
  const BROWSE_PAGE_SIZE = 100;
  /**
   * Persisted-key for the Active/Inactive/All chip selection. Scoped per
   * agent so a shared device doesn't leak one agent's filter preference
   * to another. The picker's `Sort` and `Page` intentionally stay
   * session-only — those are navigation state, not preferences.
   */
  const browseStatusStorageKey = user?.id
    ? `welile.fieldCollect.browseStatus:${user.id}`
    : null;
  const [browseSort, setBrowseSort] = useState<BrowseSort>('recent');
  const [browseStatus, setBrowseStatus] = useState<BrowseStatus>(() => {
    // Lazy initializer so we read localStorage exactly once per mount.
    // Guards: SSR-safe (typeof window), user-scoped key, and validates
    // the stored value against the union — anything weird falls back
    // to 'all' so a corrupted entry never breaks the picker.
    if (typeof window === 'undefined' || !user?.id) return 'all';
    try {
      const raw = window.localStorage.getItem(`welile.fieldCollect.browseStatus:${user.id}`);
      if (raw === 'all' || raw === 'active' || raw === 'inactive') return raw;
    } catch {
      // localStorage can throw in private mode / quota-exceeded — ignore.
    }
    return 'all';
  });

  /**
   * Persist the chip selection whenever it changes. Skips writes when
   * we don't yet know the user (avoids polluting the unscoped key) and
   * swallows quota/private-mode errors so a write failure never crashes
   * the picker — preference persistence is best-effort UX, not data.
   */
  useEffect(() => {
    if (!browseStatusStorageKey || typeof window === 'undefined') return;
    try {
      // Treat 'all' as the absence of a preference: removing the key
      // (instead of writing it) keeps localStorage clean after Reset
      // and makes "no key set" semantically equivalent to "default".
      if (browseStatus === 'all') {
        window.localStorage.removeItem(browseStatusStorageKey);
      } else {
        window.localStorage.setItem(browseStatusStorageKey, browseStatus);
      }
    } catch {
      /* noop — see above */
    }
  }, [browseStatus, browseStatusStorageKey]);

  /**
   * Late-hydration: if `user.id` resolves AFTER the lazy initializer ran
   * (common when auth is still loading on first mount), pull the stored
   * preference now. Tracks `hasHydratedStatus` so a user manually
   * toggling the chip before auth lands isn't immediately overwritten
   * by a stale stored value when `user.id` finally arrives.
   */
  const hasHydratedStatusRef = useRef(false);
  useEffect(() => {
    if (hasHydratedStatusRef.current) return;
    if (!browseStatusStorageKey || typeof window === 'undefined') return;
    hasHydratedStatusRef.current = true;
    try {
      const raw = window.localStorage.getItem(browseStatusStorageKey);
      if (raw === 'all' || raw === 'active' || raw === 'inactive') {
        setBrowseStatus(raw);
      }
    } catch {
      /* noop */
    }
  }, [browseStatusStorageKey]);

  /**
   * Detect whether localStorage is actually writable in this browsing
   * context. Safari Private mode, locked-down enterprise profiles, and
   * "block all cookies/site data" settings all surface as a thrown
   * SecurityError / QuotaExceededError on `setItem` even when the
   * `localStorage` object itself exists. We only need this signal once
   * per mount — drives a small "Saved in this session" badge so the
   * agent isn't surprised when their tenant filter resets after refresh.
   */
  const [localStorageBlocked, setLocalStorageBlocked] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const probeKey = '__welile_ls_probe__';
      window.localStorage.setItem(probeKey, '1');
      window.localStorage.removeItem(probeKey);
      setLocalStorageBlocked(false);
    } catch {
      setLocalStorageBlocked(true);
    }
  }, []);

  /* Cloud sync master switch — declared here (above the cloud effects)
   * because the read + write effects below gate on it. The localStorage
   * mirror + write-back effect for this flag live further down with the
   * rest of the picker-prefs block. Default = enabled on every fresh
   * sign-in. */
  const cloudSyncStorageKey = user?.id
    ? `welile.fieldCollect.cloudSync:${user.id}`
    : null;
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !user?.id) return true;
    try {
      const raw = window.localStorage.getItem(`welile.fieldCollect.cloudSync:${user.id}`);
      return raw !== 'off';
    } catch { return true; }
  });

  /**
   * Cloud sync (cross-device).
   *
   * Storage layering:
   *   1. localStorage   → instant, offline, single-device cache. UI reads from
   *                       it on mount so chips never wait on the network.
   *   2. Cloud row      → durable, multi-device source of truth. Pulled once
   *                       per login and pushed on every change.
   *
   * Conflict policy: cloud wins on initial hydration. Rationale: the user's
   * intent travels with their account, not with whichever browser they last
   * used. If the local value differs from the cloud value, the cloud value
   * is applied AND mirrored back to localStorage so subsequent offline
   * loads on this device match what other devices show.
   *
   * Tracked via a ref (`hasCloudHydratedRef`) so a user toggling the chip
   * before the cloud fetch resolves isn't stomped by a stale fetched value
   * — the late-hydration logic mirrors how `hasHydratedStatusRef` works for
   * localStorage above.
   *
   * Best-effort writes: every change upserts (or deletes when 'all', the
   * default) the row. Network failures swallow into a console.warn —
   * preferences are UX, not data, so a flaky connection must never crash
   * the picker or block the agent from collecting.
   */
  const hasCloudHydratedRef = useRef(false);
  const browseStatusPrefKey = 'fieldCollect.browseStatus';

  useEffect(() => {
    if (hasCloudHydratedRef.current) return;
    if (!user?.id) return;
    if (!cloudSyncEnabled) {
      // Cloud sync turned off → mark as "hydrated" anyway so the write
      // effect below stops blocking on this gate (otherwise local-only
      // chip changes would never trigger their own follow-on logic).
      hasCloudHydratedRef.current = true;
      return;
    }
    hasCloudHydratedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('user_ui_preferences')
          .select('value')
          .eq('user_id', user.id)
          .eq('key', browseStatusPrefKey)
          .maybeSingle();
        if (cancelled || error || !data) return;
        const cloudValue = data.value;
        if (cloudValue === 'all' || cloudValue === 'active' || cloudValue === 'inactive') {
          setBrowseStatus(cloudValue);
          // Mirror back to localStorage so this device matches the
          // cloud value on its next offline cold start.
          if (typeof window !== 'undefined' && browseStatusStorageKey) {
            try {
              if (cloudValue === 'all') {
                window.localStorage.removeItem(browseStatusStorageKey);
              } else {
                window.localStorage.setItem(browseStatusStorageKey, cloudValue);
              }
            } catch {
              /* noop */
            }
          }
        }
      } catch (err) {
        console.warn('[FieldCollectDialog] cloud pref hydrate failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, browseStatusStorageKey, cloudSyncEnabled]);

  /**
   * Push every chip change to the cloud row (best-effort). Skips writes
   * before cloud hydration completes so the initial localStorage value
   * doesn't accidentally overwrite a fresher cloud value on first mount.
   */
  useEffect(() => {
    if (!user?.id) return;
    if (!hasCloudHydratedRef.current) return;
    if (!cloudSyncEnabled) return;
    (async () => {
      try {
        if (browseStatus === 'all') {
          // Default = no row. Cleaner than storing a redundant 'all'.
          await supabase
            .from('user_ui_preferences')
            .delete()
            .eq('user_id', user.id)
            .eq('key', browseStatusPrefKey);
        } else {
          await supabase
            .from('user_ui_preferences')
            .upsert(
              { user_id: user.id, key: browseStatusPrefKey, value: browseStatus },
              { onConflict: 'user_id,key' },
            );
        }
      } catch (err) {
        console.warn('[FieldCollectDialog] cloud pref write failed', err);
      }
    })();
  }, [browseStatus, user?.id, cloudSyncEnabled]);

  /* =====================================================================
   * Picker preferences: "last updated" timestamp + cloud sync toggle +
   * display timezone.
   *
   * All three preferences live in the same per-user `user_ui_preferences`
   * row family used by `browseStatus`, plus a localStorage mirror under
   * `welile.fieldCollect.<key>:<userId>` so the picker is responsive
   * offline and on first paint.
   *
   * Why a single block instead of three separate ones:
   *   The three preferences are conceptually one "picker settings" group
   *   exposed via the same gear popover. Co-locating them keeps the
   *   load/save plumbing readable and prevents drift in the cloud-sync
   *   gating logic (e.g. respecting `cloudSyncEnabled` for the timezone
   *   write too).
   * ===================================================================== */

  /**
   * Timestamp (ms since epoch) of the most recent `browseStatus` write —
   * local OR cloud, whichever is newer. Drives the tooltip copy
   * "Filter saved 3 minutes ago". Null = filter has never been saved
   * (default 'all' state with no prior selection).
   */
  const [browseStatusUpdatedAt, setBrowseStatusUpdatedAt] = useState<number | null>(null);

  /**
   * Per-user, per-device localStorage key for the "last updated"
   * timestamp. Stored separately from the value so legacy clients that
   * only know how to read the raw 'all'/'active'/'inactive' string keep
   * working without a parser bump.
   */
  const browseStatusUpdatedAtStorageKey = user?.id
    ? `welile.fieldCollect.browseStatus.updatedAt:${user.id}`
    : null;

  /* Hydrate the local timestamp once user.id is known. */
  const hasHydratedUpdatedAtRef = useRef(false);
  useEffect(() => {
    if (hasHydratedUpdatedAtRef.current) return;
    if (!browseStatusUpdatedAtStorageKey || typeof window === 'undefined') return;
    hasHydratedUpdatedAtRef.current = true;
    try {
      const raw = window.localStorage.getItem(browseStatusUpdatedAtStorageKey);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) setBrowseStatusUpdatedAt(n);
    } catch { /* noop */ }
  }, [browseStatusUpdatedAtStorageKey]);

  /* Stamp the local timestamp on every chip change AFTER the initial
   * cloud hydrate. We piggy-back on `browseStatus` so the timestamp
   * always reflects a real user-driven change rather than mount-time
   * hydration. */
  useEffect(() => {
    if (!hasCloudHydratedRef.current) return;
    const now = Date.now();
    setBrowseStatusUpdatedAt(now);
    if (browseStatusUpdatedAtStorageKey && typeof window !== 'undefined') {
      try { window.localStorage.setItem(browseStatusUpdatedAtStorageKey, String(now)); }
      catch { /* noop */ }
    }
  }, [browseStatus, browseStatusUpdatedAtStorageKey]);

  /**
   * Persist the cloud-sync master switch.
   *
   * (`cloudSyncEnabled` and `cloudSyncStorageKey` are declared higher up,
   * above the cloud read/write effects that gate on them — see the
   * "Cloud sync master switch" block earlier in this file. We only need
   * the write-back effect here so toggle changes survive reload. The
   * lazy initializer already handles initial hydration.)
   *
   * Default = enabled. We treat absence of the key as the default, so
   * we delete the key when re-enabling rather than write 'on' — keeps
   * localStorage clean for users who never touch the toggle.
   */
  useEffect(() => {
    if (!cloudSyncStorageKey || typeof window === 'undefined') return;
    try {
      if (cloudSyncEnabled) window.localStorage.removeItem(cloudSyncStorageKey);
      else window.localStorage.setItem(cloudSyncStorageKey, 'off');
    } catch { /* noop */ }
  }, [cloudSyncEnabled, cloudSyncStorageKey]);

  /**
   * Display timezone for the "last updated" tooltip.
   *
   * - Default `'auto'` resolves at render time to the browser's
   *   `Intl.DateTimeFormat().resolvedOptions().timeZone`, so untouched
   *   users always see local time without any setup.
   * - Override values are full IANA zone IDs (e.g. `Africa/Kampala`).
   * - Persisted both locally (per-user) and to cloud, mirroring the
   *   `browseStatus` pattern so the preference follows the agent across
   *   devices when cloud sync is enabled.
   */
  const TIMEZONE_OPTIONS: { id: string; label: string }[] = [
    { id: 'auto',                  label: 'Auto (device timezone)' },
    { id: 'Africa/Kampala',        label: 'Kampala — EAT (UTC+3)' },
    { id: 'Africa/Nairobi',        label: 'Nairobi — EAT (UTC+3)' },
    { id: 'Africa/Lagos',          label: 'Lagos — WAT (UTC+1)' },
    { id: 'Africa/Johannesburg',   label: 'Johannesburg — SAST (UTC+2)' },
    { id: 'Europe/London',         label: 'London — GMT/BST' },
    { id: 'America/New_York',      label: 'New York — ET' },
    { id: 'UTC',                   label: 'UTC' },
  ];
  const displayTimezoneStorageKey = user?.id
    ? `welile.fieldCollect.displayTimezone:${user.id}`
    : null;
  const displayTimezonePrefKey = 'fieldCollect.displayTimezone';
  const [displayTimezone, setDisplayTimezone] = useState<string>('auto');
  const hasHydratedTzRef = useRef(false);
  useEffect(() => {
    if (hasHydratedTzRef.current) return;
    if (!displayTimezoneStorageKey || typeof window === 'undefined') return;
    hasHydratedTzRef.current = true;
    try {
      const raw = window.localStorage.getItem(displayTimezoneStorageKey);
      if (raw && (raw === 'auto' || TIMEZONE_OPTIONS.some(o => o.id === raw))) {
        setDisplayTimezone(raw);
      }
    } catch { /* noop */ }
  }, [displayTimezoneStorageKey]);
  useEffect(() => {
    if (!displayTimezoneStorageKey || typeof window === 'undefined') return;
    try {
      if (displayTimezone === 'auto') {
        window.localStorage.removeItem(displayTimezoneStorageKey);
      } else {
        window.localStorage.setItem(displayTimezoneStorageKey, displayTimezone);
      }
    } catch { /* noop */ }
  }, [displayTimezone, displayTimezoneStorageKey]);

  /* Cloud hydrate + push for the timezone preference. Runs once per
   * sign-in like `browseStatus`. Respects the cloud-sync master switch.
   */
  const hasCloudHydratedTzRef = useRef(false);
  useEffect(() => {
    if (hasCloudHydratedTzRef.current) return;
    if (!user?.id) return;
    if (!cloudSyncEnabled) return;
    hasCloudHydratedTzRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('user_ui_preferences')
          .select('value')
          .eq('user_id', user.id)
          .eq('key', displayTimezonePrefKey)
          .maybeSingle();
        if (cancelled || error || !data?.value) return;
        if (data.value === 'auto' || TIMEZONE_OPTIONS.some(o => o.id === data.value)) {
          setDisplayTimezone(data.value as string);
        }
      } catch (err) {
        console.warn('[FieldCollectDialog] cloud tz hydrate failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, cloudSyncEnabled]);
  useEffect(() => {
    if (!user?.id) return;
    if (!hasCloudHydratedTzRef.current) return;
    if (!cloudSyncEnabled) return;
    (async () => {
      try {
        if (displayTimezone === 'auto') {
          await supabase
            .from('user_ui_preferences')
            .delete()
            .eq('user_id', user.id)
            .eq('key', displayTimezonePrefKey);
        } else {
          await supabase
            .from('user_ui_preferences')
            .upsert(
              { user_id: user.id, key: displayTimezonePrefKey, value: displayTimezone },
              { onConflict: 'user_id,key' },
            );
        }
      } catch (err) {
        console.warn('[FieldCollectDialog] cloud tz write failed', err);
      }
    })();
  }, [displayTimezone, user?.id, cloudSyncEnabled]);

  /**
   * Resolve `'auto'` to the browser's actual zone for display purposes.
   * Memoized because `Intl.DateTimeFormat().resolvedOptions()` is a
   * non-trivial allocation we don't want on every keystroke.
   */
  const resolvedDisplayTimezone = useMemo(() => {
    if (displayTimezone !== 'auto') return displayTimezone;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }, [displayTimezone]);

  /* Format an absolute date string in the resolved timezone, e.g.
   * "Apr 25, 2026, 14:32 EAT". `timeZoneName: 'short'` adds the abbr. */
  const formatInTz = useCallback((ts: number): string => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: resolvedDisplayTimezone,
        timeZoneName: 'short',
      }).format(new Date(ts));
    } catch {
      // Fallback to date-fns local formatting if the IANA id is rejected
      // (extremely rare — usually a typo in a future override).
      return formatDate(new Date(ts), 'PP p');
    }
  }, [resolvedDisplayTimezone]);

  const [browsePage, setBrowsePage] = useState(0);

  /**
   * Persisted search query (cross-device).
   *
   * Why we persist this:
   *   The "mode" of the picker (browse vs. search) is derived from whether
   *   the search box has content — empty = browse, non-empty = search. So
   *   persisting the query string ALONE restores both the query and the
   *   mode the agent was last in. No separate `mode` flag needed.
   *
   * Storage layering mirrors `browseStatus` above:
   *   - localStorage (per-agent key) → instant offline cache; populated on
   *     dialog mount before cloud responds so the box never flashes empty.
   *   - `user_ui_preferences` row    → durable cross-device source of truth;
   *     pulled once per login, written on every change (debounced).
   *
   * Empty string is stored as "absence of preference" (key removed locally,
   * row deleted in cloud) to keep storage clean and treat "fresh start" as
   * the natural default.
   */
  const searchQueryStorageKey = user?.id
    ? `welile.fieldCollect.searchQuery:${user.id}`
    : null;
  const searchQueryPrefKey = 'fieldCollect.searchQuery';
  const hasSearchCloudHydratedRef = useRef(false);

  /**
   * Restore the saved query whenever the dialog opens. Pulled from
   * localStorage synchronously inside the effect (not via lazy state
   * initializer) because `search` already drives a debounced scoring
   * pipeline and toggling it via `setSearch` correctly retriggers the
   * dependent memos. Skips when there's already a query in flight (so a
   * fast re-open after typing doesn't snap back to the previous saved
   * value).
   */
  useEffect(() => {
    if (!open) return;
    if (!searchQueryStorageKey || typeof window === 'undefined') return;
    if (search) return; // user already started typing in this session
    try {
      const raw = window.localStorage.getItem(searchQueryStorageKey);
      if (raw) setSearch(raw);
    } catch {
      /* private mode / quota — ignore */
    }
    // Intentionally only react to `open` flipping true; `search` is excluded
    // so the restore doesn't fight with user typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchQueryStorageKey]);

  /**
   * Persist the query to localStorage on every change. Debounced via the
   * existing `debouncedSearch` mirror so we don't thrash storage on every
   * keystroke. Empty query removes the key (see header comment).
   */
  useEffect(() => {
    if (!searchQueryStorageKey || typeof window === 'undefined') return;
    try {
      if (!debouncedSearch) {
        window.localStorage.removeItem(searchQueryStorageKey);
      } else {
        window.localStorage.setItem(searchQueryStorageKey, debouncedSearch);
      }
    } catch {
      /* noop */
    }
  }, [debouncedSearch, searchQueryStorageKey]);

  /**
   * Cloud hydrate (once per login). Cloud value wins over local on first
   * read and is mirrored back to localStorage so this device matches what
   * the agent's other devices show on the next cold open.
   */
  useEffect(() => {
    if (hasSearchCloudHydratedRef.current) return;
    if (!user?.id) return;
    hasSearchCloudHydratedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('user_ui_preferences')
          .select('value')
          .eq('user_id', user.id)
          .eq('key', searchQueryPrefKey)
          .maybeSingle();
        if (cancelled || error || !data) return;
        const cloudValue = typeof data.value === 'string' ? data.value : '';
        if (!cloudValue) return;
        // Only adopt cloud value if the user hasn't already typed in this
        // session — preserves typing intent on slow networks.
        setSearch(prev => (prev ? prev : cloudValue));
        if (typeof window !== 'undefined' && searchQueryStorageKey) {
          try { window.localStorage.setItem(searchQueryStorageKey, cloudValue); } catch { /* noop */ }
        }
      } catch (err) {
        console.warn('[FieldCollectDialog] cloud search hydrate failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, searchQueryStorageKey]);

  /**
   * Push debounced query changes to the cloud row. Skips writes before
   * cloud hydration completes so the local cache value doesn't overwrite a
   * fresher cloud value on first mount (same guard as `browseStatus`).
   */
  useEffect(() => {
    if (!user?.id) return;
    if (!hasSearchCloudHydratedRef.current) return;
    (async () => {
      try {
        if (!debouncedSearch) {
          await supabase
            .from('user_ui_preferences')
            .delete()
            .eq('user_id', user.id)
            .eq('key', searchQueryPrefKey);
        } else {
          await supabase
            .from('user_ui_preferences')
            .upsert(
              { user_id: user.id, key: searchQueryPrefKey, value: debouncedSearch },
              { onConflict: 'user_id,key' },
            );
        }
      } catch (err) {
        console.warn('[FieldCollectDialog] cloud search write failed', err);
      }
    })();
  }, [debouncedSearch, user?.id]);

  /* Online/offline tracking */
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  /* Load + refresh tenant cache when opened */
  const refreshTenantCache = useCallback(async () => {
    if (!user?.id) return;

    // ── 1) CACHE-FIRST: paint instantly from IndexedDB so the agent sees
    //    their assigned caseload with zero network wait — works fully
    //    offline. Only show the spinner if we genuinely have nothing
    //    to render yet (first-ever open on this device).
    let hadCache = false;
    try {
      const cached = await getCachedTenants(user.id);
      if (cached.length > 0) {
        setTenants(cached);
        hadCache = true;
      }
    } catch (e) {
      console.warn('[FieldCollectDialog] cache read failed', e);
    }
    if (!hadCache) setTenantsLoading(true);

    // ── 2) BACKGROUND REFRESH: only when online. Failures are non-fatal —
    //    cached data stays on screen.
    if (!navigator.onLine) {
      setTenantsLoading(false);
      return;
    }

    try {
      const { data: referredData } = await supabase
        .from('profiles')
        .select('id, full_name, phone, monthly_rent')
        .eq('referrer_id', user.id);

      const referredIds = new Set((referredData || []).map(t => t.id));

      const [{ data: referralRows }, { data: agentRequests }] = await Promise.all([
        supabase.from('referrals').select('referred_id').eq('referrer_id', user.id),
        supabase.from('rent_requests').select('tenant_id').eq('agent_id', user.id),
      ]);

      const extraIds = [
        ...(referralRows || []).map(r => r.referred_id),
        ...(agentRequests || []).map(r => r.tenant_id),
      ].filter(id => id && !referredIds.has(id));

      let extras: any[] = [];
      if (extraIds.length) {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, phone, monthly_rent')
          .in('id', [...new Set(extraIds)]);
        extras = data || [];
      }

      const all = [...(referredData || []), ...extras].map((t: any) => ({
        tenantId: t.id as string,
        fullName: (t.full_name as string) || 'Unnamed Tenant',
        phone: (t.phone as string) || null,
        monthlyRent: t.monthly_rent ?? null,
      }));

      await cacheTenants(user.id, all);
      const fresh = await getCachedTenants(user.id);
      setTenants(fresh);
    } catch (e) {
      console.warn('[FieldCollectDialog] tenant refresh failed, keeping cache', e);
    } finally {
      setTenantsLoading(false);
    }
  }, [user?.id]);

  // Never throws: a failed re-read after a successful addEntry must not turn
  // into a "Failed to save" toast, or the agent re-enters a saved collection.
  const refreshEntries = useCallback(async () => {
    if (!user?.id) return;
    try {
      setEntries(await getEntries(user.id));
    } catch (e) {
      console.warn('refreshEntries failed', e);
    }
  }, [user?.id]);

  /**
   * Persisted "frequent / recent" pick log, hydrated from IndexedDB whenever
   * the dialog opens. Drives the new "Recent" rail above the virtualized
   * results so frequently picked tenants survive reloads — even ones the
   * agent never saved a collection for.
   *
   * Each `pickTenant` call also nudges this state optimistically (see the
   * `pickTenant` callback below), so the rail re-orders instantly without
   * waiting for the IDB read on the next open.
   */
  const [persistedPicks, setPersistedPicks] = useState<TenantPickRecord[]>([]);
  const refreshPersistedPicks = useCallback(async () => {
    if (!user?.id) return;
    setPersistedPicks(await getRecentPicks(user.id));
  }, [user?.id]);

  useEffect(() => {
    if (open) {
      refreshTenantCache();
      refreshEntries();
      refreshPersistedPicks();
    }
  }, [open, refreshTenantCache, refreshEntries, refreshPersistedPicks]);

  /* Filter tenants */
  /**
   * Quick search suggestions:
   *  - Empty query → first 8 tenants alphabetically as a passive list
   *  - With query  → score by phone-match > name-prefix > word-prefix > substring
   *    so the most likely tap candidate sits at the top.
   */
  /**
   * Pre-normalized index over the tenant cache. Computed once per tenant-list
   * change so each keystroke does O(N) string comparisons against already-
   * normalized values instead of re-running normalizeName/normalizePhone for
   * every tenant on every render. Significant speed-up for agents with
   * hundreds/thousands of cached tenants.
   *
   * The index is also persisted to IndexedDB keyed by a fingerprint of the
   * tenant list so the heavy O(N) normalization work survives reloads. On
   * cold start we attempt to hydrate from the persisted cache; we only
   * recompute (and re-persist) when the fingerprint changes.
   */
  const fingerprint = useMemo(() => tenantListFingerprint(tenants), [tenants]);
  // Per-tenantId normalized lookup. Hydrated from IndexedDB or recomputed.
  const [normalizedById, setNormalizedById] = useState<Map<string, NormalizedTenantEntry>>(new Map());

  useEffect(() => {
    if (!user?.id) return;
    if (!tenants.length) {
      setNormalizedById(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      // 1. Try to hydrate from the persisted cache.
      const cached = await getCachedNormalizedIndex(user.id, fingerprint);
      if (cancelled) return;
      if (cached && cached.length === tenants.length) {
        setNormalizedById(new Map(cached.map(e => [e.tenantId, e])));
        return;
      }
      // 2. Cache miss → recompute and persist for next reload.
      const entries: NormalizedTenantEntry[] = tenants.map(t => {
        const name = normalizeName(t.fullName);
        return {
          tenantId: t.tenantId,
          name,
          phone: normalizePhone(t.phone),
          nameWords: name.split(' ').filter(Boolean),
        };
      });
      if (cancelled) return;
      setNormalizedById(new Map(entries.map(e => [e.tenantId, e])));
      // Fire-and-forget persistence — don't block the UI on IndexedDB.
      void saveCachedNormalizedIndex(user.id, fingerprint, entries);
    })();
    return () => { cancelled = true; };
  }, [user?.id, fingerprint, tenants]);

  /**
   * Adapter that exposes the normalized index in the shape the existing
   * filter/scoring code consumes — `{ t, name, phone, nameWords }` per tenant.
   * Falls back to on-the-fly normalization for any tenant that hasn't been
   * indexed yet (e.g. mid-hydration), so search never returns empty results
   * just because the cache hasn't loaded.
   */
  const tenantIndex = useMemo(
    () => tenants.map(t => {
      const cached = normalizedById.get(t.tenantId);
      if (cached) return { t, name: cached.name, phone: cached.phone, nameWords: cached.nameWords };
      const name = normalizeName(t.fullName);
      return {
        t,
        name,
        phone: normalizePhone(t.phone),
        nameWords: name.split(' ').filter(Boolean),
      };
    }),
    [tenants, normalizedById],
  );

  const filtered = useMemo(() => {
    // Score against the *debounced* search value, not the live `search`,
    // so a typing burst coalesces into one O(N) scoring pass. The input
    // box still updates on every keystroke for instant visual feedback —
    // this memo just lags by ~120ms before re-running.
    const raw = debouncedSearch.trim();
    const q = normalizeName(raw);

    // -------------------- Per-query result cache --------------------
    // Reuse scored results when the agent retypes/backspaces the same query
    // and the underlying tenant list hasn't changed. Cache lives at module
    // scope (see top of file) so it persists across dialog open/close cycles
    // — coming back to Field Collect a minute later still hits warm entries.
    // `getSearchCache` keys by agent + fingerprint, so a tenant list change
    // (new tenants synced) wipes that agent's bucket atomically.
    const cacheBucket = getSearchCache(user?.id ?? '__anon__', fingerprint);
    // Normalize the query so equivalent inputs share a cache slot:
    //   • trim + lowercase  → "Alice", "alice ", "ALICE" collapse together
    //   • collapse internal runs of whitespace → "alice   smith" === "alice smith"
    // Scoring already runs against `q` (normalizeName output), which strips
    // diacritics/punctuation, so any two raw inputs that produce the same `q`
    // are guaranteed to produce identical results — they're safe to share a
    // cache entry. The empty query has its own dedicated bucket too so opening
    // the picker repeatedly doesn't re-slice the tenant book.
    //
    // Browse-mode (empty query) varies by sort + page, so we widen the key to
    // include those — flipping pages or switching sort keeps each variant
    // memoized so back/forward feels instant.
    //
    // Note: we deliberately key on the *normalized* query (`q`) rather than
    // raw input. `q` is the exact value the scorer sees, so it's the tightest
    // valid cache key — anything finer would create cache misses for inputs
    // that produce identical scoring work.
    const cacheKey = q
      ? `q:${q}`
      : `__browse__:${browseSort}:${browseStatus}:${browsePage}`;
    const cached = cacheBucket.get(cacheKey);
    if (cached) {
      // LRU touch: re-insert moves this key to the most-recent position so it
      // survives eviction when the cache fills up.
      cacheBucket.delete(cacheKey);
      cacheBucket.set(cacheKey, cached);
      return cached;
    }
    /** Store, evict the oldest entry when over capacity, and return. */
    const storeAndReturn = (rows: FilteredRow[]): FilteredRow[] => {
      cacheBucket.set(cacheKey, rows);
      if (cacheBucket.size > SEARCH_CACHE_MAX) {
        const oldest = cacheBucket.keys().next().value;
        if (oldest !== undefined) cacheBucket.delete(oldest);
      }
      return rows;
    };

    // No query → BROWSE MODE.
    //
    // The agent isn't searching — they just want to flip through their
    // caseload to find the right tenant by sight. We honour the active
    // sort (`recent` = last activity desc, `name` = A→Z) and slice out a
    // single page so the virtualized list never has to render more than
    // BROWSE_PAGE_SIZE rows even if the agent has tens of thousands of
    // cached tenants. The pager (Prev / Next) lives in the UI below.
    //
    // Cache-friendliness: the cache key already contains the sort+page
    // because it's part of `cacheKey` (we widen it below). So flipping
    // pages is O(1) on the second visit.
    if (!q) {
      // Build a "last activity" lookup once per (entries, tenants) change.
      // Tenants without any captured entry get -Infinity so they sink to
      // the bottom under the 'recent' sort.
      const lastByTenant = new Map<string, number>();
      for (const e of entries) {
        if (!e.tenantId) continue;
        const prev = lastByTenant.get(e.tenantId) ?? 0;
        if (e.capturedAt > prev) lastByTenant.set(e.tenantId, e.capturedAt);
      }
      // Apply the status filter BEFORE sorting so the page-count and the
      // "Page X of Y" pager reflect the narrowed set, not the full caseload.
      // A tenant counts as "active" when they have any captured entry —
      // that's the same signal the Recent sort and "Recent tenants" chip
      // row already use, so the toggle stays semantically consistent.
      const filteredByStatus = browseStatus === 'all'
        ? tenants
        : browseStatus === 'active'
          ? tenants.filter(t => lastByTenant.has(t.tenantId))
          : tenants.filter(t => !lastByTenant.has(t.tenantId));
      const sorted = [...filteredByStatus].sort((a, b) => {
        if (browseSort === 'name') {
          return a.fullName.localeCompare(b.fullName, undefined, { sensitivity: 'base' });
        }
        // recent: last activity desc, then cachedAt desc as a tiebreaker so
        // brand-new tenants still bubble up before stale untouched ones.
        const la = lastByTenant.get(a.tenantId) ?? -Infinity;
        const lb = lastByTenant.get(b.tenantId) ?? -Infinity;
        if (lb !== la) return lb - la;
        return (b.cachedAt ?? 0) - (a.cachedAt ?? 0);
      });
      const start = browsePage * BROWSE_PAGE_SIZE;
      const page = sorted.slice(start, start + BROWSE_PAGE_SIZE);
      return storeAndReturn(page.map(t => ({
        t,
        score: 0,
        matchType: null as 'phone' | 'name' | 'both' | null,
        ambiguous: false,
        bestMatchFallback: false,
      })));
    }
    const phoneQ = normalizePhone(raw);
    // Treat the query as "phone-y" if the user typed mostly digits — even
    // with spaces, dashes, plus signs or a leading 0/256.
    const isPhoneQuery = phoneQ.length >= 3 && /\d/.test(raw) && raw.replace(/[\s\-+()]/g, '').replace(/\D+/g, '').length >= raw.replace(/[\s\-+()]/g, '').length - 1;
    // Pre-compute fuzzy phone variants once per query (not once per tenant).
    // These are the relaxed forms tried when strict matching fails — see
    // the "Best match" fallback chip in the suggestion list.
    const fuzzyVariants = /\d/.test(raw)
      ? phoneVariants(raw).filter(v => v.length >= 4)
      : [];
    // Per-query fuzzy resolver — memoized at module scope keyed by `raw`,
    // and itself memoizes `(phone → best hit)` internally. So when the
    // agent retypes a messy phone and the cache has been invalidated by a
    // tenant list refresh, we still skip the inner triple-condition loop
    // for any phone we've already tested under this query.
    const resolveFuzzyPhone = fuzzyVariants.length ? getFuzzyPhoneResolver(raw) : null;
    /**
     * Short phone queries (3–4 digits) are inherently ambiguous: the agent is
     * usually recalling only the tail of the number ("…456"). To avoid the
     * dangerous case where the search lands on the *wrong* tenant by chance,
     * we restrict short phone-y queries to **last-N-digits** matches and
     * require at least 2 candidates before showing them. If only one tenant
     * matches, we suppress the result so the agent is forced to type more
     * digits or switch to name search — preventing an accidental mis-pick.
     */
    const isShortPhoneQuery = isPhoneQuery && phoneQ.length >= 3 && phoneQ.length <= 4;
    /**
     * For short (3–4 digit) phone queries we run a tail-N matcher with
     * uniqueness-aware ranking. Pre-compute, ONCE per query:
     *   - the set of candidate phones whose tail matches (drives `sharedCount`)
     *   - a Map<phone, sharedCount> so the per-tenant scorer below can pick a
     *     `phoneScore` that boosts tenants whose tail is more unique within
     *     the result set.
     *
     * Why this matters: with the old scoring, every tenant ending in "456"
     * tied at score 110 and the visible order was effectively random. Now a
     * tenant whose tail is shared by 1 other ranks above one shared by 8.
     */
    const tailCounts: Map<string, number> = isShortPhoneQuery
      ? tailSharedCounts(
          tenantIndex.map(x => x.phone).filter((p): p is string => !!p),
          phoneQ,
        )
      : new Map();
    const scored = tenantIndex
      .map(({ t, name, phone, nameWords }) => {
        let score = 0;
        let phoneScore = 0;
        let nameScore = 0;
        let bestMatchFallback = false;
        // Phone matches always outrank name matches when the query is phone-y.
        if (isShortPhoneQuery && phone) {
          // Short query → use the explicit tail-N matcher. The matcher picks
          // tail length = query length (3 → tail-3, 4 → tail-4) and reports
          // whether the tail aligns to a phone "block boundary" the agent
          // typically dictates. Ranking nudges:
          //   base       = 110          (any tail hit)
          //   boundary   = +5           (block-aligned tail)
          //   uniqueness = +0..10       (10 / sharedCount, capped at 10)
          // The uniqueness term means a tail shared by 1 tenant adds +10,
          // by 2 adds +5, by 5 adds +2 — pushing rare tails to the top.
          const tm = tailMatch(phone, phoneQ);
          if (tm) {
            const shared = tailCounts.get(phone) ?? 1;
            const uniqueness = Math.min(10, Math.round(10 / Math.max(shared, 1)));
            phoneScore = 110 + (tm.boundary ? 5 : 0) + uniqueness;
          }
        } else if (isPhoneQuery && phone && phone.includes(phoneQ)) {
          if (phone === phoneQ) phoneScore = 200;          // exact full match — pin to top
          else if (phone.startsWith(phoneQ)) phoneScore = 150; // prefix match
          else if (phone.endsWith(phoneQ)) phoneScore = 130; // tail match (e.g. last 4-7)
          else phoneScore = 110;                            // substring match
        } else if (phoneQ && phone && phone.includes(phoneQ)) {
          // Mixed query (digits + letters) — phone still helps but doesn't dominate.
          phoneScore = phone.startsWith(phoneQ) ? 100 : 70;
        }
        // Fuzzy fallback: messy phone input that strict normalization didn't
        // match. Delegated to a memoized resolver so repeated (query,phone)
        // lookups across rescores collapse to a single Map.get. Tag the row
        // so the UI can show a "Best match" chip.
        if (phoneScore === 0 && phone && resolveFuzzyPhone) {
          const hit = resolveFuzzyPhone(phone);
          if (hit) {
            phoneScore = hit.score;
            bestMatchFallback = true;
          }
        }
        // Name scoring runs in addition so a tenant matching both ranks higher.
        if (name.startsWith(q)) {
          nameScore = 90;
        } else if (nameWords.some(w => w.startsWith(q))) {
          nameScore = 80;
        } else if (name.includes(q)) {
          nameScore = 50;
        }
        score = Math.max(phoneScore, nameScore);
        // Match type is whichever scoring lane won; ties (both > 0 with same score)
        // are labeled 'both' so the agent sees the full picture on the top result.
        let matchType: 'phone' | 'name' | 'both' | null = null;
        if (phoneScore > 0 && nameScore > 0 && phoneScore === nameScore) matchType = 'both';
        else if (phoneScore > nameScore) matchType = 'phone';
        else if (nameScore > 0) matchType = 'name';
        return { t, score, matchType, bestMatchFallback };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200);

    // Safety net for short digit queries: only surface phone-only matches
    // when there are ≥2 candidates. If a short query produces a single phone
    // hit (with no name overlap), suppress it and show nothing — the empty
    // state will tell the agent to type more digits.
    if (isShortPhoneQuery) {
      const phoneOnly = scored.filter(s => s.matchType === 'phone');
      const nameAny = scored.filter(s => s.matchType === 'name' || s.matchType === 'both');
      if (phoneOnly.length === 1 && nameAny.length === 0) {
        return storeAndReturn([]);
      }
    }

    // Tag every row in the result set as ambiguous when the query is a short
    // digit query and there are multiple candidates — drives the UI hint.
    const ambiguous = isShortPhoneQuery && scored.length > 1;
    return storeAndReturn(scored.map(s => ({ ...s, ambiguous })));
  }, [tenantIndex, tenants, debouncedSearch, fingerprint, entries, browseSort, browseStatus, browsePage, user?.id]);

  /**
   * Tail-share hint metadata.
   *
   * When the agent has typed a short 3–4 digit phone query (the "I only
   * remember the last few digits" path), surface how many tenants in their
   * caseload share that exact tail. This is the same number that drives the
   * uniqueness ranking inside the scorer — exposing it directly tells the
   * agent at a glance whether they need to type more digits to disambiguate.
   *
   * Returns null when the query isn't a short phone-y query, so the UI can
   * cheaply skip rendering. Computed independently of `filtered` so it
   * stays correct even when the per-query result cache short-circuits.
   *
   * Two count modes are exposed via `tailHintMode`:
   *  - 'tenants': raw count of tenants whose phone ends in the typed digits
   *               (1:1 with the result list — matches what the query returns).
   *  - 'buckets': distinct (tailLen+1)-digit groups — i.e. how many different
   *               "next-digit-out" prefixes share this tail. Tells the agent
   *               "if I type one more digit, this is how many groups it
   *               could collapse to." Phones with no extra digit (the typed
   *               tail IS the full normalized phone) collapse into a single
   *               '∅' bucket so they don't get double-counted.
   */
  type TailHintMode = 'tenants' | 'buckets';
  const [tailHintMode, setTailHintMode] = useState<TailHintMode>('tenants');
  const tailShareHint = useMemo<{
    tenantCount: number;
    bucketCount: number;
    tailLen: number;
    digits: string;
  } | null>(() => {
    const raw = debouncedSearch.trim();
    if (!raw) return null;
    const phoneQ = normalizePhone(raw);
    if (phoneQ.length < 3 || phoneQ.length > 4) return null;
    // Mirror the dialog's `isPhoneQuery` heuristic: mostly digits, allowing
    // common phone separators. Avoids triggering on all-letter inputs that
    // happen to normalize to a few digits.
    const stripped = raw.replace(/[\s\-+()]/g, '');
    const digitsOnly = stripped.replace(/\D+/g, '');
    if (digitsOnly.length < stripped.length - 1) return null;
    let tenantCount = 0;
    // Bucket key: the (tailLen+1)-digit suffix of the phone. Phones whose
    // full normalized form is exactly the query digits go into the special
    // '∅' bucket (no "next digit out" exists). Single-pass O(N), no
    // sort/array allocation in the hot loop.
    const buckets = new Set<string>();
    const wider = phoneQ.length + 1;
    for (const x of tenantIndex) {
      const p = x.phone;
      if (!p || !p.endsWith(phoneQ)) continue;
      tenantCount++;
      buckets.add(p.length >= wider ? p.slice(-wider) : '∅');
    }
    return {
      tenantCount,
      bucketCount: buckets.size,
      tailLen: phoneQ.length,
      digits: phoneQ,
    };
  }, [debouncedSearch, tenantIndex]);

  /**
   * Browse-mode active set size + pager metadata. The status filter
   * (All / Active / Inactive) narrows the universe, so the page count and
   * the count chip in the toolbar must reflect the FILTERED size — not
   * the full caseload. Recomputes only when the filter, tenant list, or
   * captured-entry set changes; it's an O(N) scan with no allocations.
   */
  const browseFilteredCount = useMemo(() => {
    if (browseStatus === 'all') return tenants.length;
    const activeIds = new Set<string>();
    for (const e of entries) if (e.tenantId) activeIds.add(e.tenantId);
    return browseStatus === 'active'
      ? tenants.reduce((n, t) => n + (activeIds.has(t.tenantId) ? 1 : 0), 0)
      : tenants.reduce((n, t) => n + (activeIds.has(t.tenantId) ? 0 : 1), 0);
  }, [tenants, entries, browseStatus]);
  const browsePageCount = useMemo(
    () => Math.max(1, Math.ceil(browseFilteredCount / BROWSE_PAGE_SIZE)),
    [browseFilteredCount],
  );

  /* Clamp the page if the tenant list shrinks under us. */
  useEffect(() => {
    if (browsePage >= browsePageCount) setBrowsePage(0);
  }, [browsePage, browsePageCount]);

  /* Reset to page 0 whenever the sort changes or the agent starts typing
   * — staying on page 7 of "Name A→Z" then flipping to "Recent" should not
   * dump the agent in the middle of the new ordering. */
  useEffect(() => {
    setBrowsePage(0);
  }, [browseSort]);
  /* Same idea for the status toggle: flipping All → Active should land
   * on page 1 of the narrowed list, not page 7 of the old one. */
  useEffect(() => {
    setBrowsePage(0);
  }, [browseStatus]);
  useEffect(() => {
    if (search) setBrowsePage(0);
  }, [search]);

  /** Just the tenant rows — used by keyboard nav & recents merge. */
  const filteredTenants = useMemo<CachedTenant[]>(
    () => filtered.map(s => s.t),
    [filtered],
  );

  /**
   * Recent tenants — derived from this agent's prior captured entries
   * (queued or synced). Distinct tenants by id, most-recent first, max 5.
   * Only shown when the search box is empty and no tenant is picked.
   */
  const recentTenants = useMemo(() => {
    if (!entries.length || !tenants.length) return [];
    const tenantById = new Map(tenants.map(t => [t.tenantId, t]));
    const seen = new Set<string>();
    const out: CachedTenant[] = [];
    const sorted = [...entries].sort((a, b) => b.capturedAt - a.capturedAt);
    for (const e of sorted) {
      if (!e.tenantId || seen.has(e.tenantId)) continue;
      const t = tenantById.get(e.tenantId);
      if (!t) continue;
      seen.add(e.tenantId);
      out.push(t);
      if (out.length >= 5) break;
    }
    return out;
  }, [entries, tenants]);

  /**
   * Persistent "Recent / Frequent" tenants — sourced from the IndexedDB
   * pick log (`persistedPicks`), merged with the entry-derived recents so
   * a tenant the agent saved a collection for AND tapped multiple times
   * counts on both signals.
   *
   * Ranking: combined score of `pickCount` (heavier — habitual taps) +
   * a recency decay (`lastPickedAt` within 14 days adds a small boost).
   * Capped at 8 so the rail stays glanceable on a phone.
   *
   * Survives reloads because `persistedPicks` is hydrated from IndexedDB
   * on every open. Hidden while the agent is searching so it doesn't
   * compete with the scored suggestions.
   */
  const persistentRecentTenants = useMemo<CachedTenant[]>(() => {
    if (!tenants.length) return [];
    const tenantById = new Map(tenants.map(t => [t.tenantId, t]));
    // Aggregate signal-per-tenant: prefer the IDB pick log; fall back to a
    // synthetic "1 pick at capturedAt" for entry-derived recents that the
    // pick log hasn't seen yet (covers older agents installed before the
    // pick log shipped).
    const score = new Map<string, { count: number; last: number }>();
    for (const p of persistedPicks) {
      score.set(p.tenantId, { count: p.pickCount, last: p.lastPickedAt });
    }
    for (const e of entries) {
      if (!e.tenantId) continue;
      const cur = score.get(e.tenantId);
      if (!cur) score.set(e.tenantId, { count: 1, last: e.capturedAt });
      else if (e.capturedAt > cur.last) cur.last = e.capturedAt;
    }
    const now = Date.now();
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
    const ranked = [...score.entries()]
      .map(([tenantId, s]) => {
        const t = tenantById.get(tenantId);
        if (!t) return null;
        // Frequency dominates, recency is a small tiebreaker (≤ +5).
        const recencyBoost = Math.max(0, 5 - (now - s.last) / TWO_WEEKS * 5);
        return { t, rank: s.count * 10 + recencyBoost };
      })
      .filter((x): x is { t: CachedTenant; rank: number } => x !== null)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8)
      .map(x => x.t);
    return ranked;
  }, [persistedPicks, entries, tenants]);

  /**
   * Combined keyboard-navigable option list for Step 1.
   * Recents come first (prepended) so the most likely tap is at index 0
   * before the agent starts typing. Once they type, recents drop away and
   * only the scored suggestions remain.
   */
  const keyboardOptions = useMemo<CachedTenant[]>(() => {
    if (search.trim()) return filteredTenants;
    // Avoid duplicates between recents and the alphabetical default list.
    const recentIds = new Set(recentTenants.map(t => t.tenantId));
    return [...recentTenants, ...filteredTenants.filter(t => !recentIds.has(t.tenantId))];
  }, [search, filteredTenants, recentTenants]);

  /* Reset highlight whenever the option list shape changes */
  useEffect(() => {
    setActiveIdx(0);
  }, [keyboardOptions.length, search]);

  /**
   * Virtualized renderer for the suggestion list. Handles thousands of
   * tenants without dropping frames by mounting only the rows currently
   * inside the scroll viewport (plus a small overscan for smoothness).
   *
   * The estimated row height matches the `min-h-[60px]` row class. Real
   * height can grow when match chips wrap to a second line — `measureElement`
   * is wired up below so the virtualizer corrects itself after layout.
   */
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 60,
    overscan: 6,
    getItemKey: idx => filtered[idx]?.t.tenantId ?? idx,
  });

  /* Keep the highlighted option scrolled into view (works with virtualization). */
  useEffect(() => {
    if (activeIdx < 0) return;
    // Prefer the virtualizer's API when the active option lives in the
    // suggestion list (filtered). For "recent" rows (rendered above the
    // virtualized list) fall back to scrolling the DOM element directly.
    const opt = keyboardOptions[activeIdx];
    if (!opt) return;
    const filteredIdx = filtered.findIndex(s => s.t.tenantId === opt.tenantId);
    if (filteredIdx >= 0 && listScrollRef.current) {
      rowVirtualizer.scrollToIndex(filteredIdx, { align: 'auto' });
      return;
    }
    const el = optionRefs.current[activeIdx];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, filtered, keyboardOptions, rowVirtualizer]);

  /**
   * Last captured entry for the picked tenant — drives the small preview panel
   * (date, amount, notes) so the agent can avoid double-recording. Matches by
   * tenantId first, falling back to a name match (case-insensitive) so walk-up
   * conversions still resolve. Excludes any in-flight save by ignoring entries
   * captured in the last 1.5s.
   */
  const lastEntryForPicked = useMemo<FieldEntry | null>(() => {
    if (!picked) return null;
    const cutoff = Date.now() - 1500;
    const nameKey = picked.fullName.trim().toLowerCase();
    const matches = entries.filter(e => {
      if (e.capturedAt > cutoff) return false;
      if (picked.tenantId && e.tenantId === picked.tenantId) return true;
      if (!e.tenantId && (e.tenantName || '').trim().toLowerCase() === nameKey) return true;
      return false;
    });
    if (matches.length === 0) return null;
    return matches.reduce((latest, e) => (e.capturedAt > latest.capturedAt ? e : latest), matches[0]);
  }, [picked, entries]);

  const queuedCount = entries.filter(e => e.syncState !== 'synced').length;
  void queuedCount;

  const resetForm = () => {
    setPicked(null);
    setWalkupName('');
    setWalkupPhone('');
    setAmount('');
    setNotes('');
    // NOTE: intentionally NOT clearing `search` here.
    // `resetForm` runs on dialog close (and after a successful save), and the
    // search query is now a persisted preference — wiping it on close would
    // defeat the cross-device restore. Explicit clear paths (the X button,
    // Escape key, picking a tenant) still call `setSearch('')` directly.
    setPurpose('rent');
    setStep(1);
  };

  /** Single entry point used by mouse, touch, and keyboard selection. */
  const pickTenant = useCallback((t: CachedTenant) => {
    setPicked(t);
    setSearch(t.fullName);
    // Persist this pick so the "Recent" rail surfaces it across reloads.
    // Fire-and-forget — the IDB write must not block the UI.
    if (user?.id && t.tenantId) {
      void bumpTenantPick(user.id, t.tenantId);
      // Optimistically nudge the in-memory pick log so the rail re-orders
      // immediately. The async IDB read (on next open) will reconcile.
      setPersistedPicks(prev => {
        const now = Date.now();
        const existing = prev.find(p => p.tenantId === t.tenantId);
        const next = existing
          ? prev.map(p => p.tenantId === t.tenantId
              ? { ...p, pickCount: p.pickCount + 1, lastPickedAt: now }
              : p)
          : [...prev, { agentId: user.id!, tenantId: t.tenantId, pickCount: 1, lastPickedAt: now }];
        return next;
      });
    }
  }, [user?.id]);

  /**
   * Search-input keyboard handler: ArrowDown/Up cycle through the merged
   * recent + suggestion list, Enter picks the highlight, Escape clears.
   */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!keyboardOptions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => (i + 1) % keyboardOptions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (i - 1 + keyboardOptions.length) % keyboardOptions.length);
    } else if (e.key === 'Enter') {
      const opt = keyboardOptions[activeIdx];
      if (opt) {
        e.preventDefault();
        pickTenant(opt);
      }
    } else if (e.key === 'Escape' && search) {
      e.preventDefault();
      setSearch('');
      setActiveIdx(0);
    }
  };

  /**
   * Section-level type-to-search (typeahead).
   * If the agent presses a printable single character while focus is NOT in
   * an editable field (e.g. they tabbed to a "Recent" chip, or just opened
   * the dialog and the autoFocus moved elsewhere), we:
   *   1) Focus the tenant search input.
   *   2) Append (or start) the query with that character.
   *   3) The existing `setActiveIdx(0)` effect snaps the highlight to the
   *      first match — no extra wiring needed.
   * Modifier keys (Ctrl/Cmd/Alt) are ignored so shortcuts still work, and we
   * deliberately let the input's own onKeyDown handle keys when it's already
   * focused (so we don't double-insert).
   */
  const handleStep1TypeAhead = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Only single printable characters (letters, digits, common symbols).
    // Excludes 'Enter', 'ArrowDown', 'Tab', 'Escape', etc. which all have
    // multi-char key names.
    if (e.key.length !== 1) return;
    const target = e.target as HTMLElement | null;
    // Don't hijack typing inside the search input itself or any editable area.
    if (target && (
      target === searchInputRef.current ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      (target as HTMLElement).isContentEditable
    )) {
      return;
    }
    e.preventDefault();
    const ch = e.key;
    setSearch(prev => prev + ch);
    setPicked(null);
    // Defer focus until after React applies the value so caret lands at end.
    requestAnimationFrame(() => {
      const el = searchInputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch { /* ignore */ }
      }
    });
  };

  const handleSave = async () => {
    if (!user?.id) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a valid amount');
      setStep(2);
      return;
    }
    const tName = picked?.fullName || walkupName.trim();
    const tPhone = picked?.phone || (walkupPhone.trim() || null);
    if (!tName) {
      toast.error('Pick a tenant or enter a name');
      setStep(1);
      return;
    }

    setSaving(true);
    try {
      const purposeLabel = PURPOSES.find(p => p.id === purpose)?.label ?? 'Rent';
      const composedNote = notes.trim()
        ? `${purposeLabel} · ${notes.trim()}`
        : purposeLabel;
      const entry: FieldEntry = {
        id: newClientUuid(),
        agentId: user.id,
        tenantId: picked?.tenantId ?? null,
        tenantName: tName,
        tenantPhone: tPhone,
        amount: amt,
        notes: composedNote,
        capturedAt: Date.now(),
        syncState: 'queued',
      };
      await addEntry(entry);
      await refreshEntries();
      resetForm();
      toast.success(`Saved offline · ${formatUGX(amt)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteEntry(id);
      await refreshEntries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete entry');
    }
  };

  const handleSync = async () => {
    if (!user?.id) return;
    if (!navigator.onLine) {
      toast.error('No internet. Will sync when back online.');
      return;
    }
    setSyncing(true);
    let ok = 0, fail = 0, dup = 0;
    try {
      const queue = await getQueuedEntries(user.id);
      for (const e of queue) {
        try {
          const { data, error } = await (supabase.from('field_collections') as any)
            .insert({
              client_uuid: e.id,
              agent_id: user.id,
              tenant_id: e.tenantId,
              tenant_name: e.tenantName,
              tenant_phone: e.tenantPhone,
              amount: e.amount,
              notes: e.notes,
              location_name: e.locationName,
              latitude: e.latitude,
              longitude: e.longitude,
              captured_at: new Date(e.capturedAt).toISOString(),
              status: 'pending',
            })
            .select('id')
            .single();
          if (error) {
            // Idempotency-key collision: receipt already on server.
            // Fetch the server record so the agent can reconcile any drift (amount edits etc.)
            if ((error as any).code === '23505') {
              const { data: existing } = await (supabase.from('field_collections') as any)
                .select('id, amount, captured_at, tenant_name, status, created_at')
                .eq('agent_id', user.id)
                .eq('client_uuid', e.id)
                .maybeSingle();
              const sameAmount = existing && Number(existing.amount) === Number(e.amount);
              if (existing && sameAmount) {
                // Identical receipt already uploaded — silently mark as synced.
                await updateEntry(e.id, {
                  syncState: 'synced',
                  serverId: existing.id,
                  syncError: null,
                  lastSyncAt: Date.now(),
                });
                ok++;
              } else {
                // Local entry was edited after a previous successful sync, OR
                // a different device already pushed this client_uuid with different values.
                await updateEntry(e.id, {
                  syncState: 'duplicate',
                  syncError: 'Already on server — needs reconciliation',
                  duplicateOfServerId: existing?.id ?? null,
                  duplicateServerSnapshot: existing ? {
                    amount: Number(existing.amount),
                    capturedAt: existing.captured_at,
                    tenantName: existing.tenant_name,
                    status: existing.status,
                    createdAt: existing.created_at,
                  } : null,
                  lastSyncAt: Date.now(),
                });
                dup++;
              }
            } else {
              await updateEntry(e.id, { syncState: 'error', syncError: error.message, lastSyncAt: Date.now() });
              fail++;
            }
          } else {
            await updateEntry(e.id, {
              syncState: 'synced',
              serverId: (data as any)?.id,
              syncError: null,
              lastSyncAt: Date.now(),
            });
            ok++;
          }
        } catch (err: any) {
          await updateEntry(e.id, { syncState: 'error', syncError: err?.message || 'Unknown', lastSyncAt: Date.now() });
          fail++;
        }
      }
      await refreshEntries();
      const parts: string[] = [];
      if (ok) parts.push(`${ok} synced`);
      if (dup) parts.push(`${dup} duplicate`);
      if (fail) parts.push(`${fail} failed`);
      if (!parts.length) toast.info('Nothing to sync');
      else if (dup || fail) toast.warning(parts.join(' · '));
      else toast.success(parts.join(' · '));
    } catch (storeErr) {
      // Offline storage died mid-sync (the per-entry catch rethrows when its own
      // write fails). Receipts already uploaded are deduped on client_uuid at the
      // next sync, so nothing is counted twice.
      toast.error(storeErr instanceof Error ? storeErr.message : 'Offline storage error — reload and try again');
    } finally {
      setSyncing(false);
    }
  };

  /* Auto-sync when coming online */
  useEffect(() => {
    if (online && open && user?.id) {
      getQueuedEntries(user.id).then(q => {
        if (q.length) handleSync();
      }).catch(e => console.warn('auto-sync queue read failed', e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, open, user?.id]);

  /* Reset wizard when dialog closes */
  useEffect(() => {
    if (!open) resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tenantPicked = !!picked || !!walkupName.trim();
  const amountValid = Number(amount) > 0;
  const tenantLabel = picked?.fullName || walkupName.trim() || 'No tenant';
  const tenantPhoneLabel = picked?.phone || walkupPhone.trim() || null;
  const purposeLabel = PURPOSES.find(p => p.id === purpose)?.label ?? 'Rent';

  const goNext = () => {
    if (step === 1) {
      if (!tenantPicked) {
        toast.error('Pick a tenant or enter a name');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!amountValid) {
        toast.error('Enter a valid amount');
        return;
      }
      setStep(3);
    }
  };
  const goBack = () => {
    if (step > 1) setStep((step - 1) as Step);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 gap-0 overflow-hidden bg-background',
          // Mobile: full-screen sheet for maximum tap area
          // `max-h-none` is required to override the base DialogContent's
          // `max-h-[85vh]`, otherwise the sheet is capped at 85vh and the
          // dashboard + bottom nav bleed through below it.
          'w-screen h-[100dvh] max-h-none max-w-none rounded-none translate-x-0 translate-y-0 left-0 top-0 sm:left-[50%] sm:top-[50%] sm:translate-x-[-50%] sm:translate-y-[-50%]',
          // Tablet/desktop: roomy modal
          'sm:w-full sm:max-w-lg sm:h-auto sm:max-h-[92vh] sm:rounded-3xl',
          'flex flex-col',
        )}
      >
        {/* Sticky header */}
        <DialogHeader className="px-5 pt-5 pb-3 sm:px-6 sm:pt-6 sm:pb-4 sticky top-0 bg-background z-10 border-b">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-xl sm:text-2xl font-bold tracking-tight">Collect cash</DialogTitle>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full font-medium',
                online
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              )}
            >
              {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {online ? 'Online' : 'Saving offline'}
            </span>
          </div>
          <DialogDescription className="sr-only">
            Record a cash payment from a tenant in three guided steps. Works without internet.
          </DialogDescription>

          {/* Step indicator */}
          <div className="flex items-center gap-2 mt-3" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step}>
            {[1, 2, 3].map((i) => {
              const done = i < step;
              const active = i === step;
              return (
                <div key={i} className="flex-1 flex items-center gap-2 min-w-0">
                  <div
                    className={cn(
                      'h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 border',
                      done && 'bg-primary text-primary-foreground border-primary',
                      active && 'bg-primary/10 text-primary border-primary',
                      !done && !active && 'bg-muted text-muted-foreground border-transparent',
                    )}
                  >
                    {done ? <CheckCircle2 className="h-4 w-4" /> : i}
                  </div>
                  {i < 3 && (
                    <div className={cn('h-0.5 flex-1 rounded-full', done ? 'bg-primary' : 'bg-muted')} />
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-left">
            Step {step} of 3 ·{' '}
            {step === 1 && 'Choose tenant'}
            {step === 2 && 'Enter amount'}
            {step === 3 && 'Confirm & save'}
          </p>
        </DialogHeader>

        {/* Scrollable body — leaves room for sticky save bar at bottom */}
        <div className="px-5 sm:px-6 py-5 space-y-5 overflow-y-auto flex-1 pb-32 sm:pb-5">
          {/* ───── Offline help card (collapsible) ───── */}
          <details className="group rounded-2xl border bg-muted/30 open:bg-muted/40 transition-colors">
            <summary className="cursor-pointer select-none list-none px-4 py-3 flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 min-w-0">
                <span
                  className={cn(
                    'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
                    online
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                  )}
                  aria-hidden
                >
                  <HelpCircle className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold truncate">
                    {online ? 'How to save offline' : 'You are offline — your work is safe'}
                  </span>
                  <span className="block text-[11px] text-muted-foreground truncate">
                    Tap to see how slow or no internet is handled
                  </span>
                </span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180 shrink-0" />
            </summary>
            <div className="px-4 pb-4 pt-1 space-y-3">
              <ol className="space-y-2.5">
                <li className="flex items-start gap-3">
                  <span className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    1
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">Save works without internet</p>
                    <p className="text-xs text-muted-foreground leading-snug">
                      Tap <span className="font-semibold text-foreground">Save</span> normally — the entry is stored on this phone right away, even with no signal.
                    </p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    2
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">Look for the queued dot</p>
                    <p className="text-xs text-muted-foreground leading-snug">
                      A small <span className="inline-flex items-center gap-1 font-semibold text-foreground"><span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> amber dot</span> means it's waiting to be sent. A green check means it's already with the office.
                    </p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    3
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">Sends itself when signal returns</p>
                    <p className="text-xs text-muted-foreground leading-snug">
                      The moment your phone is back online, queued entries upload automatically. You don't need to redo them.
                    </p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    4
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">Keep the app installed</p>
                    <p className="text-xs text-muted-foreground leading-snug">
                      Don't clear app data while entries still show the amber dot — that's the only way they could be lost.
                    </p>
                  </div>
                </li>
              </ol>
              <div className="rounded-xl border border-dashed bg-background/60 px-3 py-2 text-[11px] text-muted-foreground leading-snug">
                <span className="font-semibold text-foreground">Tip:</span> Slow internet is fine too — saves never wait for the network. Sync happens quietly in the background.
              </div>
            </div>
          </details>

          {/* ───── STEP 1 — Tenant ───── */}
          {step === 1 && (
            <section
              className="space-y-3"
              aria-labelledby="step1-title"
              onKeyDown={handleStep1TypeAhead}
            >
              <div className="flex items-center justify-between">
                <Label id="step1-title" className="text-lg font-bold tracking-tight">
                  Who paid?
                </Label>
                {tenants.length > 0 && (
                  <button
                    type="button"
                    onClick={refreshTenantCache}
                    disabled={!online || tenantsLoading}
                    className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <RefreshCcw className={cn('h-3 w-3', tenantsLoading && 'animate-spin')} />
                    Refresh
                  </button>
                )}
              </div>

              {picked ? (
                <div className="rounded-2xl bg-primary/5 border border-primary/20 px-4 py-4 space-y-3">
                  <div className="flex items-center justify-between gap-2 min-h-[48px]">
                    <div className="min-w-0 flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <User className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-base sm:text-lg font-semibold truncate">{picked.fullName}</p>
                        <p className="text-xs text-muted-foreground truncate">{picked.phone || 'No phone'}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-10 px-4 rounded-full"
                      onClick={() => { setPicked(null); setSearch(''); }}
                    >
                      Change
                    </Button>
                  </div>

                  {/* Last-payment preview — quiet helper to avoid double-recording */}
                  {lastEntryForPicked ? (
                    <div className="rounded-xl border bg-background/70 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          Last payment
                        </span>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                            lastEntryForPicked.syncState === 'synced'
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                              : lastEntryForPicked.syncState === 'queued'
                              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                              : 'bg-destructive/10 text-destructive',
                          )}
                        >
                          {lastEntryForPicked.syncState === 'synced' && 'Sent'}
                          {lastEntryForPicked.syncState === 'queued' && 'Waiting'}
                          {lastEntryForPicked.syncState === 'error' && 'Failed'}
                          {lastEntryForPicked.syncState === 'duplicate' && 'Duplicate'}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 mt-1">
                        <p className="text-base font-bold tabular-nums">
                          {formatUGX(lastEntryForPicked.amount)}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {(() => {
                            const ms = Date.now() - lastEntryForPicked.capturedAt;
                            const mins = Math.floor(ms / 60_000);
                            if (mins < 1) return 'Just now';
                            if (mins < 60) return `${mins}m ago`;
                            const hrs = Math.floor(mins / 60);
                            if (hrs < 24) return `${hrs}h ago`;
                            const days = Math.floor(hrs / 24);
                            if (days < 7) return `${days}d ago`;
                            return new Date(lastEntryForPicked.capturedAt).toLocaleDateString();
                          })()}
                          {' · '}
                          {new Date(lastEntryForPicked.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      {lastEntryForPicked.notes && (
                        <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                          “{lastEntryForPicked.notes}”
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed bg-background/40 px-3 py-2 text-[11px] text-muted-foreground text-center">
                      No previous collection on this device.
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Recent tenants — shown only when no query and at least one chip */}
                  {!search && recentTenants.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Recent
                      </div>
                      <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {recentTenants.map((t) => {
                          const optIdx = keyboardOptions.findIndex(o => o.tenantId === t.tenantId);
                          const isActive = optIdx === activeIdx;
                          const initials = t.fullName
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map(s => s[0]?.toUpperCase())
                            .join('') || '?';
                          return (
                            <button
                              key={`recent-${t.tenantId}`}
                              ref={el => { if (optIdx >= 0) optionRefs.current[optIdx] = el; }}
                              type="button"
                              onClick={() => pickTenant(t)}
                              onMouseEnter={() => optIdx >= 0 && setActiveIdx(optIdx)}
                              role="option"
                              aria-selected={isActive}
                              className={cn(
                                'shrink-0 flex items-center gap-2 rounded-full border bg-card hover:bg-accent active:bg-accent/80 pl-1.5 pr-3.5 py-1.5 min-h-[40px] transition-colors touch-manipulation',
                                isActive && 'ring-2 ring-primary border-primary bg-accent',
                              )}
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                              aria-label={`Quick pick ${t.fullName}`}
                            >
                              <span className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[11px] font-bold">
                                {initials}
                              </span>
                              <span className="text-sm font-medium max-w-[140px] truncate">
                                {t.fullName.split(' ')[0]}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      value={search}
                      onChange={e => { setSearch(e.target.value); setPicked(null); }}
                      onKeyDown={handleSearchKeyDown}
                      placeholder={tenants.length ? 'Search name or phone' : 'Connect to load tenants'}
                      className="pl-11 pr-11 h-14 text-base rounded-2xl"
                      autoComplete="off"
                      autoFocus
                      role="combobox"
                      aria-expanded={keyboardOptions.length > 0}
                      aria-controls="tenant-suggestion-list"
                      aria-activedescendant={
                        keyboardOptions[activeIdx]
                          ? `tenant-opt-${keyboardOptions[activeIdx].tenantId}`
                          : undefined
                      }
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => setSearch('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Clear search"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/*
                   * Tail-share hint. Visible only when the agent has typed a
                   * 3–4 digit phone-y query — the same range that triggers
                   * the dialog's "short phone query" disambiguation rules.
                   * Tells them how many tenants in their caseload end in
                   * those exact digits so they know whether to type more.
                   *
                   * Color cues:
                   *   0 matches  → muted (no help; probably typo / wrong digits)
                   *   1 match    → success (unique tail; only one candidate)
                   *   2–4        → primary (small set; pickable from list)
                   *   5+         → warning (highly ambiguous; type more digits)
                   */}
                  {tailShareHint && (() => {
                    // Pick the count to display + label based on the active mode.
                    // 'tenants' matches what the result list shows 1:1.
                    // 'buckets' counts distinct (tailLen+1)-digit groups —
                    // i.e. how many "next-digit-out" prefixes share the tail,
                    // which is what would narrow to if the agent typed one
                    // more digit. Color thresholds reuse the same
                    // 0/1/2-4/5+ severity buckets so the visual semantics
                    // (good/ok/risky) stay consistent across modes.
                    const count = tailHintMode === 'tenants'
                      ? tailShareHint.tenantCount
                      : tailShareHint.bucketCount;
                    const noun = tailHintMode === 'tenants' ? 'tenant' : 'bucket';
                    const verb = tailHintMode === 'tenants' ? 'end in' : 'share';
                    return (
                      <div className="flex items-center gap-2">
                        <div
                          role="status"
                          aria-live="polite"
                          className={cn(
                            'flex flex-1 items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium tabular-nums',
                            count === 0 && 'bg-muted/50 text-muted-foreground',
                            count === 1 && 'bg-success/10 text-success',
                            count >= 2 && count <= 4 && 'bg-primary/10 text-primary',
                            count >= 5 && 'bg-warning/15 text-warning-foreground border border-warning/30',
                          )}
                        >
                          <span className="font-mono opacity-70">…{tailShareHint.digits}</span>
                          <span>·</span>
                          <span>
                            {count === 0 && `No ${noun}s ${verb} these ${tailShareHint.tailLen} digits`}
                            {count === 1 && `1 ${noun} ${verb}s these ${tailShareHint.tailLen} digits`}
                            {count >= 2 && (
                              <>
                                {count} {noun}s {verb} these {tailShareHint.tailLen} digits
                                {count >= 5 && ' — type more to narrow'}
                              </>
                            )}
                          </span>
                        </div>
                        {/* Mode toggle — lets the agent flip between counting
                          * raw tenants (matches the result list) and counting
                          * distinct tail-digit buckets (predicts what one
                          * more digit would narrow to). Compact pill so it
                          * doesn't compete with the hint label visually. */}
                        <div
                          role="tablist"
                          aria-label="Tail-share count mode"
                          className="inline-flex shrink-0 rounded-full bg-muted p-0.5 text-[11px]"
                        >
                          {(['tenants', 'buckets'] as const).map(opt => (
                            <button
                              key={opt}
                              type="button"
                              role="tab"
                              aria-selected={tailHintMode === opt}
                              onClick={() => setTailHintMode(opt)}
                              className={cn(
                                'px-2.5 h-6 rounded-full font-medium capitalize transition-colors',
                                tailHintMode === opt
                                  ? 'bg-background text-foreground shadow-sm'
                                  : 'text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/*
                   * Browse-mode toolbar. Only shown when the search box is
                   * empty AND the agent has more than one page worth of
                   * tenants — for short caseloads the page would just say
                   * "1 of 1" and waste vertical space.
                   *
                   * Controls:
                   *   - Sort:  Recent (last activity) | A→Z (name)
                   *   - Pager: Prev | "Page X of Y · N tenants" | Next
                   *
                   * Search mode hides this entirely; the existing scoring
                   * + 200-row cap still drives that path.
                   */}
                  {!search && tenants.length > BROWSE_PAGE_SIZE && (
                    <div className="space-y-1.5 px-1 text-xs">
                      <div className="flex items-center justify-between gap-2">
                      <div
                        role="tablist"
                        aria-label="Sort tenants"
                        className="inline-flex rounded-full bg-muted p-0.5"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={browseSort === 'recent'}
                          onClick={() => setBrowseSort('recent')}
                          className={cn(
                            'inline-flex items-center gap-1 px-3 h-7 rounded-full font-medium transition-colors',
                            browseSort === 'recent'
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          <Clock className="h-3 w-3" />
                          Recent
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={browseSort === 'name'}
                          onClick={() => setBrowseSort('name')}
                          className={cn(
                            'inline-flex items-center gap-1 px-3 h-7 rounded-full font-medium transition-colors',
                            browseSort === 'name'
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          A→Z
                        </button>
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground tabular-nums">
                        <button
                          type="button"
                          onClick={() => setBrowsePage(p => Math.max(0, p - 1))}
                          disabled={browsePage === 0}
                          aria-label="Previous page"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </button>
                        <span className="px-1 font-medium text-foreground">
                          {browsePage + 1}
                          <span className="text-muted-foreground font-normal"> / {browsePageCount}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setBrowsePage(p => Math.min(browsePageCount - 1, p + 1))}
                          disabled={browsePage >= browsePageCount - 1}
                          aria-label="Next page"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                      </div>
                    </div>
                  )}

                  {/*
                   * Always-visible status filter chips. Lifted out of the
                   * pager toolbar (which only renders when there's >1
                   * page of tenants) so the agent can flip between
                   * Active / Inactive / All without scrolling — the
                   * row sits directly above the result list and stays
                   * mounted for both browse and search modes. The
                   * matching count (`browseFilteredCount`) reflects the
                   * filtered browse universe; in search mode the chips
                   * still narrow the underlying browse pool so a
                   * subsequent clear-search lands on the right slice.
                   */}
                  {!search && tenants.length > 0 && (
                    <div className="flex items-center justify-between gap-2 px-1 text-xs">
                      <div
                        role="tablist"
                        aria-label="Filter tenants by status"
                        className="inline-flex rounded-full bg-muted p-0.5"
                      >
                        {(['all', 'active', 'inactive'] as const).map(opt => (
                          <button
                            key={opt}
                            type="button"
                            role="tab"
                            aria-selected={browseStatus === opt}
                            onClick={() => setBrowseStatus(opt)}
                            className={cn(
                              'inline-flex items-center gap-1 px-3 h-7 rounded-full font-medium capitalize transition-colors',
                              browseStatus === opt
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                      {/*
                       * Tenant count with a "Filter saved <relative>" tooltip
                       * AND an exact timestamp rendered in the agent's
                       * preferred timezone (set via the gear popover, default
                       * = device timezone). The tooltip only appears once a
                       * non-default selection has actually been saved — for
                       * the untouched default 'all' state we render a plain
                       * count to avoid a misleading dotted underline.
                       */}
                      {browseStatusUpdatedAt ? (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className="text-muted-foreground tabular-nums border-b border-dotted border-muted-foreground/40 cursor-help"
                                aria-live="polite"
                                aria-label={
                                  `${browseFilteredCount.toLocaleString()} tenants. ` +
                                  `Filter saved ${formatDistanceToNow(browseStatusUpdatedAt, { addSuffix: true })} ` +
                                  `(${formatInTz(browseStatusUpdatedAt)}).`
                                }
                              >
                                {browseFilteredCount.toLocaleString()} tenant{browseFilteredCount === 1 ? '' : 's'}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[11px] max-w-[260px]">
                              <div className="font-medium">
                                Filter saved {formatDistanceToNow(browseStatusUpdatedAt, { addSuffix: true })}
                              </div>
                              <div className="text-muted-foreground mt-0.5">
                                {formatInTz(browseStatusUpdatedAt)}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span
                          className="text-muted-foreground tabular-nums"
                          aria-live="polite"
                        >
                          {browseFilteredCount.toLocaleString()} tenant{browseFilteredCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {/*
                       * Reset chip — clears the persisted Active/Inactive/All
                       * preference and returns the picker to the 'all'
                       * default. Only renders when the current selection
                       * differs from the default so it doesn't add noise
                       * when nothing's been customized. Wipes the same
                       * per-agent localStorage key the persistence
                       * effect writes to, so a future dialog open won't
                       * silently re-restore the cleared preference.
                       */}
                      {browseStatus !== 'all' && (
                        <button
                          type="button"
                          onClick={() => {
                            setBrowseStatus('all');
                            if (browseStatusStorageKey && typeof window !== 'undefined') {
                              try {
                                window.localStorage.removeItem(browseStatusStorageKey);
                              } catch {
                                /* noop — private mode / quota; UI already reset */
                              }
                            }
                          }}
                          className="inline-flex items-center gap-1 h-7 px-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          aria-label="Reset status filter to default"
                        >
                          <RefreshCcw className="h-3 w-3" />
                          Reset
                        </button>
                      )}
                      {/*
                       * "Saved in this session" badge — only renders when
                       * the localStorage probe failed (Safari Private,
                       * blocked site data, locked-down profile). Signals
                       * that the chip selection won't survive refresh so
                       * the agent isn't surprised, without crowding the
                       * row in the normal case. Tooltip carries the
                       * actionable detail for power users.
                       */}
                      {localStorageBlocked && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="warning"
                                size="sm"
                                className="gap-1 cursor-help"
                                aria-label="Local storage is blocked. Your tenant filter will reset when you refresh."
                              >
                                <CloudOff className="h-3 w-3" />
                                Saved in this session
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[11px] max-w-[240px]">
                              <div className="font-medium">Local storage is blocked</div>
                              <div className="text-muted-foreground mt-0.5">
                                Your tenant filter will reset when you refresh or reopen this app.
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {/*
                       * Picker preferences popover — gear icon at the
                       * end of the row. Two settings:
                       *   1. Cloud sync master toggle (Cloud / CloudOff icon)
                       *   2. Display timezone for the "Filter saved" tooltip
                       * Both are per-user; cloud-sync gates whether the
                       * timezone preference also rides with the account.
                       */}
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            aria-label={`Picker preferences. Cloud sync ${cloudSyncEnabled ? 'enabled' : 'disabled'}.`}
                          >
                            {cloudSyncEnabled ? (
                              <Cloud className="h-3.5 w-3.5" />
                            ) : (
                              <CloudOff className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="end"
                          side="top"
                          className="w-80 p-3 space-y-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 pr-2">
                              <Label
                                htmlFor="picker-cloud-sync-toggle"
                                className="text-sm font-semibold flex items-center gap-1.5"
                              >
                                <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                                Cloud sync
                              </Label>
                              <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                                {cloudSyncEnabled
                                  ? 'Picker filter & timezone follow you across devices.'
                                  : 'Picker filter & timezone stay on this device only.'}
                              </p>
                            </div>
                            <Switch
                              id="picker-cloud-sync-toggle"
                              checked={cloudSyncEnabled}
                              onCheckedChange={(checked) => setCloudSyncEnabled(checked)}
                              aria-label="Toggle picker filter cloud sync"
                            />
                          </div>

                          <Separator />

                          <div className="space-y-1.5">
                            <Label
                              htmlFor="picker-tz-select"
                              className="text-sm font-semibold flex items-center gap-1.5"
                            >
                              <Globe2 className="h-3.5 w-3.5 text-muted-foreground" />
                              Display timezone
                            </Label>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              Used for the "Filter saved" timestamp on hover.
                            </p>
                            <Select value={displayTimezone} onValueChange={setDisplayTimezone}>
                              <SelectTrigger id="picker-tz-select" className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="max-h-72">
                                {TIMEZONE_OPTIONS.map(opt => (
                                  <SelectItem key={opt.id} value={opt.id} className="text-xs">
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {displayTimezone === 'auto' && (
                              <p className="text-[10px] text-muted-foreground pt-1">
                                Resolved to <span className="font-medium">{resolvedDisplayTimezone}</span>
                              </p>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}

                  {(search || tenants.length > 0) && (
                    <div
                      ref={listScrollRef}
                      className="rounded-2xl border max-h-72 overflow-y-auto"
                      id="tenant-suggestion-list"
                      role="listbox"
                    >
                      {/*
                       * Persistent "Recent" rail — pinned to the top of the
                       * result container, ABOVE the virtualized list, so
                       * frequently picked tenants are always one tap away.
                       *
                       * Sourced from the IndexedDB pick log so it survives
                       * reloads (unlike the existing chip strip above the
                       * input which only echoes today's saved entries).
                       *
                       * Hidden during search so it doesn't compete with the
                       * scored results. Sticky positioning keeps it visible
                       * even when the agent scrolls deep into the page.
                       */}
                      {!search && persistentRecentTenants.length > 0 && (
                        <div className="sticky top-0 z-10 bg-card border-b">
                          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            Recent · saved across reloads
                          </div>
                          <div className="flex gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            {persistentRecentTenants.map(t => {
                              const initials = t.fullName
                                .split(/\s+/).filter(Boolean).slice(0, 2)
                                .map(s => s[0]?.toUpperCase()).join('') || '?';
                              return (
                                <button
                                  key={`pin-recent-${t.tenantId}`}
                                  type="button"
                                  onClick={() => pickTenant(t)}
                                  className="shrink-0 inline-flex items-center gap-1.5 rounded-full border bg-background hover:bg-accent active:bg-accent/80 pl-1 pr-3 py-1 min-h-[32px] transition-colors touch-manipulation"
                                  style={{ WebkitTapHighlightColor: 'transparent' }}
                                  aria-label={`Quick pick ${t.fullName}`}
                                >
                                  <span className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">
                                    {initials}
                                  </span>
                                  <span className="text-xs font-medium max-w-[110px] truncate">
                                    {t.fullName.split(' ')[0]}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {(() => {
                        // Detect a short digit-only query (3–4 digits). Drives both the
                        // empty-state hint and the "type more digits" prompt the agent
                        // sees when a single match was suppressed for safety.
                        const phoneQ = normalizePhone(search);
                        const isShortDigitQuery =
                          phoneQ.length >= 3 && phoneQ.length <= 4 &&
                          /\d/.test(search) &&
                          search.replace(/[\s\-+()]/g, '').replace(/\D+/g, '').length >=
                            search.replace(/[\s\-+()]/g, '').length - 1;
                        const isAmbiguous = filtered.length > 0 && (filtered[0] as any).ambiguous;
                        // Count of *raw* tenants whose phone ends with the typed
                        // digits — this is the true number of candidates the
                        // tail-N matcher considered, before any safety
                        // suppression. Drives the warning banner so the agent
                        // always sees an honest candidate count + reason.
                        const tailCandidateCount = isShortDigitQuery
                          ? tenants.reduce((n, t) => {
                              const p = normalizePhone(t.phone);
                              return p && p.endsWith(phoneQ) ? n + 1 : n;
                            }, 0)
                          : 0;
                        const tailLen = phoneQ.length;
                        if (filtered.length === 0) {
                          // Short digit query suppression: when 3–4 digits matched
                          // exactly one tenant, we hide it for safety (see the
                          // suppression block in the `filtered` memo). Tell the agent
                          // exactly how many more digits to type — "2 more" / "1 more"
                          // — instead of the generic "type more digits" prompt.
                          const digitsTyped = phoneQ.length;
                          const digitsNeeded = isShortDigitQuery ? Math.max(5 - digitsTyped, 1) : 0;
                          return (
                            isShortDigitQuery ? (
                              <div className="p-4 space-y-2 text-center">
                                {/*
                                  Honest candidate banner — even though the list
                                  is empty, tell the agent exactly how many
                                  tenants matched the tail and WHY we hid them
                                  (single-candidate safety suppression).
                                */}
                                <div className="px-3 py-2 rounded-lg bg-warning/10 border border-warning/30 text-[11px] font-medium text-warning text-left">
                                  <span className="font-semibold">
                                    {tailCandidateCount} tenant
                                    {tailCandidateCount === 1 ? '' : 's'}
                                  </span>{' '}
                                  end{tailCandidateCount === 1 ? 's' : ''} in{' '}
                                  <span className="font-mono">…{phoneQ}</span>.
                                  {tailCandidateCount === 1
                                    ? ' Hidden — a single short-tail match is too risky to auto-pick.'
                                    : ' Limited to last-' + tailLen + '-digit matches because you typed ' + tailLen + ' digits.'}
                                </div>
                                <p className="text-sm font-medium text-foreground">
                                  Type{' '}
                                  <span className="font-bold text-primary">
                                    {digitsNeeded} more digit{digitsNeeded === 1 ? '' : 's'}
                                  </span>{' '}
                                  to confirm the tenant.
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {digitsTyped} digit{digitsTyped === 1 ? '' : 's'} isn't enough to be sure — or search by name.
                                </p>
                                {/*
                                  One-click escape hatch: clears the digit
                                  query and refocuses the search input so the
                                  agent can immediately type a name without
                                  having to manually backspace.
                                */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSearch('');
                                    setPicked(null);
                                    // Refocus so the agent can start typing
                                    // the name straight away.
                                    requestAnimationFrame(() => searchInputRef.current?.focus());
                                  }}
                                  className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                >
                                  <Search className="h-3 w-3" />
                                  Search by name instead
                                </button>
                              </div>
                            ) : (
                              <p className="p-4 text-sm text-muted-foreground text-center">
                                No match. Use walk-up below.
                              </p>
                            )
                          );
                        }
                        const virtualItems = rowVirtualizer.getVirtualItems();
                        const totalSize = rowVirtualizer.getTotalSize();
                        return (
                          <>
                            {isAmbiguous && (
                              <div className="px-4 py-2 text-[11px] font-medium text-warning bg-warning/10 border-b space-y-0.5">
                                <div>
                                  <span className="font-semibold">
                                    {tailCandidateCount} tenant
                                    {tailCandidateCount === 1 ? '' : 's'}
                                  </span>{' '}
                                  end{tailCandidateCount === 1 ? 's' : ''} in{' '}
                                  <span className="font-mono">…{phoneQ}</span>
                                  {tailCandidateCount !== filtered.length && (
                                    <> · showing top {filtered.length}</>
                                  )}
                                </div>
                                <div className="text-warning/80 font-normal">
                                  Limited to last-{tailLen}-digit matches because you typed {tailLen} digits — pick carefully or type more.
                                </div>
                              </div>
                            )}
                            {/*
                             * Virtualized rows. Only the items inside (or near) the
                             * viewport are mounted, so DOM size stays O(visible) even
                             * with a 200-row result set or a tenant book of thousands.
                             */}
                            <div
                              style={{
                                height: `${totalSize}px`,
                                width: '100%',
                                position: 'relative',
                              }}
                            >
                              {virtualItems.map(virtualRow => {
                                const idx = virtualRow.index;
                                const row = filtered[idx];
                                if (!row) return null;
                                const { t, matchType, bestMatchFallback } = row;
                                const optIdx = keyboardOptions.findIndex(o => o.tenantId === t.tenantId);
                                const isActive = optIdx === activeIdx;
                                return (
                                <button
                                  key={t.tenantId}
                                  id={`tenant-opt-${t.tenantId}`}
                                  data-index={idx}
                                  ref={el => {
                                    // Wire up both the keyboard-nav ref array and the
                                    // virtualizer's measurer so rows that wrap to a
                                    // second line (extra chips) report their real height.
                                    if (optIdx >= 0) optionRefs.current[optIdx] = el;
                                    if (el) rowVirtualizer.measureElement(el);
                                  }}
                                  onClick={() => pickTenant(t)}
                                  onMouseEnter={() => optIdx >= 0 && setActiveIdx(optIdx)}
                                  role="option"
                                  aria-selected={isActive}
                                  className={cn(
                                    'w-full text-left px-4 py-4 min-h-[60px] border-b last:border-b-0 flex items-center justify-between gap-2 active:bg-accent/80 touch-manipulation transition-colors',
                                    isActive ? 'bg-accent' : 'hover:bg-accent',
                                  )}
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualRow.start}px)`,
                                    WebkitTapHighlightColor: 'transparent',
                                  }}
                                >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                              <p className="text-base font-semibold truncate">
                                {highlightName(t.fullName, search)}
                              </p>
                              {idx === 0 && search && (
                                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                                  Top result
                                </span>
                              )}
                              {/*
                               * Fuzzy fallback chip: strict normalization didn't
                               * land on this row, but a relaxed phone-variant
                               * comparison did. Tells the agent "we relaxed the
                               * rules to find this — double-check before tapping".
                               */}
                              {bestMatchFallback && (
                                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-warning/15 text-warning px-1.5 py-0.5 rounded ring-1 ring-warning/30">
                                  Best match
                                </span>
                              )}
                              {/*
                               * Match-type chips on the top result: tells the agent *why*
                               * this tenant was suggested — phone-digit match, name match,
                               * or both. Shown on the top 3 results so the ranking is
                               * transparent without flooding the rest of the list.
                               */}
                              {idx < 3 && search && matchType && (
                                <>
                                  {matchType === 'both' && (
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-primary/15 text-primary px-1.5 py-0.5 rounded ring-1 ring-primary/30">
                                      Phone + Name match
                                    </span>
                                  )}
                                  {matchType === 'phone' && (
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-success/10 text-success px-1.5 py-0.5 rounded">
                                      Phone match
                                    </span>
                                  )}
                                  {matchType === 'name' && (
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-accent text-accent-foreground px-1.5 py-0.5 rounded">
                                      Name match
                                    </span>
                                  )}
                                </>
                              )}
                              {/*
                               * When there is no search query, show a neutral
                               * "Recent" chip on the top suggestions so agents
                               * still understand why these tenants appear first
                               * (most recent / default order, not a search match).
                               */}
                              {idx < 3 && !search && (
                                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                                  Recent
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {t.phone ? highlightPhone(t.phone, search) : 'No phone'}
                            </p>
                          </div>
                          {t.monthlyRent ? (
                            <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                              {formatUGX(t.monthlyRent)}/mo
                            </span>
                          ) : null}
                                </button>
                                );
                              })}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {/* Walk-up fallback */}
                  <details className="text-sm rounded-2xl border bg-muted/20 px-4 py-3 group">
                    <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground select-none">
                      Tenant not in the list?
                    </summary>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Input
                        value={walkupName}
                        onChange={e => { setWalkupName(e.target.value); setPicked(null); }}
                        placeholder="Name"
                        maxLength={100}
                        className="h-12 rounded-xl text-base"
                      />
                      <Input
                        value={walkupPhone}
                        onChange={e => setWalkupPhone(e.target.value.replace(/[^\d+\s-]/g, '').slice(0, 20))}
                        placeholder="Phone"
                        inputMode="tel"
                        className="h-12 rounded-xl text-base"
                      />
                    </div>
                  </details>
                </>
              )}
            </section>
          )}

          {/* ───── STEP 2 — Amount ───── */}
          {step === 2 && (
            <section className="space-y-3" aria-labelledby="step2-title">
              <Label id="step2-title" className="text-lg font-bold tracking-tight">
                How much did {picked?.fullName?.split(' ')[0] || walkupName.trim().split(' ')[0] || 'they'} pay?
              </Label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-base font-semibold text-muted-foreground pointer-events-none">
                  UGX
                </span>
                <Input
                  value={amount ? Number(amount).toLocaleString() : ''}
                  onChange={e => setAmount(e.target.value.replace(/[^\d]/g, '').slice(0, 12))}
                  inputMode="numeric"
                  placeholder="0"
                  className="pl-16 h-[72px] sm:h-16 text-4xl sm:text-3xl font-bold tabular-nums rounded-2xl text-right pr-5"
                  autoFocus
                />
              </div>
              {/* Quick-amount chips */}
              <div className="grid grid-cols-4 gap-2">
                {[10000, 50000, 100000, 200000].map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(String((Number(amount) || 0) + v))}
                    className="h-12 rounded-full border bg-card text-sm font-semibold hover:bg-accent active:bg-accent/80 transition-colors tabular-nums touch-manipulation"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    +{(v / 1000)}k
                  </button>
                ))}
              </div>
              {amount && (
                <button
                  type="button"
                  onClick={() => setAmount('')}
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                >
                  Clear amount
                </button>
              )}
            </section>
          )}

          {/* ───── STEP 3 — Confirm ───── */}
          {step === 3 && (
            <section className="space-y-4" aria-labelledby="step3-title">
              <Label id="step3-title" className="text-lg font-bold tracking-tight">
                What's this payment for?
              </Label>

              <div className="grid grid-cols-3 gap-2">
                {PURPOSES.map(p => {
                  const Icon = p.icon;
                  const active = purpose === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPurpose(p.id)}
                      aria-pressed={active}
                      className={cn(
                        'rounded-2xl border px-3 py-4 flex flex-col items-center gap-2 touch-manipulation transition-all min-h-[88px]',
                        active
                          ? 'bg-primary/10 border-primary text-primary shadow-sm'
                          : 'bg-card hover:bg-accent active:bg-accent/80 border-border',
                      )}
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Icon className="h-6 w-6" />
                      <span className="text-sm font-semibold">{p.label}</span>
                    </button>
                  );
                })}
              </div>

              <Input
                value={notes}
                onChange={e => setNotes(e.target.value.slice(0, 140))}
                placeholder="Add a note (optional)"
                maxLength={140}
                className="h-12 rounded-2xl text-sm"
              />

              {/* Summary card */}
              <div className="rounded-2xl border bg-muted/30 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                    <ClipboardCheck className="h-3.5 w-3.5" />
                    Review
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="text-xs text-primary font-semibold hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <div className="space-y-2.5">
                  <SummaryRow icon={User} label="Tenant" value={tenantLabel} sub={tenantPhoneLabel} />
                  <SummaryRow
                    icon={Banknote}
                    label="Amount"
                    value={formatUGX(Number(amount) || 0)}
                    valueClassName="text-2xl font-bold tabular-nums tracking-tight"
                  />
                  <SummaryRow icon={Sparkles} label="Purpose" value={purposeLabel} sub={notes.trim() || null} />
                </div>
              </div>
            </section>
          )}

          {/* Daily totals — collapsible to keep main flow simple */}
          <details className="rounded-2xl border bg-muted/20 group">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground select-none flex items-center justify-between">
              <span>Today's breakdown & sync status</span>
              <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
              <span className="text-xs text-muted-foreground hidden group-open:inline">Hide</span>
            </summary>
            <div className="px-3 pb-3">
              <FieldCollectDailyTotals
                key={entries.length + ':' + queuedCount}
                variant="inline"
              />
            </div>
          </details>

          <Separator />

          {/* Captured list — collapsed by default to keep main flow simple */}
          {entries.length > 0 && (
            <details className="rounded-2xl border bg-muted/20 group">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground select-none flex items-center justify-between">
                <span>Recent payments ({entries.length})</span>
                <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
                <span className="text-xs text-muted-foreground hidden group-open:inline">Hide</span>
              </summary>
              <div className="px-3 pb-3">
                <ScrollArea className="max-h-72">
                  <ul className="space-y-2 pr-2">
                    {entries.map(e => (
                      <li
                        key={e.id}
                        className="flex items-center justify-between gap-2 rounded-2xl border bg-card px-4 py-3 min-h-[60px]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold truncate">{e.tenantName}</p>
                            {e.syncState === 'synced' && (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                            )}
                            {e.syncState === 'error' && (
                              <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                            )}
                            {e.syncState === 'queued' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium shrink-0">
                                Waiting
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {new Date(e.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {e.tenantPhone ? ` · ${e.tenantPhone}` : ''}
                          </p>
                        </div>
                        <p className="text-base font-bold tabular-nums shrink-0">
                          {formatUGX(e.amount)}
                        </p>
                        {e.syncState !== 'synced' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-11 w-11 rounded-full shrink-0"
                            onClick={() => handleDelete(e.id)}
                            aria-label="Delete"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              </div>
            </details>
          )}
        </div>

        {/* Sticky wizard footer — Back / Next or Save */}
        <div
          className="sticky bottom-0 left-0 right-0 px-4 sm:px-6 py-3 bg-background/95 backdrop-blur border-t z-10 flex items-center gap-2"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
        >
          {step > 1 && (
            <Button
              type="button"
              onClick={goBack}
              variant="outline"
              size="lg"
              className="h-14 px-5 rounded-2xl gap-1.5 font-semibold"
              disabled={saving}
            >
              <ChevronLeft className="h-5 w-5" />
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button
              type="button"
              onClick={goNext}
              size="lg"
              className="flex-1 h-14 text-base font-semibold rounded-2xl gap-1.5"
              disabled={
                (step === 1 && !tenantPicked) ||
                (step === 2 && !amountValid)
              }
            >
              Next
              <ChevronRight className="h-5 w-5" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSave}
              size="lg"
              disabled={saving || !amountValid || !tenantPicked}
              className="flex-1 h-14 text-base font-semibold rounded-2xl gap-2 shadow-lg shadow-primary/20"
            >
              {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
              Save {formatUGX(Number(amount) || 0)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact label/value row used in the Review summary card. */
function SummaryRow({
  icon: Icon,
  label,
  value,
  sub,
  valueClassName,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string | null;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="h-8 w-8 rounded-full bg-background border flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
        <p className={cn('text-base font-semibold leading-tight mt-0.5 truncate', valueClassName)}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
      </div>
    </div>
  );
}

export default FieldCollectDialog;