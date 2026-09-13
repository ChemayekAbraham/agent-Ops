import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ScrollText, Loader2, RefreshCw, Search, X, Bot, UserCheck, ShieldCheck,
  Ban, SkipForward, AlertTriangle, Mail,
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface DecisionRow {
  id: string;
  deposit_request_id: string | null;
  gmail_transaction_id: string | null;
  source: 'matcher' | 'poller' | 'approval';
  decision: string;
  reason: string | null;
  amount: number | null;
  actor_id: string | null;
  actor_email: string | null;
  metadata: any;
  created_at: string;
  actor_name?: string | null;
}

const fmtUgx = (n: number | null | undefined) =>
  n == null ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

const decisionStyle = (decision: string): { cls: string; icon: any } => {
  switch (decision) {
    case 'approved':
    case 'auto_credited':
      return { cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30', icon: ShieldCheck };
    case 'rejected':
      return { cls: 'bg-rose-500/15 text-rose-700 border-rose-500/30', icon: Ban };
    case 'blocked':
      return { cls: 'bg-orange-500/15 text-orange-700 border-orange-500/30', icon: AlertTriangle };
    case 'failed':
      return { cls: 'bg-red-500/15 text-red-700 border-red-500/30', icon: AlertTriangle };
    case 'skipped':
      return { cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30', icon: SkipForward };
    default:
      return { cls: 'bg-sky-500/15 text-sky-700 border-sky-500/30', icon: Mail };
  }
};

const sourceLabel: Record<DecisionRow['source'], string> = {
  matcher: 'Matcher',
  poller: 'Poller',
  approval: 'Approval',
};

/**
 * Regulator-safe audit trail for every automated deposit matcher/poller
 * decision and every approval rejection/block — with the exact reason
 * (e.g. cash_code_required, auto_approve_unverified) for each attempt.
 * Read-only; restricted to oversight roles by RLS.
 */
export function DepositDecisionAuditPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<'all' | DecisionRow['source']>('all');
  const [decisionFilter, setDecisionFilter] = useState<'all' | string>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const { data, error } = await (supabase.from('deposit_decision_audit') as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(400);
      if (error) throw error;
      const audit: DecisionRow[] = (data as DecisionRow[]) ?? [];
      const actorIds = Array.from(new Set(audit.map((r) => r.actor_id).filter(Boolean))) as string[];
      const pmap = new Map<string, string>();
      if (actorIds.length) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name, email').in('id', actorIds);
        (profs ?? []).forEach((p: any) => pmap.set(p.id, p.full_name ?? p.email ?? p.id.slice(0, 8)));
      }
      setRows(audit.map((r) => ({ ...r, actor_name: r.actor_id ? (pmap.get(r.actor_id) ?? r.actor_email ?? null) : null })));
    } catch (e: any) {
      if (!silent) toast({ title: 'Failed to load decision audit', description: e?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const ch = supabase
      .channel('deposit-decision-audit-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'deposit_decision_audit' }, () => {
        load(true);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const decisions = useMemo(() => {
    return Array.from(new Set(rows.map((r) => r.decision))).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      if (decisionFilter !== 'all' && r.decision !== decisionFilter) return false;
      if (!q) return true;
      return (
        r.deposit_request_id?.toLowerCase().includes(q)
        || r.gmail_transaction_id?.toLowerCase().includes(q)
        || r.reason?.toLowerCase().includes(q)
        || r.decision?.toLowerCase().includes(q)
        || r.actor_name?.toLowerCase().includes(q)
        || r.actor_email?.toLowerCase().includes(q)
        || JSON.stringify(r.metadata ?? {}).toLowerCase().includes(q)
      );
    });
  }, [rows, sourceFilter, decisionFilter, search]);

  const sourceCounts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    rows.forEach((r) => { c[r.source] = (c[r.source] ?? 0) + 1; });
    return c;
  }, [rows]);

  const exportCsv = () => {
    const header = ['timestamp', 'source', 'decision', 'reason', 'amount', 'deposit_request_id', 'gmail_transaction_id', 'actor', 'metadata'];
    const escape = (v: any) => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      header.join(','),
      ...filtered.map((r) => [
        r.created_at, r.source, r.decision, r.reason ?? '', r.amount ?? '',
        r.deposit_request_id ?? '', r.gmail_transaction_id ?? '',
        r.actor_name ?? r.actor_email ?? (r.actor_id ?? 'system'),
        r.metadata ? JSON.stringify(r.metadata) : '',
      ].map(escape).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `deposit-decision-audit-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of many deposit-decision audit rows at once, not logged
    // before this. Plain client-side insert so the audit_logs IP-capture
    // trigger sees the real browser IP directly. Never blocks the actual
    // download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'deposit_decision_audit',
          record_id: null,
          metadata: { filename, row_count: filtered.length },
        });
      } catch (e) {
        console.warn('[DepositDecisionAuditPanel] audit log insert failed:', e);
      }
    })();
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b bg-gradient-to-r from-slate-500/5 to-transparent flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-sm sm:text-base flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-primary" />
              Deposit decision audit
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every matcher/poller decision and every approval block or rejection — with the exact reason for each deposit attempt.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
              Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="gap-2">
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(['all', 'matcher', 'poller', 'approval'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSourceFilter(k)}
              className={cn(
                'text-[11px] px-2 py-1 rounded-md border transition-colors',
                sourceFilter === k ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border'
              )}
            >
              {k === 'all' ? 'All sources' : sourceLabel[k]}
              <span className="ml-1 opacity-70">({sourceCounts[k] ?? 0})</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setDecisionFilter('all')}
            className={cn(
              'text-[11px] px-2 py-1 rounded-md border transition-colors',
              decisionFilter === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border'
            )}
          >
            All decisions
          </button>
          {decisions.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDecisionFilter(d)}
              className={cn(
                'text-[11px] px-2 py-1 rounded-md border transition-colors capitalize',
                decisionFilter === d ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border'
              )}
            >
              {d.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by deposit ID, reason (e.g. cash_code_required), actor…"
            className="pl-7 h-9 text-xs"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Loading decision audit…
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          <ScrollText className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
          No decisions match the current filters yet.
        </div>
      ) : (
        <ul className="divide-y max-h-[640px] overflow-y-auto">
          {filtered.map((r) => {
            const cfg = decisionStyle(r.decision);
            const Icon = cfg.icon;
            const isSystem = !r.actor_id || r.actor_email === 'system_auto_credit';
            return (
              <li key={r.id} className="p-3 text-xs space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn('gap-1 text-[10px] capitalize', cfg.cls)}>
                    <Icon className="h-3 w-3" /> {r.decision.replace(/_/g, ' ')}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">{sourceLabel[r.source]}</Badge>
                  {r.reason && (
                    <Badge variant="outline" className="text-[10px] font-mono">{r.reason}</Badge>
                  )}
                  {r.amount != null && (
                    <span className="font-semibold">{fmtUgx(r.amount)}</span>
                  )}
                  <span className="text-muted-foreground ml-auto">
                    {format(new Date(r.created_at), 'dd MMM yyyy HH:mm:ss')}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-muted-foreground">
                  {isSystem ? (
                    <><Bot className="h-3 w-3" /> <span>System (automated)</span></>
                  ) : (
                    <><UserCheck className="h-3 w-3" /> <span className="text-foreground font-medium">{r.actor_name ?? r.actor_email ?? r.actor_id?.slice(0, 8)}</span></>
                  )}
                </div>

                <div className="font-mono text-[10px] text-muted-foreground space-y-0.5">
                  {r.deposit_request_id && <div>deposit: {r.deposit_request_id}</div>}
                  {r.gmail_transaction_id && <div>email: {r.gmail_transaction_id}</div>}
                </div>

                {r.metadata && Object.keys(r.metadata).length > 0 && (
                  <details className="text-[10px] text-muted-foreground">
                    <summary className="cursor-pointer select-none hover:text-foreground">details</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all bg-muted/40 rounded p-2">
                      {JSON.stringify(r.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}