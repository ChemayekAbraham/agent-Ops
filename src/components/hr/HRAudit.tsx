import { Fragment, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';

/** The only action types this register surfaces: people & access events. */
const AUDIT_ACTION_TYPES = [
  'staff_role_enabled',
  'staff_role_disabled',
  'permission_granted',
  'permission_revoked',
  'role_assigned',
  'role_disabled',
  'role_removed',
  'forced_default_role_set',
  'staff_password_reset',
  'staff_password_provisioned',
  'staff_password_changed',
  'staff_password_revert',
  'cto_temp_password_issued',
  'forced_password_reset_completed',
  'delete_account',
  'archive_account',
  'admin_user_deletion',
  'account_deletion',
  'hr_department_created',
  'hr_disciplinary_issued',
] as const;

const ROLE_ACTIONS = [
  'staff_role_enabled', 'staff_role_disabled', 'role_assigned',
  'role_disabled', 'role_removed', 'forced_default_role_set',
];
const GRANT_ACTIONS = ['permission_granted', 'permission_revoked'];
const PASSWORD_ACTIONS = [
  'staff_password_reset', 'staff_password_provisioned', 'staff_password_changed',
  'staff_password_revert', 'cto_temp_password_issued', 'forced_password_reset_completed',
];
const ACCOUNT_ACTIONS = [
  'delete_account', 'archive_account', 'admin_user_deletion', 'account_deletion',
];

const ACTION_GROUPS: Record<string, string[]> = {
  all: AUDIT_ACTION_TYPES as unknown as string[],
  roles: ROLE_ACTIONS,
  grants: GRANT_ACTIONS,
  passwords: PASSWORD_ACTIONS,
  accounts: ACCOUNT_ACTIONS,
};

const RANGE_DAYS: Record<string, number> = { '30': 30, '90': 90, '365': 365 };

const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const selectClass =
  'h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground';

const DASH = '—';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display fallback when an id has no matching profile. */
const shortId = (id: string) => `${id.slice(0, 8)}…`;

interface AuditRow {
  id: string;
  created_at: string | null;
  user_id: string | null;
  action_type: string | null;
  table_name: string | null;
  record_id: string | null;
  metadata: Record<string, unknown> | null;
}

const readable = (value?: string | null) => {
  if (!value) return DASH;
  const words = value.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const shortWhen = (iso?: string | null) => {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
};

const text = (value: unknown) => {
  if (value === null || value === undefined || value === '') return DASH;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export default function HRAudit() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<'30' | '90' | '365'>('90');
  const [group, setGroup] = useState<'all' | 'roles' | 'grants' | 'passwords' | 'accounts'>('all');
  const [search, setSearch] = useState('');

  // Bounded window (default 90 days) — audit_logs holds 250k+ rows and must
  // never be read unfiltered.
  const sinceIso = useMemo(
    () => daysAgoIso(RANGE_DAYS[range] ?? 90),
    [range],
  );

  // Count-only queries (head: true) — never fetch rows to compute a figure.
  const { data: figures } = useQuery({
    queryKey: ['hr-people-access-audit-figures'],
    queryFn: async () => {
      const since30 = daysAgoIso(30);
      const countFor = async (actions: string[]) => {
        const { count, error } = await supabase
          .from('audit_logs')
          .select('id', { count: 'exact', head: true })
          .in('action_type', actions)
          .gte('created_at', since30);
        if (error) throw error;
        return count ?? 0;
      };
      const [roles, grants, passwords, accounts] = await Promise.all([
        countFor(ROLE_ACTIONS),
        countFor(GRANT_ACTIONS),
        countFor(PASSWORD_ACTIONS),
        countFor(ACCOUNT_ACTIONS),
      ]);
      return { roles, grants, passwords, accounts };
    },
  });

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['hr-people-access-audit', range, group],
    queryFn: async (): Promise<AuditRow[]> => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, created_at, user_id, action_type, table_name, record_id, metadata')
        .in('action_type', ACTION_GROUPS[group])
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []) as AuditRow[];
    },
  });

  const visibleLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(l => (l.user_id || '').toLowerCase().includes(q));
  }, [logs, search]);

  // Distinct, deduplicated ids referenced by the loaded rows (actors + targets).
  const profileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const l of logs) {
      if (l.user_id && UUID_RE.test(l.user_id)) ids.add(l.user_id);
      if (l.record_id && UUID_RE.test(l.record_id)) ids.add(l.record_id);
    }
    return Array.from(ids);
  }, [logs]);

  // Display-only name resolution. profiles holds 200k+ rows with per-row
  // security: it is read in exactly this one place and only with an .in filter.
  const { data: nameMap } = useQuery({
    queryKey: ['hr-people-access-audit-names', profileIds],
    enabled: profileIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', profileIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const p of data || []) {
        if (p.id && p.full_name) map[p.id] = p.full_name;
      }
      return map;
    },
  });

  const nameFor = (id?: string | null) => {
    if (!id) return DASH;
    return nameMap?.[id] || shortId(id);
  };

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-foreground">People &amp; Access Audit Register</h2>

      <div className="flex items-baseline gap-6 text-sm">
        <div className="leading-tight">
          <div className="text-base font-semibold tabular-nums">{figures?.roles ?? 0}</div>
          <div className="text-xs text-muted-foreground">Role changes</div>
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold tabular-nums">{figures?.grants ?? 0}</div>
          <div className="text-xs text-muted-foreground">Grant changes</div>
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold tabular-nums">{figures?.passwords ?? 0}</div>
          <div className="text-xs text-muted-foreground">Password events</div>
        </div>
        <div className="leading-tight">
          <div className="text-base font-semibold tabular-nums">{figures?.accounts ?? 0}</div>
          <div className="text-xs text-muted-foreground">Account removals</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Date range"
          className={selectClass}
          value={range}
          onChange={e => setRange(e.target.value as typeof range)}
        >
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last 12 months</option>
        </select>
        <select
          aria-label="Action group"
          className={selectClass}
          value={group}
          onChange={e => setGroup(e.target.value as typeof group)}
        >
          <option value="all">All</option>
          <option value="roles">Roles</option>
          <option value="grants">Grants</option>
          <option value="passwords">Passwords</option>
          <option value="accounts">Accounts</option>
        </select>
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search acting user"
          className="h-8 w-56 text-xs"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : visibleLogs.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No people or access events in the selected window
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">When</TableHead>
                <TableHead className="whitespace-nowrap">Who acted</TableHead>
                <TableHead className="whitespace-nowrap">Action</TableHead>
                <TableHead className="whitespace-nowrap">Target</TableHead>
                <TableHead className="whitespace-nowrap">Surface</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleLogs.map(log => {
                const isOpen = expanded.has(log.id);
                const meta = (log.metadata && typeof log.metadata === 'object')
                  ? log.metadata as Record<string, unknown>
                  : {};
                const detailEntries = Object.entries(meta);
                return (
                  <Fragment key={log.id}>
                    <TableRow
                      onClick={() => toggle(log.id)}
                      aria-expanded={isOpen}
                      className="cursor-pointer"
                    >
                      <TableCell className="text-xs whitespace-nowrap">{shortWhen(log.created_at)}</TableCell>
                      <TableCell className="text-xs">{nameFor(log.user_id)}</TableCell>
                      <TableCell className="text-xs">{readable(log.action_type)}</TableCell>
                      <TableCell className="text-xs">{nameFor(log.record_id)}</TableCell>
                      <TableCell className="text-xs">{readable(log.table_name)}</TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={5} className="text-xs">
                          <div className="space-y-1">
                            <p className="break-words">
                              <span className="text-muted-foreground">Acting user id: </span>
                              <span className="font-mono">{text(log.user_id)}</span>
                            </p>
                            <p className="break-words">
                              <span className="text-muted-foreground">Target record id: </span>
                              <span className="font-mono">{text(log.record_id)}</span>
                            </p>
                          </div>
                          {detailEntries.length === 0 ? (
                            <p className="text-muted-foreground">No further details recorded</p>
                          ) : (
                            <div className="space-y-1">
                              {detailEntries.map(([key, value]) => (
                                <p key={key} className="break-words">
                                  <span className="text-muted-foreground">{readable(key)}: </span>
                                  <span>{text(value)}</span>
                                </p>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Application actions only. Database schema changes are not recorded here.
      </p>
    </div>
  );
}
