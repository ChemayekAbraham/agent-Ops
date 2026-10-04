import { useState, useEffect, useRef, forwardRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Search, X, User, AlertCircle, ShieldAlert } from 'lucide-react';

export interface UserResult {
  id: string;
  full_name: string;
  phone: string;
}

interface CurrentAccess {
  roles: string[];
  dashboards: string[];
}

/** Exact app-roles whose RLS policies grant full user-directory search. */
const REQUIRED_SEARCH_ROLES = [
  'CFO',
  'Manager',
  'Operations',
  'Super Admin',
  'COO',
  'CEO',
  'CTO',
  'CMO',
  'CRM',
  'HR',
] as const;

interface UserSearchPickerProps {
  label: string;
  placeholder?: string;
  selectedUser: UserResult | null;
  onSelect: (user: UserResult | null) => void;
  roleFilter?: string;
}

const MIN_QUERY_LENGTH = 5;
const DEBOUNCE_MS = 400;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = { at: number; results: UserResult[] };
const searchCache = new Map<string, CacheEntry>();

function cacheKey(trimmed: string, roleFilter?: string) {
  return `${roleFilter ?? '_'}::${trimmed.toLowerCase()}`;
}
function cacheGet(key: string): UserResult[] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  // refresh LRU order
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.results;
}
function cacheSet(key: string, results: UserResult[]) {
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
}

