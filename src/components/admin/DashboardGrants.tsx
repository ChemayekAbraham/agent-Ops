import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

/**
 * The full set of dashboard keys an operator can hold. Rendered in this exact
 * order so the grid reads the same on every card.
 */
export const DASHBOARD_KEYS = [
  'agent-ops',
  'ceo',
  'cfo',
  'cmo',
  'company-ops',
  'coo',
  'crm',
  'cto',
  'director',
  'financial-ops',
  'hr',
  'landlord-ops',
  'partner-ops',
  'tenant-ops',
] as const;

export type DashboardKey = (typeof DASHBOARD_KEYS)[number];

interface ActiveGrant {
  id: string;
  user_id: string;
  permitted_dashboard: string;
}

interface GrantsContextValue {
  /** user_id -> dashboard key -> active grant row id */
  grants: Record<string, Record<string, string>>;
  loading: boolean;
  setGrant: (userId: string, dashboard: string, rowId: string) => void;
  clearGrant: (userId: string, dashboard: string) => void;
}

const GrantsContext = createContext<GrantsContextValue | null>(null);

/**
 * Loads every ACTIVE grant for the listed users in ONE query and shares it
 * with all cards below. Cards never query on their own; ticks mutate this
 * local map optimistically instead of triggering a refetch.
 */
export function DashboardGrantsProvider({
  userIds,
  children,
}: {
  userIds: string[];
  children: ReactNode;
}) {
  const [grants, setGrants] = useState<Record<string, Record<string, string>>>({});
  const [loading, setLoading] = useState(false);
  const key = useMemo(() => userIds.slice().sort().join(','), [userIds]);

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) {
      setGrants({});
      return;
    }
    setLoading(true);
    supabase
      .from('staff_permissions')
      .select('id, user_id, permitted_dashboard')
      .in('user_id', ids)
      .is('revoked_at', null)
      .then(({ data }) => {
        if (cancelled) return;
        const next: Record<string, Record<string, string>> = {};
        ((data || []) as ActiveGrant[]).forEach((g) => {
          next[g.user_id] = next[g.user_id] || {};
          next[g.user_id][g.permitted_dashboard] = g.id;
        });
        setGrants(next);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const setGrant = useCallback((userId: string, dashboard: string, rowId: string) => {
    setGrants((prev) => ({
      ...prev,
      [userId]: { ...(prev[userId] || {}), [dashboard]: rowId },
    }));
  }, []);

  const clearGrant = useCallback((userId: string, dashboard: string) => {
    setGrants((prev) => {
      const forUser = { ...(prev[userId] || {}) };
      delete forUser[dashboard];
      return { ...prev, [userId]: forUser };
    });
  }, []);

  const value = useMemo(
    () => ({ grants, loading, setGrant, clearGrant }),
    [grants, loading, setGrant, clearGrant],
  );

  return <GrantsContext.Provider value={value}>{children}</GrantsContext.Provider>;
}

function useGrantsContext() {
  const ctx = useContext(GrantsContext);
  if (!ctx) throw new Error('DashboardGrants must be used inside DashboardGrantsProvider');
  return ctx;
}

/**
 * The 14 dashboards as checkboxes for one user. Ticked = active grant.
 * Ticking inserts a row; unticking revokes the active row (never deletes it).
 */
export function DashboardGrants({
  userId,
  actorId,
  disabled = false,
}: {
  userId: string;
  actorId: string | null;
  disabled?: boolean;
}) {
  const { grants, setGrant, clearGrant } = useGrantsContext();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const held = grants[userId] || {};
  const count = DASHBOARD_KEYS.filter((k) => !!held[k]).length;

  const toggle = async (dashboard: DashboardKey) => {
    if (disabled || busy) return;
    const activeId = held[dashboard];
    setBusy(dashboard);
    try {
      if (activeId) {
        const { error } = await supabase
          .from('staff_permissions')
          .update({
            revoked_at: new Date().toISOString(),
            revoked_by: actorId,
            revoke_reason: reason.trim() || null,
          })
          .eq('id', activeId);
        if (error) throw error;
        clearGrant(userId, dashboard);
      } else {
        const { data, error } = await supabase
          .from('staff_permissions')
          .insert({
            user_id: userId,
            permitted_dashboard: dashboard,
            granted_by: actorId,
          })
          .select('id')
          .single();
        if (error) throw error;
        setGrant(userId, dashboard, data.id);
      }
    } catch (e: any) {
      toast({
        title: activeId ? 'Revoke failed' : 'Grant failed',
        description: e?.message || 'Unknown database error',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Dashboard access ({count})
      </div>
      {!disabled && (
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional, recorded when removing access)"
          className="mb-2 h-8 text-xs"
        />
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
        {DASHBOARD_KEYS.map((k) => {
          const checked = !!held[k];
          return (
            <label
              key={k}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm cursor-pointer hover:bg-muted/40"
            >
              <Checkbox
                checked={checked}
                disabled={disabled || busy === k}
                onCheckedChange={() => toggle(k)}
              />
              <span className={checked ? '' : 'text-muted-foreground'}>{k}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