export const UserSearchPicker = forwardRef<HTMLDivElement, UserSearchPickerProps>(
  function UserSearchPicker({ label, placeholder = 'Search by name or phone...', selectedUser, onSelect, roleFilter }, ref) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<UserResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [currentAccess, setCurrentAccess] = useState<CurrentAccess | null>(null);

    // Load the signed-in staff member's own roles + dashboard permissions once,
    // so a permission error can spell out exactly what they currently hold.
    useEffect(() => {
      let active = true;
      (async () => {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;

        const [{ data: roleRows }, { data: permRows }] = await Promise.all([
          supabase.from('user_roles').select('role').eq('user_id', uid).eq('enabled', true),
          supabase.from('staff_permissions').select('permitted_dashboard').eq('user_id', uid),
        ]);

        if (!active) return;
        setCurrentAccess({
          roles: (roleRows || []).map((r: any) => String(r.role)),
          dashboards: (permRows || [])
            .map((p: any) => p.permitted_dashboard)
            .filter(Boolean)
            .map((d: any) => String(d)),
        });
      })();
      return () => { active = false; };
    }, []);

    useEffect(() => {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        setResults([]);
        setSearchError(null);
        setPermissionDenied(false);
        setLoading(false);
        return;
      }

      // Instant cache hit — no DB request.
      const key = cacheKey(trimmed, roleFilter);
      const cached = cacheGet(key);
      if (cached) {
        setResults(cached);
        setLoading(false);
        setSearchError(null);
        setPermissionDenied(false);
        return;
      }

      const abort = new AbortController();
      const timer = setTimeout(async () => {
        setLoading(true);
        setSearchError(null);
        setPermissionDenied(false);

        try {
          // Dedicated indexed search RPC — bypasses per-row RLS overhead.
          const { data, error } = await (supabase.rpc as any)('search_users_fast', {
            p_query: trimmed,
            p_limit: 50,
          }).abortSignal(abort.signal);
          if (abort.signal.aborted) return;

          if (error) {
            console.error('[UserSearchPicker] search failed:', error);
            setResults([]);
            if ((error as any).code === '42501' || /not authorized/i.test(error.message || '')) {
              setPermissionDenied(true);
              setSearchError(null);
            } else {
              setPermissionDenied(false);
              setSearchError(error.message || 'Search failed. Please try again.');
            }
            setLoading(false);
            return;
          }

          let list: UserResult[] = (data || []).map((r: any) => ({
            id: r.id, full_name: r.full_name, phone: r.phone,
          }));

          // Optional role narrowing — small batch (≤50), single indexed lookup.
          if (roleFilter && list.length > 0) {
            const { data: roleData, error: roleError } = await supabase
              .from('user_roles')
              .select('user_id')
              .eq('role', roleFilter as any)
              .eq('enabled', true)
              .in('user_id', list.map(u => u.id))
              .abortSignal(abort.signal);
            if (abort.signal.aborted) return;
            if (roleError) {
              setResults([]);
              setSearchError(roleError.message || 'Search failed. Please try again.');
              setLoading(false);
              return;
            }
            const ok = new Set((roleData || []).map(r => r.user_id));
            list = list.filter(u => ok.has(u.id));
          }

          const trimmed10 = list.slice(0, 10);
          setResults(trimmed10);
          cacheSet(key, trimmed10);
        } catch (error) {
          if (abort.signal.aborted) return;
          console.error('[UserSearchPicker] unexpected search failure:', error);
          setResults([]);
          setPermissionDenied(false);
          setSearchError('Search failed. Please try again.');
        }

        if (!abort.signal.aborted) setLoading(false);
      }, DEBOUNCE_MS);

      return () => {
        clearTimeout(timer);
        abort.abort();
      };
    }, [query, roleFilter]);

    if (selectedUser) {
      return (
        <div ref={ref}>
          <Label>{label}</Label>
          <div className="flex items-center gap-2 p-2 rounded-lg border bg-muted/30 mt-1">
            <User className="h-4 w-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{selectedUser.full_name}</p>
              <p className="text-xs text-muted-foreground">{selectedUser.phone}</p>
            </div>
            <button type="button" onClick={() => onSelect(null)} className="text-muted-foreground hover:text-destructive">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="relative" ref={ref}>
        <Label>{label}</Label>
        <div className="relative mt-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={placeholder}
            value={query}
            onChange={e => { setQuery(e.target.value); setShowResults(true); }}
            onFocus={() => setShowResults(true)}
            className="pl-9"
          />
          {loading && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        {showResults && results.length > 0 && (
          <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {results.map(u => (
              <button
                key={u.id}
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors text-sm"
                onClick={() => { onSelect(u); setQuery(''); setShowResults(false); setSearchError(null); }}
              >
                <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{u.full_name}</p>
                  <p className="text-xs text-muted-foreground">{u.phone}</p>
                </div>
              </button>
            ))}
          </div>
        )}
        {showResults && query.trim().length >= MIN_QUERY_LENGTH && !loading && permissionDenied && (
          <div className="absolute z-50 w-full mt-1 bg-popover border border-destructive/30 rounded-lg shadow-lg p-3 text-left">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p className="text-xs font-semibold text-destructive">No permission to search users</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Your account can open this dashboard, but searching the full user
                  directory requires <span className="font-medium text-foreground">any one</span> of
                  these app-roles (enabled):
                </p>
                <div className="flex flex-wrap gap-1">
                  {REQUIRED_SEARCH_ROLES.map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                    >
                      {r}
                    </span>
                  ))}
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-2 space-y-1.5">
                  <p className="text-[11px] font-semibold text-foreground">Your current access</p>
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground">App-roles (enabled):</p>
                    {currentAccess && currentAccess.roles.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {currentAccess.roles.map((r) => (
                          <span
                            key={r}
                            className="inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] italic text-muted-foreground">None</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground">Dashboard permissions:</p>
                    {currentAccess && currentAccess.dashboards.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {currentAccess.dashboards.map((d) => (
                          <span
                            key={d}
                            className="inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] italic text-muted-foreground">None</p>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Dashboard access alone (via staff permissions) is not enough — ask a
                  Super Admin to enable one of the roles above on your account.
                </p>
              </div>
            </div>
          </div>
        )}
        {showResults && query.trim().length >= MIN_QUERY_LENGTH && !loading && !permissionDenied && searchError && (
          <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg p-3 text-center text-xs text-destructive flex items-center justify-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{searchError}</span>
          </div>
        )}
        {showResults && query.trim().length >= MIN_QUERY_LENGTH && !loading && !permissionDenied && !searchError && results.length === 0 && (
          <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg p-3 text-center text-xs text-muted-foreground">
            No users found
          </div>
        )}
        {showResults && query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH && (
          <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg p-2 text-center text-[11px] text-muted-foreground">
            Type at least {MIN_QUERY_LENGTH} characters to search
          </div>
        )}
      </div>
    );
  }
);
